"use strict";

const crypto = require("crypto");
const { McpHttpClient } = require("./mcp-client");

const SUPERVISOR_WRAPPER_TOOL_NAME = "request_codex_supervisor_decision";

const INTERNAL_SUPERVISOR_TOOL_NAMES = new Set([
  "ask_codex_supervisor",
  "dispatch_role_task",
  "submit_supervisor_question",
  "respond_supervisor_question",
  "list_pending_supervisor_questions",
  "list_role_catalog",
  "get_supervisor_role_context"
]);

const ALLOWED_CURRENT_PHASE = new Set([
  "discovery",
  "classification",
  "validation",
  "reporting"
]);
const ALLOWED_BLOCKED_REASON = new Set([
  "tool_error",
  "ambiguous_result",
  "policy_conflict",
  "insufficient_context",
  "repeated_failure"
]);
const ALLOWED_REQUESTED_DECISION = new Set([
  "next_step",
  "prioritize",
  "deconflict",
  "stop_or_continue"
]);
const TERMINAL_DECISIONS = new Set(["pause_for_human", "stop"]);

const DEFAULT_SCOPE_ID = "extension-supervisor-scope";
const DEFAULT_TARGETS = ["workspace"];
const DEFAULT_REQUESTED_DECISION = "next_step";
const DEFAULT_ESCALATION_REASON = "needs_supervisor_decision";
const DEFAULT_SUPERVISOR_LOG_LEVEL = "normal";
const SUPERVISOR_LOG_PREFIX = "[joshgpt:supervisor]";
const SUPERVISOR_LOG_LEVELS = new Set(["off", "normal", "verbose"]);
const EXCERPT_FIELD_NAMES = new Set(["agents_excerpt", "runtime_policy_excerpt"]);
const REDACTED = "<redacted>";

function asString(value) {
  return String(value || "").trim();
}

function normalizeSupervisorLogLevel(value) {
  const normalized = asString(value).toLowerCase();
  if (SUPERVISOR_LOG_LEVELS.has(normalized)) {
    return normalized;
  }
  return DEFAULT_SUPERVISOR_LOG_LEVEL;
}

function isSensitiveFieldName(keyName) {
  const key = asString(keyName).toLowerCase();
  return (
    key.includes("token") ||
    key.includes("secret") ||
    key.includes("password") ||
    key.includes("authorization") ||
    key.includes("api_key") ||
    key.includes("apikey") ||
    key.includes("private_key") ||
    key.includes("cookie")
  );
}

function sanitizeSupervisorTelemetry(value, keyName = "") {
  if (isSensitiveFieldName(keyName)) {
    return REDACTED;
  }

  if (value === null || typeof value === "undefined") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSupervisorTelemetry(item, keyName));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (EXCERPT_FIELD_NAMES.has(String(k))) {
        const text = String(v || "");
        out[`${k}_chars`] = text.length;
        continue;
      }
      out[k] = sanitizeSupervisorTelemetry(v, k);
    }
    return out;
  }

  if (typeof value === "string") {
    if (EXCERPT_FIELD_NAMES.has(String(keyName))) {
      return `<omitted chars=${value.length}>`;
    }
    if (value.length > 500) {
      return `${value.slice(0, 500)}...[truncated]`;
    }
  }

  return value;
}

function emitSupervisorLog(output, logLevel, eventName, payload = {}, options = {}) {
  if (!output || typeof output.appendLine !== "function") {
    return;
  }
  const resolvedLevel = normalizeSupervisorLogLevel(logLevel);
  if (resolvedLevel === "off") {
    return;
  }
  if (options.verboseOnly && resolvedLevel !== "verbose") {
    return;
  }

  const safePayload = sanitizeSupervisorTelemetry(payload);
  let suffix = "";
  try {
    const text = JSON.stringify(safePayload);
    if (text && text !== "{}") {
      suffix = ` ${text}`;
    }
  } catch {
    suffix = "";
  }
  output.appendLine(`${SUPERVISOR_LOG_PREFIX} ${asString(eventName)}${suffix}`);
}

function emitSupervisorTelemetry(telemetry, correlation, eventName, payload = {}) {
  if (!telemetry || typeof telemetry.log !== "function") {
    return;
  }
  const safePayload = sanitizeSupervisorTelemetry(payload);
  telemetry.log({
    event: `supervisor.${asString(eventName) || "event"}`,
    message: String(safePayload.message || eventName || "Supervisor event"),
    chat_session_id: String(correlation.chatSessionId || "unknown"),
    turn_id: String(correlation.turnId || "unknown"),
    request_id: String(safePayload.request_id || ""),
    tool_call_id: String(correlation.toolCallId || ""),
    component: "supervisor-wrapper",
    operation: String(safePayload.operation || "supervisor"),
    status: String(safePayload.status || ""),
    attrs: safePayload
  });
}

