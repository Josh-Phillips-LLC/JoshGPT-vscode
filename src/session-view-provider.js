"use strict";

const vscode = require("vscode");
const { SessionStore } = require("./session-store");
const { runChatWithOptionalMcp } = require("./chat-runner");
const { McpHttpClient } = require("./mcp-client");
const { resolveInheritedInstructions } = require("./instruction-resolver");
const { resolveSupervisionProfile } = require("./supervision-profile-resolver");
const { checkSupervisorReadiness } = require("./supervisor-readiness");
const {
  TelemetryWriter,
  makeTelemetryId,
  emitTraceTelemetry
} = require("./telemetry");
const {
  runSupervisorWrapperToolCall,
  evaluateSupervisorEscalationGuardrails,
  emitSupervisorLog,
  buildGuardrailBlockedWrapperResult,
  buildGuardedSupervisorMessage
} = require("./supervisor-wrapper-tool");

const SETTINGS_EXTENSION_ID = "josh-phillips-llc.joshgpt";
const SETTINGS_SCOPE_EFFECTIVE = "effective";
const SETTINGS_SCOPE_USER = "user";
const SETTINGS_SCOPE_WORKSPACE = "workspace";
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
  { key: "supervisor.enabled", type: "boolean" },
  { key: "supervisor.modelEscalationEnabled", type: "boolean" },
  { key: "supervisor.dispatcherBaseUrl", type: "string" },
  { key: "supervisor.capabilityBaseUrl", type: "string" },
  { key: "supervisor.maxEscalationsPerTurn", type: "number", min: 1 },
  { key: "supervisor.maxEscalationsPerSession", type: "number", min: 1 },
  { key: "supervisor.escalationCooldownMs", type: "number", min: 0 },
  { key: "supervisor.logLevel", type: "enum", enum: ["off", "normal", "verbose"] },
  { key: "supervisor.workerRoleSlug", type: "string" },
  { key: "supervisor.supervisorRoleSlug", type: "string" },
  { key: "supervisor.assignedRoleSlug", type: "string" },
  { key: "supervisor.roleCatalogCacheTtlMs", type: "number", min: 1000 },
  { key: "telemetry.enabled", type: "boolean" },
  { key: "telemetry.logDir", type: "string" },
  { key: "telemetry.includeContent", type: "boolean" },
  { key: "telemetry.maxFileSizeMb", type: "number", min: 1 },
  { key: "telemetry.maxFiles", type: "number", min: 1 },
  { key: "instructions.inheritVscodeInstructions", type: "boolean" },
  { key: "instructions.maxChars", type: "number", min: 1024 },
  { key: "localShell.enabled", type: "boolean" },
  { key: "localShell.defaultTimeoutSeconds", type: "number", min: 1 },
  { key: "localShell.maxTimeoutSeconds", type: "number", min: 1 },
  { key: "localShell.defaultMaxOutputChars", type: "number", min: 256 },
  { key: "localShell.maxOutputChars", type: "number", min: 256 },
  { key: "localShell.mirrorTerminalEnabled", type: "boolean" },
  { key: "localShell.mirrorTerminalName", type: "string" },
  { key: "localShell.mirrorTerminalReveal", type: "boolean" }
];

function asString(value) {
  return String(value || "").trim();
}

function safeJsonParseObject(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore invalid JSON in trace details.
  }
  return null;
}

function unwrapMcpToolResult(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  if (raw.structuredContent && typeof raw.structuredContent === "object") {
    return raw.structuredContent;
  }
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (item.type === "text" && typeof item.text === "string") {
        const parsed = safeJsonParseObject(item.text);
        if (parsed) {
          return parsed;
        }
      }
    }
  }
  return raw;
}

function normalizeRoleCatalogPayload(payload) {
  const parsed = payload && typeof payload === "object" ? payload : {};
  const registrySource = asString(parsed.registry_source);
  const registryVersion = asString(parsed.registry_version);
  const roles = Array.isArray(parsed.roles) ? parsed.roles : [];
  const normalizedRoles = [];
  for (const role of roles) {
    if (!role || typeof role !== "object") {
      continue;
    }
    const slug = asString(role.slug);
    const displayName = asString(role.display_name);
    const repoName = asString(role.repo_name);
    const menuOrder = Number(role.menu_order);
    if (!slug || !displayName || !repoName || !Number.isFinite(menuOrder)) {
      continue;
    }
    normalizedRoles.push({
      slug,
      display_name: displayName,
      repo_name: repoName,
      menu_order: menuOrder
    });
  }
  normalizedRoles.sort((a, b) => {
    if (a.menu_order !== b.menu_order) {
      return a.menu_order - b.menu_order;
    }
    return a.slug.localeCompare(b.slug);
  });
  if (!registrySource || !registryVersion) {
    throw new Error("Dispatcher returned invalid role catalog metadata.");
  }
  return {
    registrySource,
    registryVersion,
    roles: normalizedRoles
  };
}

function normalizeOneLine(text, maxChars = 260) {
  const normalized = asString(text).replace(/\s+/g, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function deriveLatestAssistantEvidence(session) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item && item.role === "assistant" && asString(item.content)) {
      return normalizeOneLine(item.content, 600);
    }
  }
  return "";
}

