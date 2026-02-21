"use strict";

const vscode = require("vscode");
const { SessionStore } = require("./session-store");
const { runChatWithOptionalMcp } = require("./chat-runner");

const SETTINGS_EXTENSION_ID = "josh-phillips-llc.joshgpt";
const SETTINGS_FIELDS = [
  { key: "baseUrl", type: "string" },
  { key: "nativeBaseUrl", type: "string" },
  { key: "chatEndpointMode", type: "enum", enum: ["openai-compat", "lmstudio-native-stream"] },
  { key: "model", type: "string" },
  { key: "apiKey", type: "string" },
  { key: "systemPrompt", type: "string" },
  { key: "temperature", type: "number", min: 0, max: 2 },
  { key: "maxTokens", type: "number", min: 1 },
  { key: "mcp.enabled", type: "boolean" },
  { key: "mcp.baseUrl", type: "string" },
  { key: "mcp.timeoutMs", type: "number", min: 1000 },
  { key: "mcp.maxToolRounds", type: "number", min: 1, max: 12 },
  { key: "localShell.enabled", type: "boolean" },
  { key: "localShell.defaultTimeoutSeconds", type: "number", min: 1 },
  { key: "localShell.maxTimeoutSeconds", type: "number", min: 1 },
  { key: "localShell.defaultMaxOutputChars", type: "number", min: 256 },
  { key: "localShell.maxOutputChars", type: "number", min: 256 },
  { key: "localShell.mirrorTerminalEnabled", type: "boolean" },
  { key: "localShell.mirrorTerminalName", type: "string" },
  { key: "localShell.mirrorTerminalReveal", type: "boolean" }
];

function makeNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 24; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function _coerceBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const lowered = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(lowered)) {
    return false;
  }
  return Boolean(value);
}