function asStringList(value, maxItems = 20) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  for (const item of value) {
    const text = asString(item);
    if (!text) {
      continue;
    }
    out.push(text);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function chooseEnum(value, allowed, fallback) {
  const normalized = asString(value).toLowerCase();
  if (allowed.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function isoUtcNow(now) {
  return now.toISOString();
}

function isoUtcPlusHours(now, hours) {
  return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function abbreviate(text, maxChars = 220) {
  const normalized = asString(text).replace(/\s+/g, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function chooseList(primary, fallback, maxItems = 20) {
  const first = asStringList(primary, maxItems);
  if (first.length) {
    return first;
  }
  return asStringList(fallback, maxItems);
}

function normalizeQuestionForHash(input) {
  return asString(input)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 2000);
}

function tryParseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore parse failures and return null.
  }
  return null;
}

function unwrapToolResult(raw) {
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
        const parsed = tryParseJsonObject(item.text);
        if (parsed) {
          return parsed;
        }
      }
    }
  }

  if (raw.result && typeof raw.result === "object") {
    return raw.result;
  }

  return raw;
}

function asRoleList(rawRoles) {
  if (!Array.isArray(rawRoles)) {
    return [];
  }
  const normalized = [];
  for (const role of rawRoles) {
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
    normalized.push({
      slug,
      display_name: displayName,
      repo_name: repoName,
      menu_order: menuOrder
    });
  }
  normalized.sort((a, b) => {
    if (a.menu_order !== b.menu_order) {
      return a.menu_order - b.menu_order;
    }
    return a.slug.localeCompare(b.slug);
  });
  return normalized;
}

function normalizeRoleCatalog(raw) {
  const payload = unwrapToolResult(raw);
  const registrySource = asString(payload.registry_source);
  const registryVersion = asString(payload.registry_version);
  const roles = asRoleList(payload.roles);
  if (!registrySource || !registryVersion || !roles.length) {
    throw new Error("Dispatcher returned invalid role catalog payload.");
  }
  return {
    registry_source: registrySource,
    registry_version: registryVersion,
    roles
  };
}

function normalizeInstructionContext(raw) {
  const payload = unwrapToolResult(raw);
  const instruction = payload && payload.instruction_context && typeof payload.instruction_context === "object"
    ? payload.instruction_context
    : {};
  const normalized = {
    role_slug: asString(instruction.role_slug),
    role_display_name: asString(instruction.role_display_name),
    registry_source: asString(instruction.registry_source),
    registry_version: asString(instruction.registry_version),
    context_ref: asString(instruction.context_ref),
    context_sha256: asString(instruction.context_sha256),
    agents_excerpt: String(instruction.agents_excerpt || ""),
    runtime_policy_excerpt: String(instruction.runtime_policy_excerpt || ""),
    runtime_policy_ref: asString(instruction.runtime_policy_ref),
    runtime_policy_sha256: asString(instruction.runtime_policy_sha256)
  };

  const requiredKeys = [
    "role_slug",
    "role_display_name",
    "registry_source",
    "registry_version",
    "context_ref",
    "context_sha256",
    "runtime_policy_ref",
    "runtime_policy_sha256"
  ];
  for (const key of requiredKeys) {
    if (!asString(normalized[key])) {
      throw new Error(`Dispatcher returned invalid instruction_context.${key}.`);
    }
  }
  return normalized;
}

function resolveEffectiveSupervisorRole({
  assignedRoleSlug = "",
  profileSupervisorRoleSlug = "",
  catalog
}) {
  const roles = catalog && Array.isArray(catalog.roles) ? catalog.roles : [];
  const roleBySlug = new Map(roles.map((role) => [role.slug, role]));
  const assigned = asString(assignedRoleSlug);
  const profile = asString(profileSupervisorRoleSlug);

  if (assigned && roleBySlug.has(assigned)) {
    return {
      selected_role_slug: assigned,
      selection_source: "assigned_setting",
      role: roleBySlug.get(assigned)
    };
  }
  if (profile && roleBySlug.has(profile)) {
    return {
      selected_role_slug: profile,
      selection_source: "supervision_profile",
      role: roleBySlug.get(profile)
    };
  }

  return {
    selected_role_slug: "",
    selection_source: "none",
    role: null,
    error: assigned
      ? `Assigned supervisor role is not in registry: ${assigned}.`
      : "No valid supervisor role resolved from assignment/profile."
  };
}