function deriveAttemptHistory(session, maxItems = 8) {
  const events = Array.isArray(session && session.traceEvents) ? session.traceEvents : [];
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < maxItems; i -= 1) {
    const event = events[i];
    const summary = normalizeOneLine(event && event.summary, 160);
    if (!summary) {
      continue;
    }
    out.push(summary);
  }
  return out.reverse();
}

function deriveObjective(session, promptFallback = "") {
  const prompt = normalizeOneLine(promptFallback, 260);
  if (prompt) {
    return prompt;
  }
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item && item.role === "user" && asString(item.content)) {
      return normalizeOneLine(item.content, 260);
    }
  }
  return "Resolve the active workspace blocker safely.";
}

function deriveGuardrailSeed(session) {
  const events = Array.isArray(session && session.traceEvents) ? session.traceEvents : [];
  let sessionEscalationsInSession = 0;
  let lastEscalationAtMs = 0;
  let lastEscalationQuestionHash = "";
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event || String(event.type || "") !== "supervisor-escalation-decision") {
      continue;
    }
    sessionEscalationsInSession += 1;
    const eventTime = Date.parse(String(event.timestamp || ""));
    if (Number.isFinite(eventTime)) {
      lastEscalationAtMs = Math.max(lastEscalationAtMs, eventTime);
    }
    const parsed = safeJsonParseObject(event.details);
    const guardrailState =
      parsed &&
      parsed.guardrail_state &&
      typeof parsed.guardrail_state === "object"
        ? parsed.guardrail_state
        : null;
    if (guardrailState) {
      const parsedAt = Number(guardrailState.lastEscalationAtMs);
      if (Number.isFinite(parsedAt)) {
        lastEscalationAtMs = Math.max(lastEscalationAtMs, parsedAt);
      }
      const parsedHash = asString(guardrailState.lastEscalationQuestionHash);
      if (parsedHash) {
        lastEscalationQuestionHash = parsedHash;
      }
    }
  }
  return {
    sessionEscalationsInSession,
    lastEscalationAtMs,
    lastEscalationQuestionHash
  };
}

function formatSupervisorDecisionMessage(wrapperResult) {
  const decision =
    wrapperResult && wrapperResult.decision && typeof wrapperResult.decision === "object"
      ? wrapperResult.decision
      : {};
  if (wrapperResult && wrapperResult.action === "terminate") {
    return buildGuardedSupervisorMessage(wrapperResult);
  }
  const lines = [];
  lines.push(`Supervisor decision: ${asString(decision.decision) || "proceed"}`);
  if (asString(decision.rationale)) {
    lines.push(`Rationale: ${asString(decision.rationale)}`);
  }
  lines.push(`Terminal: ${Boolean(wrapperResult && wrapperResult.terminal)}`);
  const nextActions = Array.isArray(decision.next_actions) ? decision.next_actions : [];
  let idx = 1;
  for (const action of nextActions) {
    lines.push(`Next action ${idx}: ${String(action)}`);
    idx += 1;
  }
  return lines.join("\n");
}

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

function createTelemetryWriter(cfg) {
  return new TelemetryWriter({
    enabled: Boolean(cfg.telemetryEnabled ?? true),
    workspaceRoot: asString(cfg.workspaceRoot) || process.cwd(),
    logDir: asString(cfg.telemetryLogDir) || ".joshgpt/logs",
    includeContent: Boolean(cfg.telemetryIncludeContent),
    maxFileSizeMb: Number(cfg.telemetryMaxFileSizeMb || 10),
    maxFiles: Number(cfg.telemetryMaxFiles || 5)
  });
}

class JoshGptSessionViewProvider {
  static viewType = "joshgpt.sessions";

  constructor(extensionContext, output, getConfig) {
    this.context = extensionContext;
    this.output = output;
    this.getConfig = getConfig;
    this.store = new SessionStore(extensionContext);
    this.supervisorRoleCatalogState = {
      roles: [],
      registrySource: "",
      registryVersion: "",
      fetchedAtMs: 0,
      loading: false,
      error: ""
    };
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

    await this._ensureSupervisorRoleCatalog({ force: false, silent: true });
    await this._postState();
  }

  async createSessionFromCommand() {
    await this.store.createSession();
    await this._postState();
  }

  async escalateActiveSessionFromCommand() {
    await this._escalateToSupervisor();
  }

  async assignSupervisorRoleFromCommand() {
    const catalog = await this._ensureSupervisorRoleCatalog({
      force: false,
      silent: false
    });
    const roles = Array.isArray(catalog.roles) ? catalog.roles : [];
    if (!roles.length) {
      throw new Error(
        catalog.error || "Supervisor role catalog is empty. Refresh and try again."
      );
    }

    const cfg = this.getConfig();
    const currentAssignedSlug = asString(cfg.supervisorAssignedRoleSlug);
    const options = [
      {
        label: "Auto (Use supervision profile)",
        description: "No explicit assignment",
        detail: "Use workspace/profile supervisor role if available.",
        roleSlug: ""
      },
      ...roles.map((role) => ({
        label: role.display_name,
        description: role.slug,
        detail: role.repo_name,
        roleSlug: role.slug
      }))
    ];

    const selected = await vscode.window.showQuickPick(options, {
      title: "Assign Supervisor Role",
      placeHolder: "Select a supervisor role from registry catalog."
    });
    if (!selected) {
      return;
    }
    await this._saveAssignedSupervisorRole(selected.roleSlug);
    await this._postState();

    const label = selected.roleSlug || "auto-profile";
    const changed = selected.roleSlug !== currentAssignedSlug;
    if (changed) {
      vscode.window.showInformationMessage(`Supervisor role assignment set to ${label}.`);
    }
  }

