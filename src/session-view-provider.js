"use strict";

const vscode = require("vscode");
const { SessionStore } = require("./session-store");
const { runChatWithOptionalMcp } = require("./chat-runner");

function makeNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 24; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
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

    if (type === "sendPrompt") {
      const prompt = String((message && message.prompt) || "").trim();
      if (!prompt) {
        return;
      }
      await this._sendPrompt(prompt);
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

      const { text } = await runChatWithOptionalMcp({
        config: cfg,
        messages: modelMessages,
        output: this.output
      });

      await this.store.appendMessage(activeSession.id, "assistant", text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.store.appendMessage(
        activeSession.id,
        "assistant",
        `Error: ${msg}`
      );
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
        busy: this.busy
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
      grid-template-rows: auto 1fr auto;
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
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { sessions: [], activeSessionId: null, busy: false };

    const listEl = document.getElementById("sessionList");
    const titleEl = document.getElementById("chatTitle");
    const messagesEl = document.getElementById("messages");
    const sendBtn = document.getElementById("sendBtn");
    const promptInput = document.getElementById("promptInput");
    const deleteBtn = document.getElementById("deleteSessionBtn");

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
        return;
      }

      titleEl.textContent = active.title || "Untitled Session";
      deleteBtn.disabled = false;

      if (!active.messages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No messages yet.";
        messagesEl.appendChild(empty);
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
    }

    function renderBusyState() {
      sendBtn.disabled = state.busy;
      sendBtn.textContent = state.busy ? "Sending..." : "Send";
      promptInput.disabled = state.busy;
    }

    function render() {
      renderSessions();
      renderMessages();
      renderBusyState();
    }

    document.getElementById("newSessionBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "createSession" });
    });

    deleteBtn.addEventListener("click", () => {
      const active = activeSession();
      if (!active) return;
      vscode.postMessage({ type: "deleteSession", sessionId: active.id });
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
      state = msg.payload || state;
      render();
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