function buildPauseForHumanDecision(reason, nextActions = []) {
  const fallbackNextActions = nextActions.length
    ? nextActions
    : [
        "Review the escalation context and confirm supervisor endpoints are reachable.",
        "Verify dispatcher/supervisor shared tokens are present in extension environment.",
        "Retry escalation after resolving runtime/auth issues."
      ];
  return {
    decision: "pause_for_human",
    rationale: `Supervisor wrapper fail-safe: ${asString(reason) || "manual review required."}`,
    next_actions: fallbackNextActions,
    confidence: 0.1,
    safety_checks: [
      "Token handling remained extension-local",
      "Escalation payload captured",
      "Human review required before continuation"
    ],
    audit_tags: ["fail-safe", "supervisor-wrapper"]
  };
}

function asSupervisorDecisionPayload(raw, reasonIfInvalid = "") {
  const decision = unwrapToolResult(raw);
  if (
    decision &&
    typeof decision === "object" &&
    typeof decision.decision === "string" &&
    typeof decision.rationale === "string" &&
    Array.isArray(decision.next_actions) &&
    Number.isFinite(Number(decision.confidence)) &&
    Array.isArray(decision.safety_checks)
  ) {
    return {
      ...decision,
      confidence: Number(decision.confidence)
    };
  }
  return buildPauseForHumanDecision(
    reasonIfInvalid || "Supervisor returned malformed decision payload."
  );
}

function buildWrapperResult({
  ok,
  taskId = "",
  messageId = "",
  decisionPayload,
  error = "",
  dispatcherSummary = {}
}) {
  const decision = asSupervisorDecisionPayload(
    decisionPayload,
    error || "No valid supervisor decision was returned."
  );
  const terminal = TERMINAL_DECISIONS.has(String(decision.decision || "").toLowerCase());
  return {
    ok: Boolean(ok),
    action: terminal ? "terminate" : "continue",
    terminal,
    task_id: asString(taskId),
    message_id: asString(messageId),
    decision,
    dispatcher: dispatcherSummary,
    error: asString(error)
  };
}

function buildGuardrailBlockedWrapperResult(reason) {
  return buildWrapperResult({
    ok: false,
    error: asString(reason) || "Supervisor escalation blocked by policy guardrail.",
    decisionPayload: buildPauseForHumanDecision(
      asString(reason) || "Supervisor escalation blocked by policy guardrail.",
      [
        "Review recent escalation attempts in trace logs.",
        "Adjust supervisor guardrail settings if tighter policy is unintended.",
        "Retry escalation after cooldown or with materially new context."
      ]
    )
  });
}

function buildGuardedSupervisorMessage(wrapperResult) {
  const decision = (wrapperResult && wrapperResult.decision) || {};
  const nextActions = Array.isArray(decision.next_actions) ? decision.next_actions : [];
  const lines = [];
  lines.push(`Supervisor decision: ${asString(decision.decision) || "pause_for_human"}`);
  if (asString(decision.rationale)) {
    lines.push(`Rationale: ${asString(decision.rationale)}`);
  }
  if (nextActions.length > 0) {
    lines.push("Required next actions:");
    let index = 1;
    for (const action of nextActions) {
      lines.push(`${index}. ${String(action)}`);
      index += 1;
    }
  }
  lines.push("Execution paused pending supervisor/human direction.");
  return lines.join("\n");
}

function getSupervisorWrapperOpenAiTool() {
  return {
    type: "function",
    function: {
      name: SUPERVISOR_WRAPPER_TOOL_NAME,
      description:
        "Escalate to Codex supervisor through extension-managed dispatcher/capability services. " +
        "Use when blocked or when a supervisory decision is required.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          escalation_reason: { type: "string" },
          blocked_reason: {
            type: "string",
            enum: [
              "tool_error",
              "ambiguous_result",
              "policy_conflict",
              "insufficient_context",
              "repeated_failure"
            ]
          },
          current_phase: {
            type: "string",
            enum: ["discovery", "classification", "validation", "reporting"]
          },
          attempt_history: { type: "array", items: { type: "string" }, maxItems: 20 },
          evidence_summary: { type: "string" },
          requested_decision: {
            type: "string",
            enum: ["next_step", "prioritize", "deconflict", "stop_or_continue"]
          }
        },
        required: ["question"]
      }
    }
  };
}

function resolveGuardrailPolicy(policy = {}) {
  const maxPerTurn = Math.max(1, Number(policy.maxPerTurn) || 1);
  const maxPerSession = Math.max(1, Number(policy.maxPerSession) || 3);
  const cooldownMs = Math.max(0, Number(policy.cooldownMs) || 15000);
  return {
    maxPerTurn,
    maxPerSession,
    cooldownMs
  };
}

