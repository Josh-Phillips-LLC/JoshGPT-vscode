#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  runSupervisorWrapperToolCall,
  buildGuardedSupervisorMessage
} = require("../src/supervisor-wrapper-tool");

const DEFAULT_INPUT = {
  worker_role_slug: "worker-analyst",
  supervisor_role_slug: "codex-supervisor",
  objective: "Confirm escalation behavior.",
  escalation_reason: "insufficient_context",
  question: "Should we proceed with current evidence?"
};

function createClientFactory({
  dispatcherHandlers = {},
  supervisorHandlers = {}
} = {}) {
  return function mcpClientFactory(options) {
    const baseUrl = String(options.baseUrl || "");
    const handlers = baseUrl.includes(":8789")
      ? supervisorHandlers
      : dispatcherHandlers;
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

async function testHappyPath() {
  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        dispatch_role_task: () => ({ structuredContent: { task_id: "task-1", status: "queued" } }),
        submit_supervisor_question: () => ({
          structuredContent: { message_id: "msg-1", status: "pending" }
        }),
        respond_supervisor_question: () => ({ structuredContent: { status: "answered" } })
      },
      supervisorHandlers: {
        ask_codex_supervisor: () => happyDecision("proceed")
      }
    }),
    nowFactory: () => new Date("2026-02-27T00:00:00.000Z")
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action, "continue");
  assert.strictEqual(result.decision.decision, "proceed");
  assert.strictEqual(result.task_id, "task-1");
  assert.strictEqual(result.message_id, "msg-1");
}

async function testMissingEnvToken() {
  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token"
    }
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.action, "terminate");
  assert.strictEqual(result.decision.decision, "pause_for_human");
}

async function testDispatcherFailure() {
  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
        dispatch_role_task: () => {
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
}

async function testFailSafeDecisionPropagation() {
  const result = await runSupervisorWrapperToolCall(DEFAULT_INPUT, {
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    mcpClientFactory: createClientFactory({
      dispatcherHandlers: {
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

async function main() {
  await testHappyPath();
  await testMissingEnvToken();
  await testDispatcherFailure();
  await testFailSafeDecisionPropagation();
  console.log("[supervisor-wrapper-test] PASS");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[supervisor-wrapper-test] FAIL: ${msg}`);
  process.exit(1);
});
