export class AppError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export const ErrorCode = {
  INVALID_API_KEY: "INVALID_API_KEY",
  RATE_LIMIT: "RATE_LIMIT",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  UNSUPPORTED_AUDIO: "UNSUPPORTED_AUDIO",
  VALIDATION: "VALIDATION",
  UNSUPPORTED: "UNSUPPORTED",
  PERMISSION: "PERMISSION",
  UNKNOWN: "UNKNOWN",
};

export const ERROR_MESSAGES = {
  [ErrorCode.INVALID_API_KEY]: "Invalid API key. Open Settings and check the key for the selected provider.",
  [ErrorCode.RATE_LIMIT]: "Rate limit reached. Wait a moment and try again.",
  [ErrorCode.QUOTA_EXCEEDED]: "API quota exceeded for this key.",
  [ErrorCode.NETWORK]: "Network error. Check your connection. Browser CORS may also block the provider.",
  [ErrorCode.TIMEOUT]: "The API request timed out.",
  [ErrorCode.UNSUPPORTED_AUDIO]: "This audio format is not supported by the selected provider.",
  [ErrorCode.VALIDATION]: "The AI response was invalid and was not displayed.",
  [ErrorCode.UNSUPPORTED]: "This feature is not supported in this browser.",
  [ErrorCode.PERMISSION]: "Access was denied by the provider. Check API key permissions or model availability.",
  [ErrorCode.UNKNOWN]: "Something went wrong.",
};

export function messageFor(error) {
  if (error instanceof AppError) {
    return error.message || ERROR_MESSAGES[error.code] || ERROR_MESSAGES[ErrorCode.UNKNOWN];
  }
  return error?.message || ERROR_MESSAGES[ErrorCode.UNKNOWN];
}

export function classifyHttpError(status, bodyText = "") {
  const text = String(bodyText).toLowerCase();
  if (status === 401 || text.includes("api key not valid") || text.includes("invalid api key") || text.includes("unauthenticated") || text.includes("incorrect api key")) {
    return ErrorCode.INVALID_API_KEY;
  }
  if (status === 403) return ErrorCode.PERMISSION;
  if (status === 429 || text.includes("rate limit") || text.includes("resource_exhausted") || text.includes("too many requests")) {
    if (text.includes("quota") || text.includes("exceeded your current quota")) {
      return ErrorCode.QUOTA_EXCEEDED;
    }
    return ErrorCode.RATE_LIMIT;
  }
  if (text.includes("quota") || text.includes("billing") && text.includes("exceed")) {
    return ErrorCode.QUOTA_EXCEEDED;
  }
  if (status === 400 && (text.includes("audio") || text.includes("mime") || text.includes("unsupported") || text.includes("format"))) {
    return ErrorCode.UNSUPPORTED_AUDIO;
  }
  return ErrorCode.UNKNOWN;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.TIMEOUT, ERROR_MESSAGES[ErrorCode.TIMEOUT]);
    }
    throw new AppError(ErrorCode.NETWORK, ERROR_MESSAGES[ErrorCode.NETWORK], error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function readErrorBody(response) {
  try {
    const data = await response.json();
    return JSON.stringify(data);
  } catch {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
}