function evaluateSupervisorEscalationGuardrails({
  input,
  state = {},
  policy = {},
  nowMs = Date.now()
} = {}) {
  const rules = resolveGuardrailPolicy(policy);
  const currentState = {
    turnEscalationCount: Math.max(0, Number(state.turnEscalationCount) || 0),
    sessionEscalationCount: Math.max(0, Number(state.sessionEscalationCount) || 0),
    lastEscalationAtMs: Math.max(0, Number(state.lastEscalationAtMs) || 0),
    lastEscalationQuestionHash: asString(state.lastEscalationQuestionHash)
  };
  const question = asString(input && input.question);
  if (!question) {
    return {
      allowed: false,
      reason: "Supervisor escalation requires a non-empty question.",
      state: currentState
    };
  }
  if (currentState.turnEscalationCount >= rules.maxPerTurn) {
    return {
      allowed: false,
      reason: `Supervisor escalation blocked: per-turn limit reached (${rules.maxPerTurn}).`,
      state: currentState
    };
  }
  if (currentState.sessionEscalationCount >= rules.maxPerSession) {
    return {
      allowed: false,
      reason: `Supervisor escalation blocked: per-session limit reached (${rules.maxPerSession}).`,
      state: currentState
    };
  }

  if (rules.cooldownMs > 0 && currentState.lastEscalationAtMs > 0) {
    const elapsedMs = nowMs - currentState.lastEscalationAtMs;
    if (elapsedMs < rules.cooldownMs) {
      const hash = sha256Hex(normalizeQuestionForHash(question));
      if (hash === currentState.lastEscalationQuestionHash) {
        return {
          allowed: false,
          reason:
            "Supervisor escalation blocked: duplicate escalation during cooldown window.",
          state: currentState
        };
      }
      return {
        allowed: false,
        reason: `Supervisor escalation blocked: cooldown active (${rules.cooldownMs}ms).`,
        state: currentState
      };
    }
  }

  const nextState = {
    turnEscalationCount: currentState.turnEscalationCount + 1,
    sessionEscalationCount: currentState.sessionEscalationCount + 1,
    lastEscalationAtMs: nowMs,
    lastEscalationQuestionHash: sha256Hex(normalizeQuestionForHash(question))
  };
  return {
    allowed: true,
    reason: "",
    state: nextState
  };
}

function buildEffectiveEscalationContext(
  input,
  { supervisionProfile, sessionContext = {}, now = new Date() } = {}
) {
  const profile = supervisionProfile || {};
  const objective =
    asString(input.objective) ||
    asString(sessionContext.objective) ||
    abbreviate(asString(input.question), 220) ||
    "Resolve current blocker with supervisor guidance.";
  const roleContextRef =
    asString(input.role_context_ref) ||
    asString(sessionContext.roleContextRef) ||
    "workspace://AGENTS.md";
  const constraints = chooseList(input.constraints, sessionContext.constraints, 20);
  const inputRefs = chooseList(input.input_refs, sessionContext.inputRefs, 20);
  const attemptHistory = chooseList(
    input.attempt_history,
    sessionContext.attemptHistory,
    20
  );
  const authorizedTargets = chooseList(
    profile.authorizedTargets,
    DEFAULT_TARGETS,
    20
  );

  return {
    missionId: asString(input.mission_id || sessionContext.missionId) || crypto.randomUUID(),
    workerRoleSlug: asString(profile.workerRoleSlug),
    supervisorRoleSlug: asString(profile.supervisorRoleSlug),
    objective,
    escalationReason:
      asString(input.escalation_reason) ||
      asString(sessionContext.escalationReason) ||
      DEFAULT_ESCALATION_REASON,
    question: asString(input.question),
    roleContextRef,
    constraints,
    inputRefs,
    currentPhase: chooseEnum(
      input.current_phase || sessionContext.currentPhase,
      ALLOWED_CURRENT_PHASE,
      "validation"
    ),
    blockedReason: chooseEnum(
      input.blocked_reason || sessionContext.blockedReason,
      ALLOWED_BLOCKED_REASON,
      "insufficient_context"
    ),
    attemptHistory,
    evidenceSummary:
      asString(input.evidence_summary) || asString(sessionContext.evidenceSummary),
    authorizedScopeId: asString(profile.authorizedScopeId) || DEFAULT_SCOPE_ID,
    authorizedTargets,
    authorizedExpiresUtc:
      asString(input.authorized_expires_utc || sessionContext.authorizedExpiresUtc) ||
      isoUtcPlusHours(now, 1),
    requestedDecision: chooseEnum(
      input.requested_decision ||
        sessionContext.requestedDecision ||
        profile.requestedDecisionDefault,
      ALLOWED_REQUESTED_DECISION,
      DEFAULT_REQUESTED_DECISION
    )
  };
}

function buildDispatcherTaskPayload(context, correlation = null) {
  const payload = {
    task_id: context.missionId,
    worker_role_slug: context.workerRoleSlug,
    supervisor_role_slug: context.supervisorRoleSlug,
    objective: context.objective,
    constraints: context.constraints,
    input_refs: context.inputRefs
  };
  if (correlation && typeof correlation === "object") {
    payload.correlation = correlation;
  }
  return payload;
}

