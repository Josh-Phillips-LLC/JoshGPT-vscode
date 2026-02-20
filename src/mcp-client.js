"use strict";

class McpHttpClient {
  constructor({ baseUrl, timeoutMs = 15000, output = null }) {
    this.baseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 15000;
    this.output = output;
    this.sessionId = "";
    this.initialized = false;
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

  async _post(payload, { allowWithoutSession = false } = {}) {
    if (!this.baseUrl) {
      throw new Error("joshgpt.mcp.baseUrl is empty.");
    }

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
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
    return parsed;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    this._log(`initialize -> ${this.baseUrl}`);
    await this._post(
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
  }

  async listTools() {
    await this.initialize();
    const response = await this._post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });
    const tools = response && response.result && Array.isArray(response.result.tools)
      ? response.result.tools
      : [];
    this._log(`tools/list -> ${tools.length} tool(s)`);
    return tools;
  }

  async callTool(name, args) {
    await this.initialize();
    this._log(`tools/call -> ${name}`);
    const response = await this._post({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name,
        arguments: args || {}
      }
    });
    return response && response.result ? response.result : {};
  }
}

module.exports = {
  McpHttpClient
};
