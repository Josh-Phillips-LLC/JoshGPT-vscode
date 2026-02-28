"use strict";

const crypto = require("crypto");
const { McpHttpClient } = require("./mcp-client");

const SUPERVISOR_WRAPPER_TOOL_NAME = "request_codex_supervisor_decision";

const INTERNAL_SUPERVISOR_TOOL_NAMES = new Set([
  "ask_codex_supervisor",
  "dispatch_role_task",
  "submit_supervisor_question",
  "respond_supervisor_question",
  "list_pending_supervisor_questions"
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

function asString(value) {
  return String(value || "").trim();
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

function buildDispatcherTaskPayload(context) {
  return {
    task_id: context.missionId,
    worker_role_slug: context.workerRoleSlug,
    supervisor_role_slug: context.supervisorRoleSlug,
    objective: context.objective,
    constraints: context.constraints,
    input_refs: context.inputRefs
  };
}

function buildSupervisorRequestPayload(context) {
  return {
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
    requested_decision: context.requestedDecision
  };
}

function buildSupervisorQuestionPayload(context, taskId) {
  return {
    task_id: asString(taskId),
    from_role_slug: context.workerRoleSlug,
    to_supervisor_role_slug: context.supervisorRoleSlug,
    escalation_reason: context.escalationReason,
    question: context.question,
    role_context_ref: context.roleContextRef,
    role_context_sha256: sha256Hex(
      `${context.roleContextRef}\n${context.objective}\n${context.question}`
    )
  };
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
    sessionContext = {},
    mcpClientFactory = (options) => new McpHttpClient(options),
    nowFactory = () => new Date()
  } = {}
) {
  const dispatcherToken = asString(env.JOSHGPT_DISPATCHER_SHARED_TOKEN);
  const supervisorToken = asString(env.JOSHGPT_SUPERVISOR_SHARED_TOKEN);
  const dispatcherUrl = asString(dispatcherBaseUrl);
  const supervisorUrl = asString(capabilityBaseUrl);

  if (!dispatcherUrl || !supervisorUrl) {
    return buildWrapperResult({
      ok: false,
      error: "Supervisor wrapper is enabled but dispatcher/capability base URLs are missing."
    });
  }
  if (!dispatcherToken || !supervisorToken) {
    return buildWrapperResult({
      ok: false,
      error:
        "Supervisor wrapper requires JOSHGPT_DISPATCHER_SHARED_TOKEN and JOSHGPT_SUPERVISOR_SHARED_TOKEN."
    });
  }

  const now = nowFactory();
  const context = buildEffectiveEscalationContext(input, {
    supervisionProfile,
    sessionContext,
    now
  });
  if (!context.workerRoleSlug || !context.supervisorRoleSlug) {
    return buildWrapperResult({
      ok: false,
      error:
        "Supervisor wrapper requires resolved worker/supervisor role bindings in supervision profile."
    });
  }
  if (!context.objective) {
    return buildWrapperResult({
      ok: false,
      error: "Supervisor wrapper could not derive an objective from session context."
    });
  }
  if (!context.question) {
    return buildWrapperResult({
      ok: false,
      error: "Supervisor wrapper requires a non-empty question."
    });
  }

  const dispatcherClient = mcpClientFactory({
    baseUrl: dispatcherUrl,
    timeoutMs,
    output
  });
  const supervisorClient = mcpClientFactory({
    baseUrl: supervisorUrl,
    timeoutMs,
    output
  });

  let taskId = "";
  let messageId = "";

  try {
    const taskPayload = buildDispatcherTaskPayload(context);
    const dispatchResponseRaw = await dispatcherClient.callTool("dispatch_role_task", {
      payload: taskPayload,
      shared_token: dispatcherToken
    });
    const dispatchResponse = unwrapToolResult(dispatchResponseRaw);
    taskId = asString(dispatchResponse.task_id || taskPayload.task_id);
    if (!taskId) {
      throw new Error("Dispatcher did not return task_id.");
    }

    const questionPayload = buildSupervisorQuestionPayload(context, taskId);
    const questionResponseRaw = await dispatcherClient.callTool(
      "submit_supervisor_question",
      {
        ...questionPayload,
        shared_token: dispatcherToken
      }
    );
    const questionResponse = unwrapToolResult(questionResponseRaw);
    messageId = asString(questionResponse.message_id);
    if (!messageId) {
      throw new Error("Dispatcher did not return message_id.");
    }

    const supervisorDecisionRaw = await supervisorClient.callTool(
      "ask_codex_supervisor",
      {
        payload: buildSupervisorRequestPayload(context),
        shared_token: supervisorToken
      }
    );
    const supervisorDecision = asSupervisorDecisionPayload(
      supervisorDecisionRaw,
      "Supervisor capability returned malformed payload."
    );

    const responseAckRaw = await dispatcherClient.callTool("respond_supervisor_question", {
      message_id: messageId,
      supervisor_role_slug: context.supervisorRoleSlug,
      decision_payload: supervisorDecision,
      shared_token: dispatcherToken
    });
    const responseAck = unwrapToolResult(responseAckRaw);

    return buildWrapperResult({
      ok: true,
      taskId,
      messageId,
      decisionPayload: supervisorDecision,
      dispatcherSummary: {
        dispatch_status: asString(dispatchResponse.status || "queued"),
        question_status: asString(questionResponse.status || "pending"),
        response_status: asString(responseAck.status || "answered"),
        submitted_at: isoUtcNow(now),
        role_source: asString(supervisionProfileSource) || "unknown"
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return buildWrapperResult({
      ok: false,
      taskId,
      messageId,
      error: msg
    });
  }
}

module.exports = {
  SUPERVISOR_WRAPPER_TOOL_NAME,
  INTERNAL_SUPERVISOR_TOOL_NAMES,
  getSupervisorWrapperOpenAiTool,
  evaluateSupervisorEscalationGuardrails,
  buildGuardrailBlockedWrapperResult,
  runSupervisorWrapperToolCall,
  buildGuardedSupervisorMessage
};
