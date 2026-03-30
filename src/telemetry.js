"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE_NAME = "joshgpt-telemetry.ndjson";
const DEFAULT_MAX_FILE_SIZE_MB = 10;
const DEFAULT_MAX_FILES = 5;

function nowIso() {
  return new Date().toISOString();
}

function makeTelemetryId(prefix) {
  const base = String(prefix || "id").trim() || "id";
  return `${base}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function redactValue(value, keyName = "") {
  const key = String(keyName || "").toLowerCase();
  if (
    key.includes("token") ||
    key.includes("secret") ||
    key.includes("password") ||
    key.includes("authorization") ||
    key.includes("api_key") ||
    key.includes("apikey")
  ) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, keyName));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4000) {
    return `${value.slice(0, 4000)}...[truncated]`;
  }
  return value;
}

function buildCorrelationHeaders(correlation = {}) {
  const headers = {};
  const chatSessionId = String(correlation.chatSessionId || "").trim();
  const turnId = String(correlation.turnId || "").trim();
  const requestId = String(correlation.requestId || "").trim();
  const toolCallId = String(correlation.toolCallId || "").trim();

  if (chatSessionId) {
    headers["x-chat-session-id"] = chatSessionId;
  }
  if (turnId) {
    headers["x-turn-id"] = turnId;
  }
  if (requestId) {
    headers["x-request-id"] = requestId;
  }
  if (toolCallId) {
    headers["x-tool-call-id"] = toolCallId;
  }
  return headers;
}

class TelemetryWriter {
  constructor({
    enabled = true,
    workspaceRoot = process.cwd(),
    logDir = ".joshgpt/logs",
    includeContent = false,
    maxFileSizeMb = DEFAULT_MAX_FILE_SIZE_MB,
    maxFiles = DEFAULT_MAX_FILES
  } = {}) {
    this.enabled = Boolean(enabled);
    this.workspaceRoot = String(workspaceRoot || process.cwd());
    this.logDir = String(logDir || ".joshgpt/logs");
    this.includeContent = Boolean(includeContent);
    this.maxFileSizeBytes = asPositiveInt(maxFileSizeMb, DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024;
    this.maxFiles = asPositiveInt(maxFiles, DEFAULT_MAX_FILES);
    this.filePath = this._resolveFilePath();
  }

  _resolveFilePath() {
    const root = path.isAbsolute(this.logDir)
      ? this.logDir
      : path.join(this.workspaceRoot, this.logDir);
    return path.join(root, DEFAULT_FILE_NAME);
  }

  _rotateIfNeeded(extraBytes = 0) {
    try {
      const currentSize = fs.existsSync(this.filePath)
        ? fs.statSync(this.filePath).size
        : 0;
      if (currentSize + extraBytes <= this.maxFileSizeBytes) {
        return;
      }

      // Rotate newest -> oldest: .(n-1) -> .n, main -> .1
      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        const src = `${this.filePath}.${i}`;
        const dst = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(src)) {
          if (i + 1 > this.maxFiles) {
            fs.rmSync(src, { force: true });
          } else {
            fs.renameSync(src, dst);
          }
        }
      }
      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      // Rotation failures should not block prompt flow.
    }
  }

  _sanitizeEvent(event) {
    const raw = event && typeof event === "object" ? event : {};
    const attrs = raw.attrs && typeof raw.attrs === "object" ? { ...raw.attrs } : {};
    if (!this.includeContent) {
      delete attrs.prompt;
      delete attrs.response;
      delete attrs.content;
      delete attrs.arguments;
      delete attrs.payload;
      delete attrs.details;
    }

    const normalized = {
      timestamp: String(raw.timestamp || nowIso()),
      service: String(raw.service || "joshgpt-vscode"),
      level: String(raw.level || "info"),
      event: String(raw.event || "telemetry"),
      message: String(raw.message || raw.event || "telemetry"),
      chat_session_id: String(raw.chat_session_id || "unknown"),
      turn_id: String(raw.turn_id || "unknown"),
      request_id: String(raw.request_id || ""),
      tool_call_id: String(raw.tool_call_id || ""),
      component: String(raw.component || "vscode"),
      operation: String(raw.operation || ""),
      status: String(raw.status || ""),
      duration_ms:
        Number.isFinite(Number(raw.duration_ms)) ? Number(raw.duration_ms) : undefined,
      error_code: String(raw.error_code || ""),
      correlation_source: String(raw.correlation_source || ""),
      model: String(raw.model || ""),
      endpoint: String(raw.endpoint || ""),
      source_path: String(raw.source_path || ""),
      source: String(raw.source || "vscode"),
      env: String(raw.env || process.env.LOG_ENV || "local"),
      attrs: redactValue(attrs)
    };

    // Remove empty optional fields for cleaner lines.
    for (const [k, v] of Object.entries(normalized)) {
      if (
        v === undefined ||
        v === null ||
        v === "" ||
        (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
      ) {
        delete normalized[k];
      }
    }
    return normalized;
  }

  log(event) {
    if (!this.enabled) {
      return;
    }
    try {
      const normalized = this._sanitizeEvent(event);
      const line = `${JSON.stringify(normalized)}\n`;
      ensureDir(path.dirname(this.filePath));
      this._rotateIfNeeded(Buffer.byteLength(line, "utf8"));
      fs.appendFileSync(this.filePath, line, { encoding: "utf8" });
    } catch {
      // Telemetry errors are intentionally non-fatal.
    }
  }
}

function emitTraceTelemetry(writer, traceEvents, correlation = {}, defaults = {}) {
  if (!writer || typeof writer.log !== "function") {
    return;
  }
  const events = Array.isArray(traceEvents) ? traceEvents : [];
  for (const item of events) {
    const type = String(item && item.type ? item.type : "trace");
    const summary = String(item && item.summary ? item.summary : "");
    const details = String(item && item.details ? item.details : "");
    writer.log({
      timestamp: String(item && item.timestamp ? item.timestamp : nowIso()),
      level: type.includes("error") ? "error" : "info",
      event: `trace.${type}`,
      message: summary || `Trace event ${type}`,
      chat_session_id: String(correlation.chatSessionId || "unknown"),
      turn_id: String(correlation.turnId || "unknown"),
      component: String(defaults.component || "chat-runner"),
      operation: type,
      status: type.includes("error") ? "error" : "ok",
      model: String(defaults.model || ""),
      endpoint: String(defaults.endpoint || ""),
      attrs: {
        summary,
        details
      }
    });
  }
}

module.exports = {
  TelemetryWriter,
  makeTelemetryId,
  buildCorrelationHeaders,
  emitTraceTelemetry
};
