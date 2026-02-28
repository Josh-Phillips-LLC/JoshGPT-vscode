#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { checkSupervisorReadiness } = require("../src/supervisor-readiness");

function createClientFactory(map = {}) {
  return function mcpClientFactory(options) {
    const baseUrl = String(options.baseUrl || "");
    const tools = Array.isArray(map[baseUrl]) ? map[baseUrl] : [];
    return {
      async listTools() {
        return tools.map((name) => ({ name }));
      }
    };
  };
}

async function testHappyPath() {
  const readiness = await checkSupervisorReadiness({
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    mcpClientFactory: createClientFactory({
      "http://127.0.0.1:8788/mcp": [
        "dispatch_role_task",
        "submit_supervisor_question",
        "respond_supervisor_question"
      ],
      "http://127.0.0.1:8789/mcp": ["ask_codex_supervisor"]
    })
  });
  assert.strictEqual(readiness.ready, true);
  assert.strictEqual(readiness.status, "ready");
}

async function testMissingToken() {
  const readiness = await checkSupervisorReadiness({
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {},
    mcpClientFactory: createClientFactory({
      "http://127.0.0.1:8788/mcp": [
        "dispatch_role_task",
        "submit_supervisor_question",
        "respond_supervisor_question"
      ],
      "http://127.0.0.1:8789/mcp": ["ask_codex_supervisor"]
    })
  });
  assert.strictEqual(readiness.ready, false);
  assert.strictEqual(readiness.status, "blocked");
  assert.ok(readiness.summary.includes("dispatcher_token"));
}

async function testMissingRequiredTool() {
  const readiness = await checkSupervisorReadiness({
    dispatcherBaseUrl: "http://127.0.0.1:8788/mcp",
    capabilityBaseUrl: "http://127.0.0.1:8789/mcp",
    env: {
      JOSHGPT_DISPATCHER_SHARED_TOKEN: "dispatcher-token",
      JOSHGPT_SUPERVISOR_SHARED_TOKEN: "supervisor-token"
    },
    mcpClientFactory: createClientFactory({
      "http://127.0.0.1:8788/mcp": ["dispatch_role_task"],
      "http://127.0.0.1:8789/mcp": ["ask_codex_supervisor"]
    })
  });
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.summary.includes("Missing required tool"));
}

async function main() {
  await testHappyPath();
  await testMissingToken();
  await testMissingRequiredTool();
  console.log("[supervisor-readiness-test] PASS");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[supervisor-readiness-test] FAIL: ${msg}`);
  process.exit(1);
});
