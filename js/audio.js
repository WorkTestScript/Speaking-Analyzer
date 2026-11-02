import { AppError, ErrorCode, ERROR_MESSAGES } from "./errors.js";
import { saveRecording, saveRecordingTranscript, listRecordings, getRecording, deleteRecording } from "./storage.js";

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  if (!window.MediaRecorder) return "";
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}
export function recordingSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export class AudioRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.mimeType = "";
    this.startedAt = 0;
    this.timer = null;
    this.durationMs = 0;
    this.audioContext = null;
    this.analyser = null;
    this.raf = 0;
    this.playback = null;
    this.current = null;
    this.onDuration = () => {};
    this.onState = () => {};
  }

  async start(text) {
    if (!recordingSupported()) {
      throw new AppError(ErrorCode.UNSUPPORTED, "MediaRecorder is not available in this browser.");
    }
    this.stopPlayback();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
        throw new AppError(ErrorCode.PERMISSION, ERROR_MESSAGES[ErrorCode.PERMISSION]);
      }
      throw new AppError(ErrorCode.UNSUPPORTED, "Could not access the microphone.");
    }
    this.mimeType = pickMimeType();
    const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.mimeType = this.mediaRecorder.mimeType || this.mimeType || "audio/webm";
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.chunks.push(event.data);
    };
    this.linkedText = text;
    this.startedAt = Date.now();
    this.durationMs = 0;
    this.mediaRecorder.start(200);
    this.timer = setInterval(() => {
      this.durationMs = Date.now() - this.startedAt;
      this.onDuration(this.durationMs);
    }, 200);
    this.onState({ recording: true });
  }

  async stop() {
    if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
      this.cleanupStream();
      return this.current;
    }
    const blob = await new Promise((resolve) => {
      this.mediaRecorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: this.mimeType }));
      };
      this.mediaRecorder.stop();
    });
    this.durationMs = Date.now() - this.startedAt;
    this.cleanupStream();
    const id = await saveRecording({
      blob,
      mimeType: this.mimeType,
      duration: this.durationMs,
      text: this.linkedText || "",
      transcript: "",
      createdAt: Date.now(),
    });
    this.current = {
      id,
      blob,
      mimeType: this.mimeType,
      duration: this.durationMs,
      text: this.linkedText || "",
      transcript: "",
      createdAt: Date.now(),
    };
    this.onState({ recording: false, saved: true });
    return this.current;
  }

  async load(id) {
    const row = await getRecording(id);
    if (!row) return null;
    this.current = {
      id: row.id,
      blob: row.blob,
      mimeType: row.mimeType,
      duration: row.duration,
      text: row.text,
      transcript: row.transcript || "",
      createdAt: row.createdAt,
      textFingerprint: row.textFingerprint,
    };
    return this.current;
  }

  async history() {
    return listRecordings();
  }

  async saveTranscript(transcript, recordingId = this.current?.id) {
    if (!recordingId) throw new Error("No recording is loaded.");
    const saved = await saveRecordingTranscript(recordingId, transcript);
    if (this.current?.id === recordingId) this.current.transcript = saved;
    return saved;
  }

  async remove(id) {
    await deleteRecording(id);
    if (this.current?.id === id) {
      this.stopPlayback();
      this.current = null;
    }
  }

  play() {
    if (!this.current?.blob) return;
    this.stopPlayback();
    const url = URL.createObjectURL(this.current.blob);
    const audio = new Audio(url);
    this.playback = { audio, url };
    audio.onended = () => {
      this.stopPlayback();
      this.onState({ playing: false });
    };
    audio.play();
    this.onState({ playing: true, paused: false });
  }

  pausePlayback() {
    if (!this.playback?.audio) return;
    this.playback.audio.pause();
    this.onState({ playing: false, paused: true });
  }

  resumePlayback() {
    this.playback?.audio?.play();
    this.onState({ playing: true, paused: false });
  }

  stopPlayback() {
    if (!this.playback) return;
    this.playback.audio.pause();
    this.playback.audio.src = "";
    URL.revokeObjectURL(this.playback.url);
    this.playback = null;
  }

  download() {
    if (!this.current?.blob) return;
    const ext = (this.current.mimeType || "").includes("mp4") ? "m4a" : (this.current.mimeType || "").includes("ogg") ? "ogg" : "webm";
    const url = URL.createObjectURL(this.current.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `recording-${this.current.id || "latest"}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  cleanupStream() {
    clearInterval(this.timer);
    this.timer = null;
    cancelAnimationFrame(this.raf);
    this.analyser = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.mediaRecorder = null;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.onState({ recording: false });
  }
}
