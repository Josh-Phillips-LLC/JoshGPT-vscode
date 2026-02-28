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

function buildPauseForHumanDecision(reason) {
  return {
    decision: "pause_for_human",
    rationale: `Supervisor wrapper fail-safe: ${asString(reason) || "manual review required."}`,
    next_actions: [
      "Review the escalation context and confirm supervisor endpoints are reachable.",
      "Verify dispatcher/supervisor shared tokens are present in extension environment.",
      "Retry escalation after resolving runtime/auth issues."
    ],
    confidence: 0.1,
    safety_checks: [
      "Token handling remained extension-local",
      "Escalation payload captured",
      "Human review required before continuation"
    ],
    audit_tags: ["fail-safe", "supervisor-wrapper"]
  };
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
          worker_role_slug: { type: "string" },
          supervisor_role_slug: { type: "string" },
          objective: { type: "string" },
          escalation_reason: { type: "string" },
          question: { type: "string" },
          role_context_ref: { type: "string" },
          constraints: { type: "array", items: { type: "string" }, maxItems: 20 },
          input_refs: { type: "array", items: { type: "string" }, maxItems: 20 },
          mission_id: { type: "string" },
          current_phase: {
            type: "string",
            enum: ["discovery", "classification", "validation", "reporting"]
          },
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
          attempt_history: { type: "array", items: { type: "string" }, maxItems: 20 },
          evidence_summary: { type: "string" },
          authorized_scope_id: { type: "string" },
          authorized_targets: { type: "array", items: { type: "string" }, maxItems: 20 },
          authorized_expires_utc: { type: "string" },
          requested_decision: {
            type: "string",
            enum: ["next_step", "prioritize", "deconflict", "stop_or_continue"]
          }
        },
        required: [
          "worker_role_slug",
          "supervisor_role_slug",
          "objective",
          "escalation_reason",
          "question"
        ]
      }
    }
  };
}

function buildDispatcherTaskPayload(input) {
  return {
    task_id: asString(input.mission_id) || crypto.randomUUID(),
    worker_role_slug: asString(input.worker_role_slug),
    supervisor_role_slug: asString(input.supervisor_role_slug),
    objective: asString(input.objective),
    constraints: asStringList(input.constraints, 20),
    input_refs: asStringList(input.input_refs, 20)
  };
}

function buildSupervisorRequestPayload(input, missionId, now) {
  const constraints = asStringList(input.constraints, 20);
  const authorizedTargets = asStringList(input.authorized_targets, 20);
  const effectiveTargets = authorizedTargets.length > 0 ? authorizedTargets : ["workspace"];
  const evidenceSummary = asString(input.evidence_summary);
  return {
    mission_id: asString(missionId),
    goal: asString(input.objective),
    current_phase: chooseEnum(input.current_phase, ALLOWED_CURRENT_PHASE, "validation"),
    blocked_reason: chooseEnum(
      input.blocked_reason,
      ALLOWED_BLOCKED_REASON,
      "insufficient_context"
    ),
    attempt_history: asStringList(input.attempt_history, 20),
    evidence_summary: evidenceSummary,
    constraints,
    authorized_scope: {
      scope_id: asString(input.authorized_scope_id) || "extension-supervisor-scope",
      targets: effectiveTargets,
      expires_utc:
        asString(input.authorized_expires_utc) || isoUtcPlusHours(now, 1)
    },
    requested_decision: chooseEnum(
      input.requested_decision,
      ALLOWED_REQUESTED_DECISION,
      "next_step"
    )
  };
}

function buildSupervisorQuestionPayload(input, taskId) {
  const roleContextRef = asString(input.role_context_ref) || "workspace://AGENTS.md";
  return {
    task_id: asString(taskId),
    from_role_slug: asString(input.worker_role_slug),
    to_supervisor_role_slug: asString(input.supervisor_role_slug),
    escalation_reason: asString(input.escalation_reason),
    question: asString(input.question),
    role_context_ref: roleContextRef,
    role_context_sha256: sha256Hex(
      `${roleContextRef}\n${asString(input.objective)}\n${asString(input.question)}`
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

  const taskPayload = buildDispatcherTaskPayload(input);
  if (
    !taskPayload.worker_role_slug ||
    !taskPayload.supervisor_role_slug ||
    !taskPayload.objective
  ) {
    return buildWrapperResult({
      ok: false,
      error:
        "Supervisor wrapper requires worker_role_slug, supervisor_role_slug, and objective."
    });
  }
  if (!asString(input.escalation_reason) || !asString(input.question)) {
    return buildWrapperResult({
      ok: false,
      error: "Supervisor wrapper requires escalation_reason and question."
    });
  }

  let taskId = "";
  let messageId = "";

  try {
    const dispatchResponseRaw = await dispatcherClient.callTool("dispatch_role_task", {
      payload: taskPayload,
      shared_token: dispatcherToken
    });
    const dispatchResponse = unwrapToolResult(dispatchResponseRaw);
    taskId = asString(dispatchResponse.task_id || taskPayload.task_id);
    if (!taskId) {
      throw new Error("Dispatcher did not return task_id.");
    }

    const questionPayload = buildSupervisorQuestionPayload(input, taskId);
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

    const supervisorRequestPayload = buildSupervisorRequestPayload(input, taskId, now);
    const supervisorDecisionRaw = await supervisorClient.callTool(
      "ask_codex_supervisor",
      {
        payload: supervisorRequestPayload,
        shared_token: supervisorToken
      }
    );
    const supervisorDecision = asSupervisorDecisionPayload(
      supervisorDecisionRaw,
      "Supervisor capability returned malformed payload."
    );

    const responseAckRaw = await dispatcherClient.callTool("respond_supervisor_question", {
      message_id: messageId,
      supervisor_role_slug: taskPayload.supervisor_role_slug,
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
        submitted_at: isoUtcNow(now)
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
  runSupervisorWrapperToolCall,
  buildGuardedSupervisorMessage
};
