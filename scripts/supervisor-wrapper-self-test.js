#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  runSupervisorWrapperToolCall,
  buildGuardedSupervisorMessage,
  evaluateSupervisorEscalationGuardrails,
  sanitizeSupervisorTelemetry
} = require("../src/supervisor-wrapper-tool");

const DEFAULT_INPUT = {
  escalation_reason: "insufficient_context",
  question: "Should we proceed with current evidence?"
};

const DEFAULT_PROFILE = {
  workerRoleSlug: "worker-analyst",
  supervisorRoleSlug: "codex-supervisor",
  authorizedScopeId: "extension-supervisor-scope",
  authorizedTargets: ["workspace"],
  requestedDecisionDefault: "next_step"
};

function createClientFactory({ dispatcherHandlers = {}, supervisorHandlers = {} } = {}) {
  return function mcpClientFactory(options) {
    const baseUrl = String(options.baseUrl || "");
    const handlers = baseUrl.includes(":8789") ? supervisorHandlers : dispatcherHandlers;
    return {
      async callTool(name, args) {
        if (typeof handlers[name] !== "function") {
          throw new Error(`No handler for ${name}`);
        }
        return handlers[name](args);
      }
    };
  };
}

function createOutputCapture() {
  const lines = [];
  return {
    lines,
    output: {
      appendLine(line) {
        lines.push(String(line || ""));
      }
    }
  };
}

function happyDecision(decision = "proceed") {
  return {
    structuredContent: {
      decision,
      rationale: "Supervisor returned a deterministic decision.",
      next_actions: ["Continue with the role objective."],
      confidence: 0.9,
      safety_checks: ["scope_ok"]
    }
  };
}

function roleCatalogPayload() {
  return {
    structuredContent: {
      registry_source: "00-os/role-registry.yml",
      registry_version: "1.0",
      roles: [
        {
          slug: "codex-supervisor",
          display_name: "Codex Supervisor",
          repo_name: "context-engineering-role-codex-supervisor",
          menu_order: 1
        },
        {
          slug: "hr-ai-agent-specialist",
          display_name: "HR and AI Agent Specialist",
          repo_name: "context-engineering-role-hr-ai-agent-specialist",
          menu_order: 2
        }
      ]
    }
  };
}

function instructionContextPayload(roleSlug = "codex-supervisor") {
  return {
    structuredContent: {
      instruction_context: {
        role_slug: roleSlug,
        role_display_name:
          roleSlug === "hr-ai-agent-specialist"
            ? "HR and AI Agent Specialist"
            : "Codex Supervisor",
        registry_source: "00-os/role-registry.yml",
        registry_version: "1.0",
        context_ref: `${roleSlug}@context-ref`,
        context_sha256: "abc123",
        agents_excerpt: "Agents excerpt",
        runtime_policy_excerpt: "Runtime policy excerpt",
        runtime_policy_ref: `${roleSlug}/.github/copilot-instructions.md`,
        runtime_policy_sha256: "def456"
      }
    }
  };
}

async function testHappyPath() {
  let capturedSupervisorPayload = null;

  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    supervisionProfile: DEFAULT_PROFILE,
    supervisionProfileSource: "workspace_file",
    sessionContext: {
      objective: "Confirm escalation behavior.",
      roleContextRef: "workspace://AGENTS.md"
    },
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        list_role_catalog: () => roleCatalogPayload(),
        get_supervisor_role_context: () => instructionContextPayload("codex-supervisor"),
        dispatch_role_task: () => ({ structuredContent: { task_id: "task-1", status: "queued" } }),
        submit_supervisor_question: () => ({
          structuredContent: { message_id: "msg-1", status: "pending" }
        }),
        respond_supervisor_question: () => ({ structuredContent: { status: "answered" } })
      },
      supervisorHandlers: {
        ask_codex_supervisor: (args) => {
          capturedSupervisorPayload = args.payload;
          return happyDecision("proceed");
        }
      }
    }),
    nowFactory: () => new Date("2026-02-27T00:00:00.000Z")
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, "continue");
  assert.strictEqual(result.decision.decision, "proceed");
  assert.strictEqual(result.task_id, "task-1");
  assert.strictEqual(result.message_id, "msg-1");
  assert.strictEqual(
    result.dispatcher.selected_supervisor_role_slug,
    "codex-supervisor"
  );
  assert.strictEqual(
    capturedSupervisorPayload.supervisor_context.instruction_context.role_slug,
    "codex-supervisor"
  );
}

