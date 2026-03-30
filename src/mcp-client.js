"use strict";

const crypto = require("crypto");

class McpHttpClient {
  constructor({
    baseUrl,
    timeoutMs = 15000,
    output = null,
    correlation = {},
    requestIdFactory = null,
    telemetry = null
  }) {
    this.baseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 15000;
    this.output = output;
    this.sessionId = "";
    this.initialized = false;
    this.correlation = {
      chatSessionId: String(correlation.chatSessionId || "").trim(),
      turnId: String(correlation.turnId || "").trim()
    };
    this.requestIdFactory =
      typeof requestIdFactory === "function" ? requestIdFactory : null;
    this.telemetry = telemetry;
  }

  _log(message) {
    if (this.output && typeof this.output.appendLine === "function") {
      this.output.appendLine(`[joshgpt:mcp] ${message}`);
    }
  }

  _parseMcpBody(rawBody) {
    const text = String(rawBody || "").trim();
    if (!text) {
      throw new Error("MCP response body is empty.");
    }

    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }

    const dataLines = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }

    if (!dataLines.length) {
      throw new Error(`Unexpected MCP response format: ${trimmed.slice(0, 200)}`);
    }

    for (let i = dataLines.length - 1; i >= 0; i -= 1) {
      const candidate = dataLines[i];
      if (!candidate) {
        continue;
      }
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }

    throw new Error("Unable to parse MCP JSON payload from response.");
  }

  _nextRequestId() {
    if (this.requestIdFactory) {
      try {
        const value = String(this.requestIdFactory() || "").trim();
        if (value) {
          return value;
        }
      } catch {
        // Fall back to generated request ID.
      }
    }
    return `req-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }

  _buildCorrelationHeaders({ requestId = "", toolCallId = "" } = {}) {
    const headers = {};
    if (this.correlation.chatSessionId) {
      headers["x-chat-session-id"] = this.correlation.chatSessionId;
    }
    if (this.correlation.turnId) {
      headers["x-turn-id"] = this.correlation.turnId;
    }
    if (requestId) {
      headers["x-request-id"] = requestId;
    }
    if (toolCallId) {
      headers["x-tool-call-id"] = String(toolCallId);
    }
    return headers;
  }

  _emitTelemetry(event, payload = {}) {
    if (!this.telemetry || typeof this.telemetry.log !== "function") {
      return;
    }
    this.telemetry.log({
      event: `mcp.${event}`,
      message: String(payload.message || `MCP ${event}`),
      chat_session_id: this.correlation.chatSessionId || "unknown",
      turn_id: this.correlation.turnId || "unknown",
      request_id: String(payload.request_id || ""),
      tool_call_id: String(payload.tool_call_id || ""),
      component: "mcp-client",
      operation: String(payload.operation || ""),
      status: String(payload.status || ""),
      endpoint: this.baseUrl,
      attrs: payload.attrs && typeof payload.attrs === "object" ? payload.attrs : {}
    });
  }

  async _post(
    payload,
    { allowWithoutSession = false, requestId = "", toolCallId = "" } = {}
  ) {
    if (!this.baseUrl) {
      throw new Error("joshgpt.mcp.baseUrl is empty.");
    }

    const resolvedRequestId = String(requestId || this._nextRequestId()).trim();
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this._buildCorrelationHeaders({
        requestId: resolvedRequestId,
        toolCallId: toolCallId || ""
      })
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    } else if (!allowWithoutSession) {
      throw new Error("MCP session is not initialized.");
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;

    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`MCP request timed out after ${this.timeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const body = await response.text();
    const returnedSessionId = response.headers.get("mcp-session-id");
    if (returnedSessionId) {
      this.sessionId = returnedSessionId;
    }

    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 400)}`);
    }

    const parsed = this._parseMcpBody(body);
    if (parsed && parsed.error) {
      const message = parsed.error.message || "Unknown MCP error";
      throw new Error(`MCP error: ${message}`);
    }
    return {
      parsed,
      requestId: resolvedRequestId
    };
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    const startedAt = Date.now();
    this._log(`initialize -> ${this.baseUrl}`);
    this._emitTelemetry("initialize.start", {
      message: "Initializing MCP session.",
      operation: "initialize",
      status: "start"
    });
    try {
      const initResult = await this._post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
              name: "joshgpt-vscode",
              version: "0.0.1"
            }
          }
        },
        { allowWithoutSession: true }
      );

      try {
        await this._post(
          {
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {}
          },
          { allowWithoutSession: false }
        );
      } catch {
        // Some servers ignore this notification path; keep compatibility.
      }

      this.initialized = true;
      this._emitTelemetry("initialize.complete", {
        message: "MCP session initialized.",
        operation: "initialize",
        status: "ok",
        request_id: initResult.requestId,
        attrs: {
          duration_ms: Math.max(0, Date.now() - startedAt)
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._emitTelemetry("initialize.error", {
        message: "MCP session initialization failed.",
        operation: "initialize",
        status: "error",
        attrs: {
          duration_ms: Math.max(0, Date.now() - startedAt),
          error: msg
        }
      });
      throw err;
    }
  }

  async listTools() {
    await this.initialize();
    const startedAt = Date.now();
    this._emitTelemetry("tools_list.start", {
      message: "Requesting MCP tools/list.",
      operation: "tools/list",
      status: "start"
    });
    try {
      const { parsed, requestId } = await this._post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      });
      const tools =
        parsed && parsed.result && Array.isArray(parsed.result.tools)
          ? parsed.result.tools
          : [];
      this._log(`tools/list -> ${tools.length} tool(s)`);
      this._emitTelemetry("tools_list.complete", {
        message: `MCP tools/list returned ${tools.length} tools.`,
        operation: "tools/list",
        status: "ok",
        request_id: requestId,
        attrs: {
          duration_ms: Math.max(0, Date.now() - startedAt),
          tool_count: tools.length
        }
      });
      return tools;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._emitTelemetry("tools_list.error", {
        message: "MCP tools/list failed.",
        operation: "tools/list",
        status: "error",
        attrs: {
          duration_ms: Math.max(0, Date.now() - startedAt),
          error: msg
        }
      });
      throw err;
    }
  }

  async callTool(name, args, { toolCallId = "", requestId = "" } = {}) {
    await this.initialize();
    this._log(`tools/call -> ${name}`);
    const startedAt = Date.now();
    const requestedRequestId = String(requestId || "").trim();
    this._emitTelemetry("tool_call.start", {
      message: `MCP tool call started: ${name}`,
      operation: "tools/call",
      status: "start",
      request_id: requestedRequestId,
      tool_call_id: String(toolCallId || ""),
      attrs: {
        tool_name: String(name || "")
      }
    });
    try {
      const { parsed, requestId } = await this._post(
        {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name,
            arguments: args || {}
          }
        },
        {
          toolCallId: String(toolCallId || ""),
          requestId: requestedRequestId
        }
      );
      this._emitTelemetry("tool_call.complete", {
        message: `MCP tool call completed: ${name}`,
        operation: "tools/call",
        status: "ok",
        request_id: requestId,
        tool_call_id: String(toolCallId || ""),
        attrs: {
          tool_name: String(name || ""),
          duration_ms: Math.max(0, Date.now() - startedAt)
        }
      });
      return parsed && parsed.result ? parsed.result : {};
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._emitTelemetry("tool_call.error", {
        message: `MCP tool call failed: ${name}`,
        operation: "tools/call",
        status: "error",
        request_id: requestedRequestId,
        tool_call_id: String(toolCallId || ""),
        attrs: {
          tool_name: String(name || ""),
          duration_ms: Math.max(0, Date.now() - startedAt),
          error: msg
        }
      });
      throw err;
    }
  }
}

module.exports = {
  McpHttpClient
};
