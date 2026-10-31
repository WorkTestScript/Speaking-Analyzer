"""Local CPU server for phoneme inference on older browsers."""

import json
import os
import struct
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort


MODEL_ID = "robg/speako-phoneme-recognizer"
BASE_URL = "https://huggingface.co/{}/resolve/main/{}".format(MODEL_ID, "{}")
PORT = 8765
APP_ORIGIN_SUFFIX = ".github.io"
MODEL_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "SpeakingAnalyzer" / "phoneme-model"


def download_file(url, destination):
    if destination.exists() and destination.stat().st_size > 0:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".download")
    print("Downloading {}...".format(destination.name), flush=True)
    request = urllib.request.Request(url, headers={"User-Agent": "SpeakingAnalyzer-local-server"})
    with urllib.request.urlopen(request, timeout=60) as response, open(str(temporary), "wb") as output:
        total = int(response.headers.get("Content-Length", "0") or "0")
        received = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
            received += len(chunk)
            if total:
                print("\r{} / {} MB".format(received // (1024 * 1024), total // (1024 * 1024)), end="", flush=True)
    temporary.replace(destination)
    print("\nDownloaded {}".format(destination.name), flush=True)


def load_model():
    model_path = MODEL_DIR / "model_quantized.onnx"
    config_path = MODEL_DIR / "config.json"
    preprocessor_path = MODEL_DIR / "preprocessor_config.json"
    tokenizer_path = MODEL_DIR / "tokenizer.json"
    for filename, path in (("onnx/model_quantized.onnx", model_path), ("config.json", config_path),
                           ("preprocessor_config.json", preprocessor_path), ("tokenizer.json", tokenizer_path)):
        download_file(BASE_URL.format(filename), path)

    with open(str(config_path), "r", encoding="utf-8") as source:
        config = json.load(source)
    with open(str(preprocessor_path), "r", encoding="utf-8") as source:
        preprocessor = json.load(source)
    with open(str(tokenizer_path), "r", encoding="utf-8") as source:
        tokenizer = json.load(source)

    # Disable ORT's large default thread pool on older machines.
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(2, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
    vocab = tokenizer.get("model", {}).get("vocab", {})
    if not vocab:
        raise RuntimeError("The model tokenizer does not contain a vocabulary.")
    id_to_token = [None] * (max(vocab.values()) + 1)
    for token, token_id in vocab.items():
        if token_id < len(id_to_token):
            id_to_token[token_id] = token
    special_ids = {item.get("id") for item in tokenizer.get("added_tokens", []) if item.get("special")}
    blank_id = config.get("pad_token_id", 0)
    delimiter = config.get("word_delimiter_token", "|")
    return session, id_to_token, special_ids, blank_id, delimiter, bool(preprocessor.get("do_normalize", True))


class ModelState(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.session = None
        self.error = None
        try:
            self.session, self.id_to_token, self.special_ids, self.blank_id, self.delimiter, self.normalize = load_model()
            print("Phoneme model is ready.", flush=True)
        except Exception as error:
            self.error = "{}: {}".format(type(error).__name__, error)
            print("Could not load phoneme model: {}".format(self.error), file=sys.stderr, flush=True)

    def recognize(self, audio):
        if self.session is None:
            raise RuntimeError(self.error or "Model is not ready.")
        if self.normalize and audio.size:
            audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
        inputs = {}
        for item in self.session.get_inputs():
            if item.name == "input_values":
                inputs[item.name] = audio.reshape(1, -1)
            elif item.name == "attention_mask":
                inputs[item.name] = np.ones((1, audio.size), dtype=np.int64)
            else:
                raise RuntimeError("Unsupported model input: {}".format(item.name))
        with self.lock:
            logits = self.session.run(None, inputs)[0][0]
        best_ids = np.argmax(logits, axis=-1)
        output = []
        previous = None
        for token_id in best_ids:
            token_id = int(token_id)
            if token_id != previous and token_id != self.blank_id and token_id not in self.special_ids:
                token = self.id_to_token[token_id] if token_id < len(self.id_to_token) else None
                if token:
                    output.append(" " if token == self.delimiter else token)
            previous = token_id
        return "".join(output).strip()


STATE = ModelState()


class Handler(BaseHTTPRequestHandler):
    server_version = "SpeakingAnalyzerLocal/0.1"

    def _cors(self):
        origin = self.headers.get("Origin", "")
        is_allowed = origin in ("http://localhost", "http://127.0.0.1") or (
            origin.startswith("https://") and origin.endswith(APP_ORIGIN_SUFFIX)
        )
        if is_allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path != "/health":
            self._send_json(404, {"error": "Not found"})
            return
        self._send_json(200, {"ready": STATE.session is not None, "error": STATE.error})

    def do_POST(self):
        if self.path != "/recognize":
            self._send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 8 or length > 64 * 1024 * 1024:
                raise ValueError("Invalid audio request size.")
            body = self.rfile.read(length)
            count = struct.unpack_from("<I", body, 0)[0]
            if count != 1:
                raise ValueError("This endpoint expects exactly one audio segment.")
            sample_count = struct.unpack_from("<I", body, 4)[0]
            expected = 8 + sample_count * 4
            if sample_count < 1 or expected != len(body):
                raise ValueError("Audio segment data is incomplete.")
            audio = np.frombuffer(body, dtype="<f4", count=sample_count, offset=8).astype(np.float32, copy=False)
            self._send_json(200, {"text": STATE.recognize(audio)})
        except Exception as error:
            self._send_json(400, {"error": "{}: {}".format(type(error).__name__, error)})

    def log_message(self, format_string, *args):
        print("{} - {}".format(self.address_string(), format_string % args), flush=True)


if __name__ == "__main__":
    if sys.version_info[:2] != (3, 8):
        print("Use 32-bit Python 3.8 on this Windows 7 computer.", file=sys.stderr)
        sys.exit(1)
    print("Local phoneme server: http://127.0.0.1:{}".format(PORT), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
