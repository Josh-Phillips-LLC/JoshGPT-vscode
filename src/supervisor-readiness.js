"use strict";

const { McpHttpClient } = require("./mcp-client");

const REQUIRED_DISPATCHER_TOOLS = [
  "dispatch_role_task",
  "submit_supervisor_question",
  "respond_supervisor_question",
  "list_role_catalog",
  "get_supervisor_role_context"
];
const REQUIRED_CAPABILITY_TOOLS = ["ask_codex_supervisor"];

function asString(value) {
  return String(value || "").trim();
}

function hasMissingTools(toolNames, requiredToolNames) {
  const available = new Set((toolNames || []).map((name) => String(name || "")));
  return requiredToolNames.filter((name) => !available.has(name));
}

function buildCheck(name, ok, detail) {
  return {
    name: String(name),
    ok: Boolean(ok),
    detail: String(detail || "")
  };
}

function summarizeChecks(checks) {
  const failures = checks.filter((check) => !check.ok);
  if (!failures.length) {
    return "Supervisor readiness checks passed.";
  }
  return failures.map((check) => `${check.name}: ${check.detail}`).join(" | ");
}

async function checkMcpTools({
  label,
  baseUrl,
  timeoutMs,
  requiredToolNames,
  mcpClientFactory,
  output
}) {
  try {
    const client = mcpClientFactory({
      baseUrl,
      timeoutMs,
      output
    });
    const tools = await client.listTools();
    const names = tools.map((tool) => (tool && tool.name ? String(tool.name) : ""));
    const missing = hasMissingTools(names, requiredToolNames);
    if (missing.length) {
      return buildCheck(
        label,
        false,
        `Missing required tool(s): ${missing.join(", ")}`
      );
    }
    return buildCheck(label, true, `${names.length} tools listed.`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return buildCheck(label, false, detail);
  }
}

async function checkSupervisorReadiness({
  dispatcherBaseUrl,
  capabilityBaseUrl,
  timeoutMs = 15000,
  env = process.env,
  mcpClientFactory = (options) => new McpHttpClient(options),
  output = null
} = {}) {
  const checks = [];
  const dispatcherUrl = asString(dispatcherBaseUrl);
  const capabilityUrl = asString(capabilityBaseUrl);
  const dispatcherToken = asString(env.JOSHGPT_DISPATCHER_SHARED_TOKEN);
  const supervisorToken = asString(env.JOSHGPT_SUPERVISOR_SHARED_TOKEN);

  checks.push(
    buildCheck(
      "dispatcher_url",
      Boolean(dispatcherUrl),
      dispatcherUrl ? dispatcherUrl : "joshgpt.supervisor.dispatcherBaseUrl is empty."
    )
  );
  checks.push(
    buildCheck(
      "capability_url",
      Boolean(capabilityUrl),
      capabilityUrl ? capabilityUrl : "joshgpt.supervisor.capabilityBaseUrl is empty."
    )
  );
  checks.push(
    buildCheck(
      "dispatcher_token",
      Boolean(dispatcherToken),
      dispatcherToken
        ? "JOSHGPT_DISPATCHER_SHARED_TOKEN is present."
        : "JOSHGPT_DISPATCHER_SHARED_TOKEN is missing."
    )
  );
  checks.push(
    buildCheck(
      "supervisor_token",
      Boolean(supervisorToken),
      supervisorToken
        ? "JOSHGPT_SUPERVISOR_SHARED_TOKEN is present."
        : "JOSHGPT_SUPERVISOR_SHARED_TOKEN is missing."
    )
  );

  const urlsOk = checks[0].ok && checks[1].ok;
  if (urlsOk) {
    checks.push(
      await checkMcpTools({
        label: "dispatcher_mcp",
        baseUrl: dispatcherUrl,
        timeoutMs,
        requiredToolNames: REQUIRED_DISPATCHER_TOOLS,
        mcpClientFactory,
        output
      })
    );
    checks.push(
      await checkMcpTools({
        label: "capability_mcp",
        baseUrl: capabilityUrl,
        timeoutMs,
        requiredToolNames: REQUIRED_CAPABILITY_TOOLS,
        mcpClientFactory,
        output
      })
    );
  }

  const ready = checks.every((check) => check.ok);
  return {
    ready,
    status: ready ? "ready" : "blocked",
    checks,
    summary: summarizeChecks(checks)
  };
}

module.exports = {
  REQUIRED_DISPATCHER_TOOLS,
  REQUIRED_CAPABILITY_TOOLS,
  checkSupervisorReadiness
};