async function testAssignedRoleOverridesProfileRole() {
  let requestedRoleSlug = "";

  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    assignedSupervisorRoleSlug: "hr-ai-agent-specialist",
    supervisionProfile: DEFAULT_PROFILE,
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        list_role_catalog: () => roleCatalogPayload(),
        get_supervisor_role_context: (args) => {
          requestedRoleSlug = String(args.role_slug || "");
          return instructionContextPayload(requestedRoleSlug);
        },
        dispatch_role_task: () => ({ structuredContent: { task_id: "task-9", status: "queued" } }),
        submit_supervisor_question: () => ({
          structuredContent: { message_id: "msg-9", status: "pending" }
        }),
        respond_supervisor_question: () => ({ structuredContent: { status: "answered" } })
      },
      supervisorHandlers: {
        ask_codex_supervisor: () => happyDecision("proceed")
      }
    })
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(requestedRoleSlug, "hr-ai-agent-specialist");
  assert.strictEqual(
    result.dispatcher.role_selection_source,
    "assigned_setting"
  );
}

async function testMissingEnvToken() {
  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token"
    },
    supervisionProfile: DEFAULT_PROFILE
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.action, "terminate");
  assert.strictEqual(result.decision.decision, "pause_for_human");
}

async function testDispatcherFailure() {
  const outputCapture = createOutputCapture();
  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    output: outputCapture.output,
    logLevel: "normal",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    supervisionProfile: DEFAULT_PROFILE,
    sessionContext: {
      objective: "Confirm escalation behavior.",
      roleContextRef: "workspace://AGENTS.md"
    },
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        list_role_catalog: () => {
          throw new Error("dispatcher unavailable");
        }
      },
      supervisorHandlers: {}
    })
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.action, "terminate");
  assert.strictEqual(result.decision.decision, "pause_for_human");
  assert.ok(result.error.includes("dispatcher unavailable"));
  assert.ok(
    outputCapture.lines.some(
      (line) =>
        line.includes("[joshgpt:supervisor] escalation_failed") &&
        line.includes('"stage":"catalog_lookup"')
    )
  );
}

async function testContextLookupFailure() {
  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    supervisionProfile: DEFAULT_PROFILE,
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        list_role_catalog: () => roleCatalogPayload(),
        get_supervisor_role_context: () => {
          throw new Error("missing AGENTS.md");
        }
      },
      supervisorHandlers: {}
    })
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.action, "terminate");
  assert.strictEqual(result.decision.decision, "pause_for_human");
  assert.ok(result.error.includes("missing AGENTS.md"));
}

async function testFailSafeDecisionPropagation() {
  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    supervisionProfile: DEFAULT_PROFILE,
    sessionContext: {
      objective: "Confirm escalation behavior.",
      roleContextRef: "workspace://AGENTS.md"
    },
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        list_role_catalog: () => roleCatalogPayload(),
        get_supervisor_role_context: () => instructionContextPayload("codex-supervisor"),
        dispatch_role_task: () => ({ structuredContent: { task_id: "task-2", status: "queued" } }),
        submit_supervisor_question: () => ({
          structuredContent: { message_id: "msg-2", status: "pending" }
        }),
        respond_supervisor_question: () => ({ structuredContent: { status: "answered" } })
      },
      supervisorHandlers: {
        ask_codex_supervisor: () => happyDecision("pause_for_human")
      }
    })
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, "terminate");
  assert.strictEqual(result.decision.decision, "pause_for_human");
  const guarded = buildGuardedSupervisorMessage(result);
  assert.ok(guarded.includes("pause_for_human"));
}

function testGuardrailPolicy() {
  const first = evaluateSupervisorEscalationGuardrails({
    input: { question: "Need next step" },
    state: { turnEscalationCount: 0, sessionEscalationCount: 0 },
    policy: { maxPerTurn: 1, maxPerSession: 2, cooldownMs: 15000 },
    nowMs: 1000
  });
  assert.strictEqual(first.allowed, true);
  assert.strictEqual(first.state.turnEscalationCount, 1);

  const second = evaluateSupervisorEscalationGuardrails({
    input: { question: "Need next step" },
    state: first.state,
    policy: { maxPerTurn: 1, maxPerSession: 2, cooldownMs: 15000 },
    nowMs: 2000
  });
  assert.strictEqual(second.allowed, false);
  assert.ok(second.reason.includes("per-turn limit"));
}

