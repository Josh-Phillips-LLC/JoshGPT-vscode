"use strict";

const vscode = require("vscode");
const { SessionStore } = require("./session-store");
const { runChatWithOptionalMcp } = require("./chat-runner");
const { resolveInheritedInstructions } = require("./instruction-resolver");
const { resolveSupervisionProfile } = require("./supervision-profile-resolver");
const { checkSupervisorReadiness } = require("./supervisor-readiness");
const {
  runSupervisorWrapperToolCall,
  evaluateSupervisorEscalationGuardrails,
  buildGuardrailBlockedWrapperResult,
  buildGuardedSupervisorMessage
} = require("./supervisor-wrapper-tool");

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
  { key: "supervisor.enabled", type: "boolean" },
  { key: "supervisor.modelEscalationEnabled", type: "boolean" },
  { key: "supervisor.dispatcherBaseUrl", type: "string" },
  { key: "supervisor.capabilityBaseUrl", type: "string" },
  { key: "supervisor.maxEscalationsPerTurn", type: "number", min: 1 },
  { key: "supervisor.maxEscalationsPerSession", type: "number", min: 1 },
  { key: "supervisor.escalationCooldownMs", type: "number", min: 0 },
  { key: "supervisor.workerRoleSlug", type: "string" },
  { key: "supervisor.supervisorRoleSlug", type: "string" },
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

  async escalateActiveSessionFromCommand() {
    await this._escalateToSupervisor();
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

    if (type === "escalateToSupervisor") {
      await this._escalateToSupervisor();
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

      const { text, trace } = await runChatWithOptionalMcp({
        config: {
          ...cfg,
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
      wrapperResult = buildGuardrailBlockedWrapperResult(
        `Missing supervision profile: ${profile.error || "role binding unavailable."}`
      );
    } else if (!readiness.ready) {
      wrapperResult = buildGuardrailBlockedWrapperResult(
        `Supervisor preflight blocked: ${readiness.summary}`
      );
    } else if (!guardrailEval.allowed) {
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
          sessionContext: supervisorSessionContext
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
      settings: { fields: [], values: {}, signature: "", hasWorkspace: false }
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
      renderLayout();
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

    escalateBtn.addEventListener("click", () => {
      if (state.busy) return;
      const active = activeSession();
      if (!active) return;
      vscode.postMessage({ type: "escalateToSupervisor" });
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