function buildSupervisorRequestPayload(context, instructionContext, correlation = null) {
  const payload = {
    mission_id: context.missionId,
    goal: context.objective,
    current_phase: context.currentPhase,
    blocked_reason: context.blockedReason,
    attempt_history: context.attemptHistory,
    evidence_summary: context.evidenceSummary,
    constraints: context.constraints,
    authorized_scope: {
      scope_id: context.authorizedScopeId,
      targets: context.authorizedTargets,
      expires_utc: context.authorizedExpiresUtc
    },
    requested_decision: context.requestedDecision,
    supervisor_context: {
      instruction_context: instructionContext
    }
  };
  if (correlation && typeof correlation === "object") {
    payload.correlation = correlation;
  }
  return payload;
}

function buildSupervisorQuestionPayload(context, taskId, instructionContext, correlation = null) {
  const instructionContextRef = asString(instructionContext && instructionContext.context_ref);
  const instructionContextHash = asString(instructionContext && instructionContext.context_sha256);
  const payload = {
    task_id: asString(taskId),
    from_role_slug: context.workerRoleSlug,
    to_supervisor_role_slug: context.supervisorRoleSlug,
    escalation_reason: context.escalationReason,
    question: context.question,
    role_context_ref: instructionContextRef || context.roleContextRef,
    role_context_sha256:
      instructionContextHash ||
      sha256Hex(`${context.roleContextRef}\n${context.objective}\n${context.question}`)
  };
  if (correlation && typeof correlation === "object") {
    payload.correlation = correlation;
  }
  return payload;
}