async function testNormalTelemetryLogsLifecycle() {
  const outputCapture = createOutputCapture();
  await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    output: outputCapture.output,
    logLevel: "normal",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    supervisionProfile: DEFAULT_PROFILE,
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        list_role_catalog: () => roleCatalogPayload(),
        get_supervisor_role_context: () => instructionContextPayload("codex-supervisor"),
        dispatch_role_task: () => ({ structuredContent: { task_id: "task-n1", status: "queued" } }),
        submit_supervisor_question: () => ({
          structuredContent: { message_id: "msg-n1", status: "pending" }
        }),
        respond_supervisor_question: () => ({ structuredContent: { status: "answered" } })
      },
      supervisorHandlers: {
        ask_codex_supervisor: () => happyDecision("proceed")
      }
    })
  });

  const joined = outputCapture.lines.join("\n");
  for (const event of [
    "escalation_start",
    "catalog_loaded",
    "role_selected",
    "context_loaded",
    "task_dispatched",
    "question_submitted",
    "supervisor_decision_received",
    "decision_recorded",
    "escalation_complete"
  ]) {
    assert.ok(joined.includes(`[joshgpt:supervisor] ${event}`), `missing ${event}`);
  }
  assert.ok(!joined.includes("catalog_loaded_details"));
}

async function testVerboseTelemetryIncludesDurations() {
  const outputCapture = createOutputCapture();
  await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    output: outputCapture.output,
    logLevel: "verbose",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    supervisionProfile: DEFAULT_PROFILE,
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        list_role_catalog: () => roleCatalogPayload(),
        get_supervisor_role_context: () => instructionContextPayload("codex-supervisor"),
        dispatch_role_task: () => ({ structuredContent: { task_id: "task-v1", status: "queued" } }),
        submit_supervisor_question: () => ({
          structuredContent: { message_id: "msg-v1", status: "pending" }
        }),
        respond_supervisor_question: () => ({ structuredContent: { status: "answered" } })
      },
      supervisorHandlers: {
        ask_codex_supervisor: () => happyDecision("proceed")
      }
    })
  });

  const joined = outputCapture.lines.join("\n");
  assert.ok(joined.includes("catalog_loaded_details"));
  assert.ok(joined.includes('"duration_ms"'));
  assert.ok(!joined.includes("Agents excerpt"));
  assert.ok(!joined.includes("Runtime policy excerpt"));
}

async function testOffTelemetrySuppressesLogs() {
  const outputCapture = createOutputCapture();
  await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    output: outputCapture.output,
    logLevel: "off",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    supervisionProfile: DEFAULT_PROFILE,
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        list_role_catalog: () => roleCatalogPayload(),
        get_supervisor_role_context: () => instructionContextPayload("codex-supervisor"),
        dispatch_role_task: () => ({ structuredContent: { task_id: "task-off", status: "queued" } }),
        submit_supervisor_question: () => ({
          structuredContent: { message_id: "msg-off", status: "pending" }
        }),
        respond_supervisor_question: () => ({ structuredContent: { status: "answered" } })
      },
      supervisorHandlers: {
        ask_codex_supervisor: () => happyDecision("proceed")
      }
    })
  });
  assert.strictEqual(outputCapture.lines.length, 0);
}

function testTelemetrySanitizerRedactsSecrets() {
  const sanitized = sanitizeSupervisorTelemetry({
    shared_token: "dispatcher-token",
    nested: {
      api_key: "super-secret",
      password: "very-secret"
    },
    agents_excerpt: "AGENTS",
    runtime_policy_excerpt: "POLICY"
  });
  assert.strictEqual(sanitized.shared_token, "<redacted>");
  assert.strictEqual(sanitized.nested.api_key, "<redacted>");
  assert.strictEqual(sanitized.nested.password, "<redacted>");
  assert.strictEqual(sanitized.agents_excerpt_chars, 6);
  assert.strictEqual(sanitized.runtime_policy_excerpt_chars, 6);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(sanitized, "agents_excerpt"), false);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(sanitized, "runtime_policy_excerpt"),
    false
  );
}

async function main() {
  await testHappyPath();
  await testAssignedRoleOverridesProfileRole();
  await testMissingEnvToken();
  await testDispatcherFailure();
  await testContextLookupFailure();
  await testFailSafeDecisionPropagation();
  await testNormalTelemetryLogsLifecycle();
  await testVerboseTelemetryIncludesDurations();
  await testOffTelemetrySuppressesLogs();
  testTelemetrySanitizerRedactsSecrets();
  testGuardrailPolicy();
  console.log("[supervisor-wrapper-test] PASS");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[supervisor-wrapper-test] FAIL: ${msg}`);
  process.exit(1);
});