  async refreshSupervisorRoleCatalogFromCommand() {
    const catalog = await this._ensureSupervisorRoleCatalog({
      force: true,
      silent: false
    });
    await this._postState();
    if (catalog.error) {
      throw new Error(catalog.error);
    }
    vscode.window.showInformationMessage(
      `Supervisor role catalog refreshed (${catalog.roles.length} roles).`
    );
  }

  _settingsConfig() {
    return vscode.workspace.getConfiguration("joshgpt");
  }

  _hasWorkspace() {
    return Boolean((vscode.workspace.workspaceFolders || []).length > 0);
  }

  _settingsTarget() {
    return this._hasWorkspace()
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  _settingsSourceForKey(cfg, key) {
    const inspected = cfg.inspect(key);
    const hasWorkspaceFolder =
      Boolean(inspected) &&
      Object.prototype.hasOwnProperty.call(inspected, "workspaceFolderValue");
    const hasWorkspace =
      Boolean(inspected) &&
      Object.prototype.hasOwnProperty.call(inspected, "workspaceValue");
    const hasUser =
      Boolean(inspected) &&
      Object.prototype.hasOwnProperty.call(inspected, "globalValue");

    let effective = "default";
    if (hasWorkspaceFolder) {
      effective = "workspaceFolder";
    } else if (hasWorkspace) {
      effective = "workspace";
    } else if (hasUser) {
      effective = "user";
    }

    return {
      effective,
      hasUser,
      hasWorkspace,
      hasWorkspaceFolder
    };
  }

  _resolveSaveTarget(cfg, key, rawScope) {
    const scope = String(rawScope || "").trim().toLowerCase();
    if (scope === SETTINGS_SCOPE_WORKSPACE) {
      return this._hasWorkspace()
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    }
    if (scope === SETTINGS_SCOPE_EFFECTIVE) {
      const source = this._settingsSourceForKey(cfg, key);
      if (
        (source.effective === "workspace" || source.effective === "workspaceFolder") &&
        this._hasWorkspace()
      ) {
        return vscode.ConfigurationTarget.Workspace;
      }
      if (source.effective === "user") {
        return vscode.ConfigurationTarget.Global;
      }
      return vscode.ConfigurationTarget.Global;
    }
    if (scope === SETTINGS_SCOPE_USER) {
      return vscode.ConfigurationTarget.Global;
    }
    return vscode.ConfigurationTarget.Global;
  }

  async _saveAssignedSupervisorRole(roleSlug) {
    const cfg = this._settingsConfig();
    await cfg.update(
      "supervisor.assignedRoleSlug",
      asString(roleSlug),
      this._settingsTarget()
    );
  }

  async _fetchSupervisorRoleCatalog(cfg) {
    const token = asString(process.env.JOSHGPT_DISPATCHER_SHARED_TOKEN);
    if (!token) {
      throw new Error(
        "Supervisor role catalog requires JOSHGPT_DISPATCHER_SHARED_TOKEN in extension environment."
      );
    }
    if (!asString(cfg.supervisorDispatcherBaseUrl)) {
      throw new Error("joshgpt.supervisor.dispatcherBaseUrl is empty.");
    }
    const client = new McpHttpClient({
      baseUrl: cfg.supervisorDispatcherBaseUrl,
      timeoutMs: cfg.mcpTimeoutMs,
      output: this.output
    });
    const raw = await client.callTool("list_role_catalog", {
      shared_token: token
    });
    const payload = normalizeRoleCatalogPayload(unwrapMcpToolResult(raw));
    return {
      roles: payload.roles,
      registrySource: payload.registrySource,
      registryVersion: payload.registryVersion,
      fetchedAtMs: Date.now(),
      loading: false,
      error: ""
    };
  }

  async _ensureSupervisorRoleCatalog({ force = false, silent = false } = {}) {
    const cfg = this.getConfig();
    const ttlMs = Math.max(1000, Number(cfg.supervisorRoleCatalogCacheTtlMs) || 60000);
    const ageMs = Date.now() - Number(this.supervisorRoleCatalogState.fetchedAtMs || 0);
    const cacheFresh =
      !force &&
      Array.isArray(this.supervisorRoleCatalogState.roles) &&
      this.supervisorRoleCatalogState.roles.length > 0 &&
      ageMs >= 0 &&
      ageMs < ttlMs;
    if (cacheFresh) {
      return this.supervisorRoleCatalogState;
    }

    this.supervisorRoleCatalogState = {
      ...this.supervisorRoleCatalogState,
      loading: true,
      error: ""
    };
    await this._postState();

    try {
      const nextState = await this._fetchSupervisorRoleCatalog(cfg);
      this.supervisorRoleCatalogState = nextState;
      return nextState;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.supervisorRoleCatalogState = {
        ...this.supervisorRoleCatalogState,
        loading: false,
        error: msg
      };
      if (!silent) {
        vscode.window.showWarningMessage(`Supervisor role catalog refresh failed: ${msg}`);
      }
      return this.supervisorRoleCatalogState;
    } finally {
      await this._postState();
    }
  }

  _serializeSettings() {
    const cfg = this._settingsConfig();
    const values = {};
    const sources = {};
    for (const field of SETTINGS_FIELDS) {
      values[field.key] = cfg.get(field.key);
      sources[field.key] = this._settingsSourceForKey(cfg, field.key);
    }
    return {
      fields: SETTINGS_FIELDS,
      values,
      sources,
      signature: JSON.stringify(values),
      hasWorkspace: this._hasWorkspace()
    };
  }

  _serializeSupervisorRoleCatalog() {
    const cfg = this.getConfig();
    const assignedRoleSlug = asString(cfg.supervisorAssignedRoleSlug);
    const state = this.supervisorRoleCatalogState || {};
    const roles = Array.isArray(state.roles) ? state.roles : [];
    return {
      assignedRoleSlug,
      roles,
      registrySource: asString(state.registrySource),
      registryVersion: asString(state.registryVersion),
      fetchedAtMs: Number(state.fetchedAtMs || 0),
      loading: Boolean(state.loading),
      error: asString(state.error),
      cacheTtlMs: Math.max(1000, Number(cfg.supervisorRoleCatalogCacheTtlMs) || 60000)
    };
  }

  async _saveSettings(rawValues, rawScope) {
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

      const target = this._resolveSaveTarget(cfg, field.key, rawScope);
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

    if (type === "escalateToSupervisor") {
      await this._escalateToSupervisor();
      return;
    }

    if (type === "reloadSettings") {
      await this._postState();
      return;
    }

    if (type === "refreshSupervisorRoleCatalog") {
      await this._ensureSupervisorRoleCatalog({ force: true, silent: false });
      await this._postState();
      return;
    }

    if (type === "assignSupervisorRole") {
      const roleSlug = asString(message && message.roleSlug);
      await this._saveAssignedSupervisorRole(roleSlug);
      await this._postState();
      return;
    }

    if (type === "saveSettings") {
      const values = (message && message.values) || {};
      const scope = String((message && message.scope) || SETTINGS_SCOPE_EFFECTIVE)
        .trim()
        .toLowerCase();
      await this._saveSettings(values, scope);
      await this._ensureSupervisorRoleCatalog({ force: false, silent: true });
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

    let telemetry = null;
    let correlation = null;
    try {
      const cfg = this.getConfig();
      telemetry = createTelemetryWriter(cfg);
      correlation = {
        chatSessionId: String(activeSession.id || "unknown"),
        turnId: makeTelemetryId("turn"),
        requestIdFactory: () => makeTelemetryId("req")
      };
      telemetry.log({
        event: "turn.start",
        message: "Session prompt turn started.",
        chat_session_id: correlation.chatSessionId,
        turn_id: correlation.turnId,
        component: "session-view",
        operation: "sendPrompt",
        status: "start",
        model: String(cfg.model || "")
      });
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

      const instructionInheritance = resolveInheritedInstructions({
        workspaceRoot: cfg.workspaceRoot,
        enabled: cfg.instructionsInheritVscodeInstructions,
        maxChars: cfg.instructionsMaxChars
      });
      const objective = deriveObjective(latestSession, prompt);
      const guardrailSeed = deriveGuardrailSeed(latestSession);
      const supervisorSessionContext = {
        objective,
        roleContextRef: instructionInheritance.canonicalPath || "workspace://AGENTS.md",
        attemptHistory: deriveAttemptHistory(latestSession, 8),
        evidenceSummary: deriveLatestAssistantEvidence(latestSession),
        blockedReason: "insufficient_context",
        currentPhase: "validation",
        requestedDecision: "next_step"
      };

      const modelMessages = [];
      if (instructionInheritance.applied && instructionInheritance.systemMessage) {
        modelMessages.push({
          role: "system",
          content: instructionInheritance.systemMessage
        });
      }
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
      this.output.appendLine(
        `[joshgpt] inherited_instructions=${instructionInheritance.applied ? "applied" : "not-applied"} canonical=${instructionInheritance.canonicalAvailable ? "yes" : "no"} hash=${instructionInheritance.contentHash || "<none>"} truncated=${instructionInheritance.truncated ? "yes" : "no"}`
      );

      const { text, trace, rounds, usedTools } = await runChatWithOptionalMcp({
        config: {
          ...cfg,
          telemetry,
          correlation,
          instructionInheritance,
          supervisorSessionContext,
          supervisorEscalationsInSession: guardrailSeed.sessionEscalationsInSession,
          supervisorLastEscalationAtMs: guardrailSeed.lastEscalationAtMs,
          supervisorLastEscalationQuestionHash: guardrailSeed.lastEscalationQuestionHash
        },
        messages: modelMessages,
        output: this.output
      });

      await this.store.appendMessage(activeSession.id, "assistant", text);
      await this.store.appendTraceEvents(activeSession.id, trace);
      telemetry.log({
        event: "turn.complete",
        message: "Session prompt turn completed.",
        chat_session_id: correlation.chatSessionId,
        turn_id: correlation.turnId,
        component: "session-view",
        operation: "sendPrompt",
        status: "ok",
        model: String(cfg.model || ""),
        attrs: {
          rounds: Number(rounds || 0),
          used_tools: Boolean(usedTools)
        }
      });
      emitTraceTelemetry(telemetry, trace, correlation, {
        component: "chat-runner",
        model: String(cfg.model || ""),
        endpoint:
          cfg.chatEndpointMode === "lmstudio-native-stream"
            ? `${cfg.nativeBaseUrl}/api/v1/chat`
            : `${cfg.baseUrl}/chat/completions`
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (telemetry && correlation) {
        telemetry.log({
          event: "turn.error",
          level: "error",
          message: "Session prompt turn failed.",
          chat_session_id: correlation.chatSessionId,
          turn_id: correlation.turnId,
          component: "session-view",
          operation: "sendPrompt",
          status: "error",
          error_code: "prompt_failed",
          attrs: {
            error: msg
          }
        });
      }
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

  async _escalateToSupervisor() {
    if (this.busy) {
      vscode.window.showInformationMessage("JoshGPT is busy. Wait for current run to finish.");
      return;
    }
    this.busy = true;
    await this._postState();
    try {
      const activeSession = await this.store.ensureActiveSession();
      const session = this.store.getSessionById(activeSession.id);
      if (!session) {
        throw new Error("Active session not found.");
      }

      const cfg = this.getConfig();
      const telemetry = createTelemetryWriter(cfg);
      const correlation = {
        chatSessionId: String(activeSession.id || "unknown"),
        turnId: makeTelemetryId("turn"),
        requestIdFactory: () => makeTelemetryId("req")
      };
      if (!cfg.supervisorEnabled) {
        throw new Error("Supervisor is disabled (joshgpt.supervisor.enabled=false).");
      }

      const question = asString(
        await vscode.window.showInputBox({
          title: "Escalate to Supervisor",
          placeHolder: "Describe what decision you need from supervisor.",
          prompt: "Enter a focused escalation question.",
          ignoreFocusOut: true
        })
      );
      if (!question) {
        return;
      }

      const reasonChoice = await vscode.window.showQuickPick(
        [
          { label: "Need next step", value: "insufficient_context" },
          { label: "Tool error", value: "tool_error" },
          { label: "Ambiguous result", value: "ambiguous_result" },
          { label: "Policy conflict", value: "policy_conflict" },
          { label: "Repeated failure", value: "repeated_failure" }
        ],
        {
          title: "Escalation reason",
          placeHolder: "Select the closest reason."
        }
      );
      if (!reasonChoice) {
        return;
      }
      telemetry.log({
        event: "supervisor.manual.start",
        message: "Manual supervisor escalation started.",
        chat_session_id: correlation.chatSessionId,
        turn_id: correlation.turnId,
        component: "session-view",
        operation: "manual_escalation",
        status: "start",
        attrs: {
          blocked_reason: reasonChoice.value
        }
      });

      const instructionInheritance = resolveInheritedInstructions({
        workspaceRoot: cfg.workspaceRoot,
        enabled: cfg.instructionsInheritVscodeInstructions,
        maxChars: cfg.instructionsMaxChars
      });
      const profile = resolveSupervisionProfile({
        workspaceRoot: cfg.workspaceRoot,
        settingsFallback: {
          workerRoleSlug: cfg.supervisorWorkerRoleSlug,
          supervisorRoleSlug: cfg.supervisorSupervisorRoleSlug
        }
      });
      const readiness = await checkSupervisorReadiness({
        dispatcherBaseUrl: cfg.supervisorDispatcherBaseUrl,
        capabilityBaseUrl: cfg.supervisorCapabilityBaseUrl,
        timeoutMs: cfg.mcpTimeoutMs,
        output: this.output
      });

      const guardrailSeed = deriveGuardrailSeed(session);
      const guardrailEval = evaluateSupervisorEscalationGuardrails({
        input: { question },
        state: {
          turnEscalationCount: 0,
          sessionEscalationCount: guardrailSeed.sessionEscalationsInSession,
          lastEscalationAtMs: guardrailSeed.lastEscalationAtMs,
          lastEscalationQuestionHash: guardrailSeed.lastEscalationQuestionHash
        },
        policy: {
          maxPerTurn: cfg.supervisorMaxEscalationsPerTurn,
          maxPerSession: cfg.supervisorMaxEscalationsPerSession,
          cooldownMs: cfg.supervisorEscalationCooldownMs
        }
      });

      const supervisorSessionContext = {
        objective: deriveObjective(session, question),
        roleContextRef: instructionInheritance.canonicalPath || "workspace://AGENTS.md",
        attemptHistory: deriveAttemptHistory(session, 8),
        evidenceSummary: deriveLatestAssistantEvidence(session),
        blockedReason: reasonChoice.value,
        currentPhase: "validation",
        requestedDecision: "next_step"
      };

      let wrapperResult;
      if (!profile.resolved) {
        emitSupervisorLog(this.output, cfg.supervisorLogLevel, "escalation_blocked", {
          invocation_source: "manual_ui",
          reason_type: "profile_unresolved",
          reason: profile.error || "role binding unavailable."
        });
        wrapperResult = buildGuardrailBlockedWrapperResult(
          `Missing supervision profile: ${profile.error || "role binding unavailable."}`
        );
      } else if (!readiness.ready) {
        emitSupervisorLog(this.output, cfg.supervisorLogLevel, "escalation_blocked", {
          invocation_source: "manual_ui",
          reason_type: "preflight_blocked",
          reason: readiness.summary
        });
        wrapperResult = buildGuardrailBlockedWrapperResult(
          `Supervisor preflight blocked: ${readiness.summary}`
        );
      } else if (!guardrailEval.allowed) {
        emitSupervisorLog(this.output, cfg.supervisorLogLevel, "escalation_blocked", {
          invocation_source: "manual_ui",
          reason_type: "guardrail_denied",
          reason: guardrailEval.reason
        });
        wrapperResult = buildGuardrailBlockedWrapperResult(guardrailEval.reason);
      } else {
        wrapperResult = await runSupervisorWrapperToolCall(
          {
            question,
            escalation_reason: "manual_user_request",
            blocked_reason: reasonChoice.value
          },
          {
            dispatcherBaseUrl: cfg.supervisorDispatcherBaseUrl,
            capabilityBaseUrl: cfg.supervisorCapabilityBaseUrl,
            timeoutMs: cfg.mcpTimeoutMs,
            output: this.output,
            supervisionProfile: profile.profile,
            supervisionProfileSource: profile.source,
            assignedSupervisorRoleSlug: cfg.supervisorAssignedRoleSlug,
            logLevel: cfg.supervisorLogLevel,
            invocationSource: "manual_ui",
            sessionContext: supervisorSessionContext,
            telemetry,
            correlation
          }
        );
      }

      const trace = [
        {
          timestamp: new Date().toISOString(),
          type: "supervisor-preflight",
          summary: `Supervisor readiness: ${readiness.status}`,
          details: JSON.stringify(
            {
              status: readiness.status,
              summary: readiness.summary,
              checks: readiness.checks
            },
            null,
            2
          )
        },
        {
          timestamp: new Date().toISOString(),
          type: "supervision-profile",
          summary: profile.resolved
            ? `Supervisor profile resolved from ${profile.source}.`
            : "Supervisor profile unresolved.",
          details: JSON.stringify(
            {
              source: profile.source,
              resolved: profile.resolved,
              assigned_supervisor_role_slug: cfg.supervisorAssignedRoleSlug || "",
              error: profile.error || "",
              warning: profile.warning || "",
              filePath: profile.filePath || null
            },
            null,
            2
          )
        },
        {
          timestamp: new Date().toISOString(),
          type: "supervisor-escalation-request",
          summary: "Manual escalation submitted.",
          details: JSON.stringify(
            {
              question,
              blocked_reason: reasonChoice.value
            },
            null,
            2
          )
        },
        {
          timestamp: new Date().toISOString(),
          type: "supervisor-escalation-decision",
          summary: `Supervisor wrapper result: action=${wrapperResult.action}`,
          details: JSON.stringify(
            {
              wrapper_result: wrapperResult,
              guardrail_state: guardrailEval.state
            },
            null,
            2
          )
        }
      ];

      await this.store.appendMessage(
        activeSession.id,
        "assistant",
        formatSupervisorDecisionMessage(wrapperResult)
      );
      await this.store.appendTraceEvents(activeSession.id, trace);
      emitTraceTelemetry(telemetry, trace, correlation, {
        component: "session-view",
        model: String(cfg.model || ""),
        endpoint: String(cfg.supervisorCapabilityBaseUrl || "")
      });
      telemetry.log({
        event: "supervisor.manual.complete",
        message: "Manual supervisor escalation completed.",
        chat_session_id: correlation.chatSessionId,
        turn_id: correlation.turnId,
        component: "session-view",
        operation: "manual_escalation",
        status: "ok",
        attrs: {
          action: String(wrapperResult && wrapperResult.action || "")
        }
      });
      await this._postState();
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
        settings: this._serializeSettings(),
        supervisorRoleCatalog: this._serializeSupervisorRoleCatalog()
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
      grid-template-columns: minmax(180px, 28%) 1fr;
      height: 100vh;
    }
    .layout.sessions-collapsed {
      grid-template-columns: 0 1fr;
    }
    .layout.sessions-collapsed .sessions {
      display: none;
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
      grid-template-rows: auto auto 1fr auto;
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
    .chat-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .supervisor-assign {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      opacity: 0.92;
      white-space: nowrap;
    }
    .supervisor-assign select {
      min-width: 200px;
      padding: 3px 6px;
      font: inherit;
      color: inherit;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
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
    details.message-trace {
      margin-top: 8px;
      border-top: 1px dashed var(--vscode-panel-border);
      padding-top: 6px;
    }
    details.message-trace > summary {
      cursor: pointer;
      font-size: 11px;
      opacity: 0.9;
      list-style: none;
      user-select: none;
    }
    details.message-trace > summary::-webkit-details-marker {
      display: none;
    }
    details.message-trace > summary::before {
      content: "▸ ";
    }
    details.message-trace[open] > summary::before {
      content: "▾ ";
    }
    .message-trace-content {
      margin: 6px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.4;
      opacity: 0.95;
    }
    .composer {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 8px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: end;
    }
    .settings {
      border-bottom: 1px solid var(--vscode-panel-border);
      margin: 0;
    }
    .settings[open] > summary {
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .settings > summary {
      padding: 6px 8px;
      font-size: 11px;
      opacity: 0.9;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .settings > summary::-webkit-details-marker {
      display: none;
    }
    .settings > summary::before {
      content: "▸ ";
    }
    .settings[open] > summary::before {
      content: "▾ ";
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
      height: 140px;
      min-height: 100px;
      max-height: 24vh;
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
        <div class="chat-actions">
          <label class="supervisor-assign" for="supervisorRoleSelect">
            <span>Assign Supervisor</span>
            <select id="supervisorRoleSelect"></select>
          </label>
          <button id="refreshSupervisorRolesBtn" class="secondary">Refresh Roles</button>
          <button id="toggleSessionsBtn" class="secondary">Show Sessions</button>
          <button id="escalateBtn" class="secondary">Escalate</button>
          <button id="deleteSessionBtn" class="secondary">Delete</button>
        </div>
      </div>
      <details id="settingsPanel" class="settings">
        <summary>Settings</summary>
        <div class="settings-toolbar">
          <label for="settingsScope">Save scope</label>
          <select id="settingsScope">
            <option value="effective">Effective source (recommended)</option>
            <option value="user">User</option>
            <option value="workspace">Workspace</option>
          </select>
          <button id="reloadSettingsBtn" class="secondary">Reload</button>
          <button id="saveSettingsBtn">Save</button>
          <button id="openSettingsBtn" class="secondary">Open VS Code Settings</button>
        </div>
        <pre id="settingsNote" class="settings-note"></pre>
        <textarea id="settingsJson" class="settings-editor" spellcheck="false"></textarea>
        <div id="settingsStatus" class="settings-status"></div>
      </details>
      <div id="messages" class="messages"></div>
      <div class="composer">
        <textarea id="promptInput" placeholder="Ask JoshGPT..."></textarea>
        <button id="sendBtn">Send</button>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = {
      sessions: [],
      activeSessionId: null,
      busy: false,
      settings: { fields: [], values: {}, sources: {}, signature: "", hasWorkspace: false },
      supervisorRoleCatalog: {
        assignedRoleSlug: "",
        roles: [],
        registrySource: "",
        registryVersion: "",
        fetchedAtMs: 0,
        loading: false,
        error: "",
        cacheTtlMs: 60000
      }
    };
    const uiState = {
      sessionsCollapsed: true
    };
    let settingsDirty = false;

    const layoutEl = document.querySelector(".layout");
    const listEl = document.getElementById("sessionList");
    const titleEl = document.getElementById("chatTitle");
    const messagesEl = document.getElementById("messages");
    const sendBtn = document.getElementById("sendBtn");
    const escalateBtn = document.getElementById("escalateBtn");
    const supervisorRoleSelect = document.getElementById("supervisorRoleSelect");
    const refreshSupervisorRolesBtn = document.getElementById("refreshSupervisorRolesBtn");
    const promptInput = document.getElementById("promptInput");
    const toggleSessionsBtn = document.getElementById("toggleSessionsBtn");
    const deleteBtn = document.getElementById("deleteSessionBtn");
    const settingsScopeEl = document.getElementById("settingsScope");
    const settingsJsonEl = document.getElementById("settingsJson");
    const settingsNoteEl = document.getElementById("settingsNote");
    const settingsStatusEl = document.getElementById("settingsStatus");
    const reloadSettingsBtn = document.getElementById("reloadSettingsBtn");
    const saveSettingsBtn = document.getElementById("saveSettingsBtn");
    const openSettingsBtn = document.getElementById("openSettingsBtn");

    function summarizeSettingSources(sourceMap) {
      const entries = Object.entries(sourceMap || {}).filter((pair) => {
        const meta = pair[1] || {};
        return String(meta.effective || "default") !== "default";
      });
      if (!entries.length) {
        return "all defaults";
      }
      const preview = entries.slice(0, 8).map((pair) => {
        const key = pair[0];
        const meta = pair[1] || {};
        return key + "=" + String(meta.effective || "default");
      });
      if (entries.length > 8) {
        preview.push("+" + String(entries.length - 8) + " more");
      }
      return preview.join(", ");
    }

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
        escalateBtn.disabled = true;
        return;
      }

      titleEl.textContent = active.title || "Untitled Session";
      deleteBtn.disabled = false;
      escalateBtn.disabled = false;

      if (!active.messages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No messages yet.";
        messagesEl.appendChild(empty);
        return;
      }

      const traceRuns = buildTraceRuns(active);
      let assistantIndex = 0;

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

        if (message.role === "assistant") {
          const traceForAssistant = assistantIndex < traceRuns.length ? traceRuns[assistantIndex] : [];
          assistantIndex += 1;
          if (traceForAssistant.length) {
            wrapper.appendChild(renderInlineTrace(traceForAssistant));
          }
        }

        messagesEl.appendChild(wrapper);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
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

    function buildTraceRuns(active) {
      const traceEvents = Array.isArray(active.traceEvents) ? active.traceEvents : [];
      if (!traceEvents.length) {
        return [];
      }

      const runs = [];
      let current = [];
      for (const event of traceEvents) {
        if (String(event.type || "") === "start" && current.length) {
          runs.push(current);
          current = [event];
          continue;
        }
        current.push(event);
      }
      if (current.length) {
        runs.push(current);
      }
      return runs;
    }

    function renderInlineTrace(traceEvents) {
      const details = document.createElement("details");
      details.className = "message-trace";

      const summary = document.createElement("summary");
      summary.textContent = "Trace (" + traceEvents.length + " events)";

      const content = document.createElement("pre");
      content.className = "message-trace-content";
      content.textContent = traceEvents.map(formatTraceLine).join("\\n\\n");

      details.appendChild(summary);
      details.appendChild(content);
      return details;
    }

    function renderLayout() {
      const collapsed = Boolean(uiState.sessionsCollapsed);
      layoutEl.classList.toggle("sessions-collapsed", collapsed);
      toggleSessionsBtn.textContent = collapsed ? "Show Sessions" : "Hide Sessions";
    }

    function renderBusyState() {
      sendBtn.disabled = state.busy;
      sendBtn.textContent = state.busy ? "Sending..." : "Send";
      promptInput.disabled = state.busy;
      if (state.busy) {
        escalateBtn.disabled = true;
      }
    }

    function renderSupervisorRoleAssignment() {
      const catalog = state.supervisorRoleCatalog || {};
      const roles = Array.isArray(catalog.roles) ? catalog.roles : [];
      const assignedRoleSlug = String(catalog.assignedRoleSlug || "");
      const loading = Boolean(catalog.loading);
      const disabled = loading || state.busy;

      const options = [
        {
          value: "",
          label: "Auto (Use supervision profile)"
        },
        ...roles.map((role) => ({
          value: String(role.slug || ""),
          label: String(role.display_name || role.slug || ""),
          description: String(role.slug || "")
        }))
      ];

      supervisorRoleSelect.innerHTML = "";
      for (const option of options) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.description
          ? option.label + " (" + option.description + ")"
          : option.label;
        supervisorRoleSelect.appendChild(el);
      }

      const availableValues = new Set(options.map((opt) => opt.value));
      supervisorRoleSelect.value = availableValues.has(assignedRoleSlug)
        ? assignedRoleSlug
        : "";
      supervisorRoleSelect.disabled = disabled;
      refreshSupervisorRolesBtn.disabled = disabled;
      refreshSupervisorRolesBtn.textContent = loading ? "Refreshing..." : "Refresh Roles";

      const registrySource = String(catalog.registrySource || "");
      const registryVersion = String(catalog.registryVersion || "");
      const error = String(catalog.error || "");
      const fetchedAtMs = Number(catalog.fetchedAtMs || 0);
      const freshness = fetchedAtMs > 0
        ? new Date(fetchedAtMs).toLocaleTimeString()
        : "never";
      const titleParts = [
        registrySource ? "source=" + registrySource : "",
        registryVersion ? "version=" + registryVersion : "",
        "roles=" + roles.length,
        "last_refresh=" + freshness,
        error ? "error=" + error : ""
      ].filter(Boolean);
      supervisorRoleSelect.title = titleParts.join(" | ");
      refreshSupervisorRolesBtn.title = supervisorRoleSelect.title;
    }

    function renderSettings(force) {
      const settings = state.settings || {};
      const values = settings.values || {};
      const sources = settings.sources || {};
      const fields = Array.isArray(settings.fields) ? settings.fields : [];
      const supportedKeys = fields.map((f) => f.key).join(", ");
      settingsNoteEl.textContent = supportedKeys
        ? "Editable keys: " + supportedKeys + "\\nSave scope 'Effective source' writes each key back to where it currently comes from."
        : "No editable settings metadata received.";

      const workspaceAvailable = Boolean(settings.hasWorkspace);
      const chosenScope = settingsScopeEl.value || "effective";
      if (!workspaceAvailable && chosenScope === "workspace") {
        settingsScopeEl.value = "effective";
      }
      settingsScopeEl.querySelector('option[value=\"workspace\"]').disabled = !workspaceAvailable;

      if (force || !settingsDirty) {
        settingsJsonEl.value = JSON.stringify(values, null, 2);
        settingsDirty = false;
      }
      settingsStatusEl.textContent =
        "Workspace scope available: " +
        (workspaceAvailable ? "yes" : "no") +
        " | effective sources: " +
        summarizeSettingSources(sources);
    }

    function render(forceSettings) {
      renderLayout();
      renderSessions();
      renderMessages();
      renderBusyState();
      renderSupervisorRoleAssignment();
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

    escalateBtn.addEventListener("click", () => {
      if (state.busy) return;
      const active = activeSession();
      if (!active) return;
      vscode.postMessage({ type: "escalateToSupervisor" });
    });

    supervisorRoleSelect.addEventListener("change", () => {
      const roleSlug = supervisorRoleSelect.value || "";
      vscode.postMessage({ type: "assignSupervisorRole", roleSlug: roleSlug });
    });

    refreshSupervisorRolesBtn.addEventListener("click", () => {
      if (state.busy) {
        return;
      }
      vscode.postMessage({ type: "refreshSupervisorRoleCatalog" });
    });

    toggleSessionsBtn.addEventListener("click", () => {
      uiState.sessionsCollapsed = !uiState.sessionsCollapsed;
      render(false);
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
        scope: settingsScopeEl.value || "effective",
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