async function runSupervisorWrapperToolCall(
  input,
  {
    dispatcherBaseUrl,
    capabilityBaseUrl,
    timeoutMs = 15000,
    output = null,
    env = process.env,
    supervisionProfile = null,
    supervisionProfileSource = "",
    assignedSupervisorRoleSlug = "",
    logLevel = DEFAULT_SUPERVISOR_LOG_LEVEL,
    invocationSource = "model_tool",
    sessionContext = {},
    telemetry = null,
    correlation = {},
    mcpClientFactory = (options) => new McpHttpClient(options),
    nowFactory = () => new Date()
  } = {}
) {
  const startedAtMs = Date.now();
  const resolvedLogLevel = normalizeSupervisorLogLevel(logLevel);
  const dispatcherToken = asString(env.JOSHGPT_DISPATCHER_SHARED_TOKEN);
  const supervisorToken = asString(env.JOSHGPT_SUPERVISOR_SHARED_TOKEN);
  const dispatcherUrl = asString(dispatcherBaseUrl);
  const supervisorUrl = asString(capabilityBaseUrl);
  const questionPreview = abbreviate(asString(input && input.question), 220);
  const profileSupervisorRoleSlug = asString(
    supervisionProfile && supervisionProfile.supervisorRoleSlug
  );
  const profileWorkerRoleSlug = asString(
    supervisionProfile && supervisionProfile.workerRoleSlug
  );
  const resolvedCorrelation = {
    chatSessionId: asString(correlation.chatSessionId) || "unknown",
    turnId: asString(correlation.turnId) || "unknown",
    toolCallId: asString(correlation.toolCallId) || "",
    requestIdFactory:
      typeof correlation.requestIdFactory === "function"
        ? correlation.requestIdFactory
        : null
  };
  const nextRequestId = () => {
    if (typeof resolvedCorrelation.requestIdFactory === "function") {
      const external = asString(resolvedCorrelation.requestIdFactory());
      if (external) {
        return external;
      }
    }
    return `req-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  };
  const nextCorrelationPayload = () => {
    const payload = {
      chat_session_id: resolvedCorrelation.chatSessionId,
      turn_id: resolvedCorrelation.turnId,
      request_id: nextRequestId()
    };
    if (resolvedCorrelation.toolCallId) {
      payload.tool_call_id = resolvedCorrelation.toolCallId;
    }
    return payload;
  };

  emitSupervisorLog(output, resolvedLogLevel, "escalation_start", {
    invocation_source: asString(invocationSource) || "model_tool",
    question_preview: questionPreview,
    assigned_supervisor_role_slug: asString(assignedSupervisorRoleSlug),
    profile_supervisor_role_slug: profileSupervisorRoleSlug,
    profile_worker_role_slug: profileWorkerRoleSlug
  });
  emitSupervisorTelemetry(telemetry, resolvedCorrelation, "escalation_start", {
    operation: "supervisor",
    status: "start",
    invocation_source: asString(invocationSource) || "model_tool",
    question_preview: questionPreview
  });

  const stageDurations = {};
  let stage = "preflight";
  let taskId = "";
  let messageId = "";

  const fail = (reason, stageName = stage) => {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    emitSupervisorLog(output, resolvedLogLevel, "escalation_failed", {
      stage: asString(stageName),
      error: asString(reason),
      duration_ms: durationMs,
      task_id: taskId,
      message_id: messageId
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "escalation_failed_details",
      {
        stage: asString(stageName),
        stage_durations_ms: stageDurations,
        total_duration_ms: durationMs
      },
      { verboseOnly: true }
    );
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "escalation_failed", {
      operation: asString(stageName) || "supervisor",
      status: "error",
      message: asString(reason),
      duration_ms: durationMs,
      task_id: taskId,
      message_id: messageId
    });
    return buildWrapperResult({
      ok: false,
      taskId,
      messageId,
      error: asString(reason)
    });
  };

  const runStage = async (stageName, fn) => {
    stage = asString(stageName) || "stage";
    const stageStartMs = Date.now();
    try {
      return await fn();
    } finally {
      stageDurations[stage] = Math.max(0, Date.now() - stageStartMs);
    }
  };

  if (!dispatcherUrl || !supervisorUrl) {
    return fail(
      "Supervisor wrapper is enabled but dispatcher/capability base URLs are missing.",
      "preflight"
    );
  }
  if (!dispatcherToken || !supervisorToken) {
    return fail(
      "Supervisor wrapper requires JOSHGPT_DISPATCHER_SHARED_TOKEN and JOSHGPT_SUPERVISOR_SHARED_TOKEN.",
      "preflight"
    );
  }

  const now = nowFactory();
  stage = "context_build";
  const context = buildEffectiveEscalationContext(input, {
    supervisionProfile,
    sessionContext,
    now
  });
  if (!context.workerRoleSlug) {
    return fail(
      "Supervisor wrapper requires resolved worker role binding in supervision profile.",
      "context_build"
    );
  }
  if (!context.objective) {
    return fail(
      "Supervisor wrapper could not derive an objective from session context.",
      "context_build"
    );
  }
  if (!context.question) {
    return fail(
      "Supervisor wrapper requires a non-empty question.",
      "context_build"
    );
  }

  const dispatcherClient = mcpClientFactory({
    baseUrl: dispatcherUrl,
    timeoutMs,
    output,
    correlation: {
      chatSessionId: resolvedCorrelation.chatSessionId,
      turnId: resolvedCorrelation.turnId
    },
    requestIdFactory: resolvedCorrelation.requestIdFactory,
    telemetry
  });
  const supervisorClient = mcpClientFactory({
    baseUrl: supervisorUrl,
    timeoutMs,
    output,
    correlation: {
      chatSessionId: resolvedCorrelation.chatSessionId,
      turnId: resolvedCorrelation.turnId
    },
    requestIdFactory: resolvedCorrelation.requestIdFactory,
    telemetry
  });

  let roleCatalog = null;
  let roleSelection = null;
  let instructionContext = null;

  try {
    roleCatalog = await runStage("catalog_lookup", async () => {
      const requestCorrelation = nextCorrelationPayload();
      const roleCatalogRaw = await dispatcherClient.callTool("list_role_catalog", {
        shared_token: dispatcherToken,
        correlation: requestCorrelation
      }, {
        toolCallId: resolvedCorrelation.toolCallId,
        requestId: requestCorrelation.request_id
      });
      return normalizeRoleCatalog(roleCatalogRaw);
    });
    emitSupervisorLog(output, resolvedLogLevel, "catalog_loaded", {
      role_count: Array.isArray(roleCatalog.roles) ? roleCatalog.roles.length : 0,
      registry_source: roleCatalog.registry_source,
      registry_version: roleCatalog.registry_version
    });
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "catalog_loaded", {
      operation: "catalog_lookup",
      status: "ok",
      role_count: Array.isArray(roleCatalog.roles) ? roleCatalog.roles.length : 0
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "catalog_loaded_details",
      {
        duration_ms: stageDurations.catalog_lookup,
        role_slugs: (roleCatalog.roles || []).map((role) => role.slug)
      },
      { verboseOnly: true }
    );

    roleSelection = await runStage("role_selection", async () =>
      resolveEffectiveSupervisorRole({
        assignedRoleSlug: assignedSupervisorRoleSlug,
        profileSupervisorRoleSlug: context.supervisorRoleSlug,
        catalog: roleCatalog
      })
    );
    emitSupervisorLog(output, resolvedLogLevel, "role_selected", {
      selected_supervisor_role_slug: roleSelection.selected_role_slug,
      selection_source: roleSelection.selection_source
    });
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "role_selected", {
      operation: "role_selection",
      status: "ok",
      selected_supervisor_role_slug: roleSelection.selected_role_slug,
      selection_source: roleSelection.selection_source
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "role_selected_details",
      {
        duration_ms: stageDurations.role_selection
      },
      { verboseOnly: true }
    );

    if (!roleSelection.selected_role_slug) {
      throw new Error(
        roleSelection.error ||
          "Supervisor wrapper could not resolve a registry-backed supervisor role."
      );
    }
    context.supervisorRoleSlug = roleSelection.selected_role_slug;

    instructionContext = await runStage("context_lookup", async () => {
      const requestCorrelation = nextCorrelationPayload();
      const instructionContextRaw = await dispatcherClient.callTool(
        "get_supervisor_role_context",
        {
          role_slug: context.supervisorRoleSlug,
          shared_token: dispatcherToken,
          correlation: requestCorrelation
        },
        {
          toolCallId: resolvedCorrelation.toolCallId,
          requestId: requestCorrelation.request_id
        }
      );
      const normalized = normalizeInstructionContext(instructionContextRaw);
      if (normalized.role_slug !== context.supervisorRoleSlug) {
        throw new Error(
          "Dispatcher returned instruction context for a different supervisor role."
        );
      }
      return normalized;
    });
    emitSupervisorLog(output, resolvedLogLevel, "context_loaded", {
      instruction_context_role_slug: instructionContext.role_slug,
      context_ref: instructionContext.context_ref,
      context_sha256: instructionContext.context_sha256
    });
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "context_loaded", {
      operation: "context_lookup",
      status: "ok",
      instruction_context_role_slug: instructionContext.role_slug,
      context_ref: instructionContext.context_ref
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "context_loaded_details",
      {
        duration_ms: stageDurations.context_lookup,
        runtime_policy_ref: instructionContext.runtime_policy_ref,
        runtime_policy_sha256: instructionContext.runtime_policy_sha256,
        agents_excerpt: instructionContext.agents_excerpt,
        runtime_policy_excerpt: instructionContext.runtime_policy_excerpt
      },
      { verboseOnly: true }
    );

    const dispatchResponse = await runStage("task_dispatch", async () => {
      const requestCorrelation = nextCorrelationPayload();
      const taskPayload = buildDispatcherTaskPayload(context, requestCorrelation);
      const dispatchResponseRaw = await dispatcherClient.callTool("dispatch_role_task", {
        payload: taskPayload,
        shared_token: dispatcherToken
      }, {
        toolCallId: resolvedCorrelation.toolCallId,
        requestId: requestCorrelation.request_id
      });
      const parsed = unwrapToolResult(dispatchResponseRaw);
      taskId = asString(parsed.task_id || taskPayload.task_id);
      if (!taskId) {
        throw new Error("Dispatcher did not return task_id.");
      }
      return parsed;
    });
    emitSupervisorLog(output, resolvedLogLevel, "task_dispatched", {
      task_id: taskId,
      status: asString(dispatchResponse.status || "queued")
    });
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "task_dispatched", {
      operation: "task_dispatch",
      status: asString(dispatchResponse.status || "queued"),
      task_id: taskId
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "task_dispatched_details",
      {
        duration_ms: stageDurations.task_dispatch,
        response: dispatchResponse
      },
      { verboseOnly: true }
    );

    const questionResponse = await runStage("question_submit", async () => {
      const requestCorrelation = nextCorrelationPayload();
      const questionPayload = buildSupervisorQuestionPayload(
        context,
        taskId,
        instructionContext,
        requestCorrelation
      );
      const questionResponseRaw = await dispatcherClient.callTool(
        "submit_supervisor_question",
        {
          ...questionPayload,
          shared_token: dispatcherToken
        },
        {
          toolCallId: resolvedCorrelation.toolCallId,
          requestId: requestCorrelation.request_id
        }
      );
      const parsed = unwrapToolResult(questionResponseRaw);
      messageId = asString(parsed.message_id);
      if (!messageId) {
        throw new Error("Dispatcher did not return message_id.");
      }
      return parsed;
    });
    emitSupervisorLog(output, resolvedLogLevel, "question_submitted", {
      message_id: messageId,
      status: asString(questionResponse.status || "pending")
    });
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "question_submitted", {
      operation: "question_submit",
      status: asString(questionResponse.status || "pending"),
      task_id: taskId,
      message_id: messageId
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "question_submitted_details",
      {
        duration_ms: stageDurations.question_submit,
        response: questionResponse
      },
      { verboseOnly: true }
    );

    const supervisorDecision = await runStage("supervisor_decision", async () => {
      const requestCorrelation = nextCorrelationPayload();
      const supervisorDecisionRaw = await supervisorClient.callTool(
        "ask_codex_supervisor",
        {
          payload: buildSupervisorRequestPayload(
            context,
            instructionContext,
            requestCorrelation
          ),
          correlation: requestCorrelation,
          shared_token: supervisorToken
        },
        {
          toolCallId: resolvedCorrelation.toolCallId,
          requestId: requestCorrelation.request_id
        }
      );
      return asSupervisorDecisionPayload(
        supervisorDecisionRaw,
        "Supervisor capability returned malformed payload."
      );
    });
    const decisionName = asString(supervisorDecision.decision).toLowerCase();
    const terminal = TERMINAL_DECISIONS.has(decisionName);
    emitSupervisorLog(output, resolvedLogLevel, "supervisor_decision_received", {
      decision: decisionName || "pause_for_human",
      confidence: Number(supervisorDecision.confidence || 0),
      terminal,
      action: terminal ? "terminate" : "continue"
    });
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "supervisor_decision_received", {
      operation: "supervisor_decision",
      status: "ok",
      task_id: taskId,
      message_id: messageId,
      decision: decisionName || "pause_for_human",
      action: terminal ? "terminate" : "continue"
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "supervisor_decision_received_details",
      {
        duration_ms: stageDurations.supervisor_decision,
        decision_payload: supervisorDecision
      },
      { verboseOnly: true }
    );

    const responseAck = await runStage("decision_record", async () => {
      const requestCorrelation = nextCorrelationPayload();
      const responseAckRaw = await dispatcherClient.callTool("respond_supervisor_question", {
        message_id: messageId,
        supervisor_role_slug: context.supervisorRoleSlug,
        decision_payload: supervisorDecision,
        correlation: requestCorrelation,
        shared_token: dispatcherToken
      }, {
        toolCallId: resolvedCorrelation.toolCallId,
        requestId: requestCorrelation.request_id
      });
      return unwrapToolResult(responseAckRaw);
    });
    emitSupervisorLog(output, resolvedLogLevel, "decision_recorded", {
      response_status: asString(responseAck.status || "answered")
    });
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "decision_recorded", {
      operation: "decision_record",
      status: asString(responseAck.status || "answered"),
      task_id: taskId,
      message_id: messageId
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "decision_recorded_details",
      {
        duration_ms: stageDurations.decision_record,
        response: responseAck
      },
      { verboseOnly: true }
    );

    const result = buildWrapperResult({
      ok: true,
      taskId,
      messageId,
      decisionPayload: supervisorDecision,
      dispatcherSummary: {
        dispatch_status: asString(dispatchResponse.status || "queued"),
        question_status: asString(questionResponse.status || "pending"),
        response_status: asString(responseAck.status || "answered"),
        submitted_at: isoUtcNow(now),
        role_source: asString(supervisionProfileSource) || "unknown",
        selected_supervisor_role_slug: context.supervisorRoleSlug,
        role_selection_source: asString(roleSelection.selection_source) || "unknown",
        assigned_supervisor_role_slug: asString(assignedSupervisorRoleSlug),
        profile_supervisor_role_slug:
          asString(supervisionProfile && supervisionProfile.supervisorRoleSlug),
        registry_source: asString(roleCatalog && roleCatalog.registry_source),
        registry_version: asString(roleCatalog && roleCatalog.registry_version),
        instruction_context_ref: asString(instructionContext && instructionContext.context_ref),
        instruction_context_sha256: asString(
          instructionContext && instructionContext.context_sha256
        )
      }
    });
    const totalDurationMs = Math.max(0, Date.now() - startedAtMs);
    emitSupervisorLog(output, resolvedLogLevel, "escalation_complete", {
      task_id: taskId,
      message_id: messageId,
      action: result.action,
      terminal: result.terminal,
      duration_ms: totalDurationMs
    });
    emitSupervisorTelemetry(telemetry, resolvedCorrelation, "escalation_complete", {
      operation: "supervisor",
      status: "ok",
      task_id: taskId,
      message_id: messageId,
      action: result.action,
      terminal: result.terminal,
      duration_ms: totalDurationMs
    });
    emitSupervisorLog(
      output,
      resolvedLogLevel,
      "escalation_complete_details",
      {
        stage_durations_ms: stageDurations,
        total_duration_ms: totalDurationMs
      },
      { verboseOnly: true }
    );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(msg);
  }
}

module.exports = {
  SUPERVISOR_WRAPPER_TOOL_NAME,
  INTERNAL_SUPERVISOR_TOOL_NAMES,
  normalizeSupervisorLogLevel,
  sanitizeSupervisorTelemetry,
  emitSupervisorLog,
  getSupervisorWrapperOpenAiTool,
  evaluateSupervisorEscalationGuardrails,
  buildGuardrailBlockedWrapperResult,
  runSupervisorWrapperToolCall,
  buildGuardedSupervisorMessage
};