function _clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number value: ${value}`);
  }
  let result = parsed;
  if (typeof min === "number") {
    result = Math.max(result, min);
  }
  if (typeof max === "number") {
    result = Math.min(result, max);
  }
  return result;
}

class JoshGptSessionViewProvider {
  static viewType = "joshgpt.sessions";

  constructor(extensionContext, output, getConfig) {
    this.context = extensionContext;
    this.output = output;
    this.getConfig = getConfig;
    this.store = new SessionStore(extensionContext);
    this.view = null;
    this.busy = false;
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        await this._handleMessage(message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[joshgpt] session view error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = null;
      }
    });
  }

  async createSessionFromCommand() {
    await this.store.createSession();
    await this._postState();
  }

  _settingsConfig() {
    return vscode.workspace.getConfiguration("joshgpt");
  }

  _hasWorkspace() {
    return Boolean((vscode.workspace.workspaceFolders || []).length > 0);
  }

  _serializeSettings() {
    const cfg = this._settingsConfig();
    const values = {};
    for (const field of SETTINGS_FIELDS) {
      values[field.key] = cfg.get(field.key);
    }
    return {
      fields: SETTINGS_FIELDS,
      values,
      signature: JSON.stringify(values),
      hasWorkspace: this._hasWorkspace()
    };
  }

  async _saveSettings(rawValues, rawScope) {
    const target = rawScope === "workspace" && this._hasWorkspace()
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    const cfg = this._settingsConfig();

    for (const field of SETTINGS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(rawValues || {}, field.key)) {
        continue;
      }

      let nextValue = rawValues[field.key];
      if (field.type === "number") {
        nextValue = _clampNumber(nextValue, field.min, field.max);
      } else if (field.type === "boolean") {
        nextValue = _coerceBoolean(nextValue);
      } else if (field.type === "enum") {
        const normalized = String(nextValue || "").trim();
        if (!field.enum.includes(normalized)) {
          throw new Error(
            `Invalid value for ${field.key}. Expected one of: ${field.enum.join(", ")}`
          );
        }
        nextValue = normalized;
      } else {
        nextValue = String(nextValue || "").trim();
      }

      await cfg.update(field.key, nextValue, target);
    }
  }

  async _handleMessage(message) {
    const type = message && message.type;

    if (type === "ready") {
      await this._postState();
      return;
    }

    if (type === "createSession") {
      await this.store.createSession();
      await this._postState();
      return;
    }

    if (type === "selectSession") {
      const sessionId = String(message.sessionId || "");
      if (sessionId) {
        await this.store.setActiveSession(sessionId);
        await this._postState();
      }
      return;
    }

    if (type === "deleteSession") {
      const sessionId = String(message.sessionId || "");
      if (sessionId) {
        await this.store.deleteSession(sessionId);
        await this._postState();
      }
      return;
    }

    if (type === "clearTrace") {
      const sessionId = String(message.sessionId || "");
      if (sessionId) {
        await this.store.clearTraceEvents(sessionId);
        await this._postState();
      }
      return;
    }

    if (type === "sendPrompt") {
      const prompt = String((message && message.prompt) || "").trim();
      if (!prompt) {
        return;
      }
      await this._sendPrompt(prompt);
      return;
    }

    if (type === "reloadSettings") {
      await this._postState();
      return;
    }

    if (type === "saveSettings") {
      const values = (message && message.values) || {};
      const scope = String((message && message.scope) || "user").trim().toLowerCase();
      await this._saveSettings(values, scope);
      await this._postState();
      return;
    }

    if (type === "openSettingsUi") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${SETTINGS_EXTENSION_ID}`
      );
      return;
    }
  }

  async _sendPrompt(prompt) {
    if (this.busy) {
      return;
    }

    const activeSession = await this.store.ensureActiveSession();
    await this.store.appendMessage(activeSession.id, "user", prompt);

    this.busy = true;
    await this._postState();

    try {
      const cfg = this.getConfig();
      if (!cfg.baseUrl) {
        throw new Error("joshgpt.baseUrl is empty.");
      }
      if (!cfg.model) {
        throw new Error("joshgpt.model is empty.");
      }

      const latestSession = this.store.getSessionById(activeSession.id);
      if (!latestSession) {
        throw new Error("Active session disappeared before completion.");
      }

      const modelMessages = [];
      if (cfg.systemPrompt) {
        modelMessages.push({ role: "system", content: cfg.systemPrompt });
      }
      for (const item of latestSession.messages) {
        modelMessages.push({
          role: item.role,
          content: item.content
        });
      }

      this.output.appendLine(
        `[joshgpt] session completion request model=${cfg.model} messages=${modelMessages.length}`
      );

      const { text, trace } = await runChatWithOptionalMcp({
        config: cfg,
        messages: modelMessages,
        output: this.output
      });

      await this.store.appendMessage(activeSession.id, "assistant", text);
      await this.store.appendTraceEvents(activeSession.id, trace);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.store.appendMessage(
        activeSession.id,
        "assistant",
        `Error: ${msg}`
      );
      await this.store.appendTraceEvents(activeSession.id, [
        {
          timestamp: new Date().toISOString(),
          type: "error",
          summary: "Prompt execution failed.",
          details: msg
        }
      ]);
      this.output.appendLine(`[joshgpt] session completion error: ${msg}`);
      vscode.window.showErrorMessage(msg);
    } finally {
      this.busy = false;
      await this._postState();
    }
  }

  async _postState() {
    if (!this.view) {
      return;
    }
    await this.view.webview.postMessage({
      type: "state",
      payload: {
        sessions: this.store.getSessions(),
        activeSessionId: this.store.getActiveSessionId(),
        busy: this.busy,
        settings: this._serializeSettings()
      }
    });
  }

  _getHtml(webview) {
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>JoshGPT Sessions</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    .layout {
      display: grid;
      grid-template-columns: 34% 66%;
      height: 100vh;
    }
    .sessions {
      border-right: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      min-width: 160px;
    }
    .sessions-toolbar {
      display: flex;
      gap: 8px;
      padding: 8px;
    }
    .session-list {
      list-style: none;
      margin: 0;
      padding: 0 8px 8px;
      overflow: auto;
    }
    .session-item {
      padding: 8px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 6px;
      border: 1px solid transparent;
      background: var(--vscode-editor-background);
    }
    .session-item:hover {
      border-color: var(--vscode-focusBorder);
    }
    .session-item.active {
      border-color: var(--vscode-button-background);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .session-title {
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-meta {
      font-size: 11px;
      opacity: 0.8;
    }
    .chat {
      display: grid;
      grid-template-rows: auto 1fr auto auto;
      min-width: 0;
    }
    .chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .chat-title {
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .messages {
      overflow: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .message {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 8px;
    }
    .message.user {
      background: var(--vscode-textBlockQuote-background);
    }
    .message.assistant {
      background: color-mix(
        in srgb,
        var(--vscode-editor-background) 88%,
        var(--vscode-button-background)
      );
    }
    .message-header {
      font-size: 11px;
      opacity: 0.8;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .message-content {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.45;
    }
    .composer {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 8px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: end;
    }
    .trace {
      border-top: 1px solid var(--vscode-panel-border);
      max-height: 28vh;
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 100px;
    }
    .settings {
      border-top: 1px solid var(--vscode-panel-border);
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      min-height: 170px;
      max-height: 36vh;
    }
    .settings-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .settings-toolbar select {
      padding: 2px 4px;
      font: inherit;
      color: inherit;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
    }
    .settings-note {
      margin: 0;
      padding: 6px 8px;
      font-size: 11px;
      opacity: 0.85;
      border-bottom: 1px solid var(--vscode-panel-border);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 72px;
      overflow: auto;
    }
    .settings-editor {
      width: 100%;
      min-height: 120px;
      border: none;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 8px;
      resize: none;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: inherit;
      background: var(--vscode-editor-background);
      box-sizing: border-box;
    }
    .settings-status {
      padding: 6px 8px;
      font-size: 11px;
      opacity: 0.9;
    }
    .trace-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      font-size: 11px;
      opacity: 0.9;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .trace-content {
      margin: 0;
      padding: 8px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.4;
      opacity: 0.95;
    }
    .composer textarea {
      min-height: 56px;
      max-height: 180px;
      resize: vertical;
      font: inherit;
      color: inherit;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px;
    }
    button {
      border: none;
      border-radius: 6px;
      padding: 6px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font-size: 12px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .empty {
      opacity: 0.8;
      font-size: 12px;
      padding: 6px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="layout">
    <section class="sessions">
      <div class="sessions-toolbar">
        <button id="newSessionBtn">New</button>
      </div>
      <ul id="sessionList" class="session-list"></ul>
    </section>
    <section class="chat">
      <div class="chat-header">
        <div id="chatTitle" class="chat-title">No active session</div>
        <button id="deleteSessionBtn" class="secondary">Delete</button>
      </div>
      <div id="messages" class="messages"></div>
      <div class="composer">
        <textarea id="promptInput" placeholder="Ask JoshGPT..."></textarea>
        <button id="sendBtn">Send</button>
      </div>
      <div class="trace">
        <div class="trace-header">
          <span>Trace</span>
          <button id="clearTraceBtn" class="secondary">Clear</button>
        </div>
        <pre id="traceContent" class="trace-content"></pre>
      </div>
      <div class="settings">
        <div class="trace-header">
          <span>Settings</span>
          <button id="openSettingsBtn" class="secondary">Open VS Code Settings</button>
        </div>
        <div class="settings-toolbar">
          <label for="settingsScope">Save scope</label>
          <select id="settingsScope">
            <option value="user">User</option>
            <option value="workspace">Workspace</option>
          </select>
          <button id="reloadSettingsBtn" class="secondary">Reload</button>
          <button id="saveSettingsBtn">Save</button>
        </div>
        <pre id="settingsNote" class="settings-note"></pre>
        <textarea id="settingsJson" class="settings-editor" spellcheck="false"></textarea>
        <div id="settingsStatus" class="settings-status"></div>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = {
      sessions: [],
      activeSessionId: null,
      busy: false,
      settings: { fields: [], values: {}, signature: "", hasWorkspace: false }
    };
    let settingsDirty = false;

    const listEl = document.getElementById("sessionList");
    const titleEl = document.getElementById("chatTitle");
    const messagesEl = document.getElementById("messages");
    const traceEl = document.getElementById("traceContent");
    const sendBtn = document.getElementById("sendBtn");
    const promptInput = document.getElementById("promptInput");
    const deleteBtn = document.getElementById("deleteSessionBtn");
    const clearTraceBtn = document.getElementById("clearTraceBtn");
    const settingsScopeEl = document.getElementById("settingsScope");
    const settingsJsonEl = document.getElementById("settingsJson");
    const settingsNoteEl = document.getElementById("settingsNote");
    const settingsStatusEl = document.getElementById("settingsStatus");
    const reloadSettingsBtn = document.getElementById("reloadSettingsBtn");
    const saveSettingsBtn = document.getElementById("saveSettingsBtn");
    const openSettingsBtn = document.getElementById("openSettingsBtn");

    function activeSession() {
      return state.sessions.find((s) => s.id === state.activeSessionId) || null;
    }

    function formatTime(iso) {
      try {
        return new Date(iso).toLocaleTimeString();
      } catch {
        return "";
      }
    }

    function renderSessions() {
      listEl.innerHTML = "";
      if (!state.sessions.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "No sessions yet.";
        listEl.appendChild(li);
        return;
      }

      for (const session of state.sessions) {
        const li = document.createElement("li");
        li.className = "session-item" + (session.id === state.activeSessionId ? " active" : "");
        li.dataset.sessionId = session.id;

        const title = document.createElement("div");
        title.className = "session-title";
        title.textContent = session.title || "Untitled Session";

        const meta = document.createElement("div");
        meta.className = "session-meta";
        meta.textContent = (session.messages || []).length + " msgs";

        li.appendChild(title);
        li.appendChild(meta);
        li.addEventListener("click", () => {
          vscode.postMessage({ type: "selectSession", sessionId: session.id });
        });
        listEl.appendChild(li);
      }
    }

    function renderMessages() {
      const active = activeSession();
      messagesEl.innerHTML = "";

      if (!active) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Create a session to start chatting.";
        messagesEl.appendChild(empty);
        titleEl.textContent = "No active session";
        deleteBtn.disabled = true;
        traceEl.textContent = "No active session.";
        clearTraceBtn.disabled = true;
        return;
      }

      titleEl.textContent = active.title || "Untitled Session";
      deleteBtn.disabled = false;
      clearTraceBtn.disabled = false;

      if (!active.messages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No messages yet.";
        messagesEl.appendChild(empty);
        renderTrace(active);
        return;
      }

      for (const message of active.messages) {
        const wrapper = document.createElement("div");
        wrapper.className = "message " + (message.role === "assistant" ? "assistant" : "user");

        const header = document.createElement("div");
        header.className = "message-header";
        header.textContent = (message.role === "assistant" ? "JoshGPT" : "You") + " • " + formatTime(message.timestamp);

        const content = document.createElement("pre");
        content.className = "message-content";
        content.textContent = message.content || "";

        wrapper.appendChild(header);
        wrapper.appendChild(content);
        messagesEl.appendChild(wrapper);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      renderTrace(active);
    }

    function formatTraceLine(event) {
      const ts = formatTime(event.timestamp || "");
      const type = String(event.type || "event").toUpperCase();
      const summary = String(event.summary || "");
      const details = String(event.details || "");
      const header = "[" + ts + "] " + type + ": " + summary;
      if (!details) {
        return header;
      }
      return header + "\\n" + details;
    }

    function renderTrace(active) {
      const traceEvents = Array.isArray(active.traceEvents) ? active.traceEvents : [];
      if (!traceEvents.length) {
        traceEl.textContent = "No trace events for this session yet.";
        return;
      }
      traceEl.textContent = traceEvents.map(formatTraceLine).join("\\n\\n");
      traceEl.scrollTop = traceEl.scrollHeight;
    }

    function renderBusyState() {
      sendBtn.disabled = state.busy;
      sendBtn.textContent = state.busy ? "Sending..." : "Send";
      promptInput.disabled = state.busy;
    }

    function renderSettings(force) {
      const settings = state.settings || {};
      const values = settings.values || {};
      const fields = Array.isArray(settings.fields) ? settings.fields : [];
      const supportedKeys = fields.map((f) => f.key).join(", ");
      settingsNoteEl.textContent = supportedKeys
        ? "Editable keys: " + supportedKeys
        : "No editable settings metadata received.";

      const workspaceAvailable = Boolean(settings.hasWorkspace);
      const chosenScope = settingsScopeEl.value || "user";
      if (!workspaceAvailable && chosenScope === "workspace") {
        settingsScopeEl.value = "user";
      }
      settingsScopeEl.querySelector('option[value=\"workspace\"]').disabled = !workspaceAvailable;

      if (force || !settingsDirty) {
        settingsJsonEl.value = JSON.stringify(values, null, 2);
        settingsDirty = false;
      }
      settingsStatusEl.textContent =
        "Workspace scope available: " + (workspaceAvailable ? "yes" : "no");
    }

    function render(forceSettings) {
      renderSessions();
      renderMessages();
      renderBusyState();
      renderSettings(forceSettings);
    }

    document.getElementById("newSessionBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "createSession" });
    });

    deleteBtn.addEventListener("click", () => {
      const active = activeSession();
      if (!active) return;
      vscode.postMessage({ type: "deleteSession", sessionId: active.id });
    });

    clearTraceBtn.addEventListener("click", () => {
      const active = activeSession();
      if (!active) return;
      vscode.postMessage({ type: "clearTrace", sessionId: active.id });
    });

    settingsJsonEl.addEventListener("input", () => {
      settingsDirty = true;
      settingsStatusEl.textContent = "Settings edited but not saved.";
    });

    reloadSettingsBtn.addEventListener("click", () => {
      settingsDirty = false;
      settingsStatusEl.textContent = "Reloading settings...";
      vscode.postMessage({ type: "reloadSettings" });
    });

    saveSettingsBtn.addEventListener("click", () => {
      let parsed;
      try {
        parsed = JSON.parse(settingsJsonEl.value || "{}");
      } catch (err) {
        settingsStatusEl.textContent =
          "Invalid JSON: " + (err instanceof Error ? err.message : String(err));
        return;
      }

      settingsStatusEl.textContent = "Saving settings...";
      settingsDirty = false;
      vscode.postMessage({
        type: "saveSettings",
        scope: settingsScopeEl.value || "user",
        values: parsed
      });
    });

    openSettingsBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "openSettingsUi" });
    });

    function sendPrompt() {
      const prompt = promptInput.value.trim();
      if (!prompt || state.busy) {
        return;
      }
      promptInput.value = "";
      vscode.postMessage({ type: "sendPrompt", prompt });
    }

    sendBtn.addEventListener("click", sendPrompt);
    promptInput.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        sendPrompt();
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.type !== "state") {
        return;
      }
      const nextState = msg.payload || state;
      const currentSig = state && state.settings ? state.settings.signature : "";
      const nextSig = nextState && nextState.settings ? nextState.settings.signature : "";
      const forceSettings = currentSig !== nextSig;
      state = nextState;
      render(forceSettings);
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

module.exports = {
  JoshGptSessionViewProvider
};
