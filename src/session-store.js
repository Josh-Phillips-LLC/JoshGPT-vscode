"use strict";

const STORE_KEY = "joshgpt.sessions.v1";
const DEFAULT_TITLE = "New Session";

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(text) {
  const cleaned = String(text || "").trim().replace(/\s+/g, " ");
  if (!cleaned) {
    return DEFAULT_TITLE;
  }
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}...` : cleaned;
}

function normalizeMessage(raw) {
  const role = raw && (raw.role === "assistant" ? "assistant" : "user");
  return {
    role,
    content: String((raw && raw.content) || ""),
    timestamp: String((raw && raw.timestamp) || nowIso())
  };
}

function normalizeSession(raw) {
  const messages = Array.isArray(raw && raw.messages)
    ? raw.messages.map(normalizeMessage)
    : [];
  const createdAt = String((raw && raw.createdAt) || nowIso());
  const updatedAt = String((raw && raw.updatedAt) || createdAt);

  return {
    id: String((raw && raw.id) || makeId("session")),
    title: String((raw && raw.title) || DEFAULT_TITLE),
    createdAt,
    updatedAt,
    messages
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

class SessionStore {
  constructor(extensionContext) {
    this.context = extensionContext;
    this.state = this._loadState();
  }

  _loadState() {
    const raw = this.context.globalState.get(STORE_KEY, {
      sessions: [],
      activeSessionId: null
    });

    const sessions = Array.isArray(raw.sessions) ? raw.sessions.map(normalizeSession) : [];
    let activeSessionId = raw.activeSessionId ? String(raw.activeSessionId) : null;

    if (activeSessionId && !sessions.find((s) => s.id === activeSessionId)) {
      activeSessionId = sessions.length ? sessions[0].id : null;
    }

    return {
      sessions,
      activeSessionId
    };
  }

  async _persist() {
    await this.context.globalState.update(STORE_KEY, this.state);
  }

  getState() {
    return cloneState(this.state);
  }

  getSessions() {
    return cloneState(this.state.sessions);
  }

  getActiveSessionId() {
    return this.state.activeSessionId;
  }

  getSessionById(id) {
    return this.state.sessions.find((s) => s.id === id) || null;
  }

  getActiveSession() {
    if (!this.state.activeSessionId) {
      return null;
    }
    return this.getSessionById(this.state.activeSessionId);
  }

  async createSession(title = DEFAULT_TITLE) {
    const timestamp = nowIso();
    const session = {
      id: makeId("session"),
      title: String(title || DEFAULT_TITLE),
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: []
    };

    this.state.sessions.unshift(session);
    this.state.activeSessionId = session.id;
    await this._persist();
    return session;
  }

  async ensureActiveSession() {
    const existing = this.getActiveSession();
    if (existing) {
      return existing;
    }
    return this.createSession();
  }

  async setActiveSession(id) {
    const session = this.getSessionById(id);
    if (!session) {
      return null;
    }
    this.state.activeSessionId = session.id;
    await this._persist();
    return session;
  }

  async deleteSession(id) {
    const priorLength = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    if (this.state.sessions.length === priorLength) {
      return;
    }

    if (this.state.activeSessionId === id) {
      this.state.activeSessionId = this.state.sessions.length ? this.state.sessions[0].id : null;
    }
    await this._persist();
  }

  async appendMessage(sessionId, role, content) {
    const session = this.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const message = normalizeMessage({
      role,
      content,
      timestamp: nowIso()
    });

    session.messages.push(message);
    session.updatedAt = message.timestamp;
    this.state.activeSessionId = session.id;

    if (role === "user" && session.title === DEFAULT_TITLE) {
      session.title = deriveTitle(content);
    }

    await this._persist();
    return message;
  }
}

module.exports = {
  SessionStore
};
