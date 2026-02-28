"use strict";

const {
  createChatCompletion,
  createNativeStreamingChat
} = require("./lmstudio-client");
const { McpHttpClient } = require("./mcp-client");
const {
  LOCAL_SHELL_TOOL_NAME,
  getLocalShellOpenAiTool,
  runLocalShellToolCall
} = require("./local-shell-tool");
const {
  SUPERVISOR_WRAPPER_TOOL_NAME,
  INTERNAL_SUPERVISOR_TOOL_NAMES,
  getSupervisorWrapperOpenAiTool,
  evaluateSupervisorEscalationGuardrails,
  buildGuardrailBlockedWrapperResult,
  runSupervisorWrapperToolCall,
  buildGuardedSupervisorMessage
} = require("./supervisor-wrapper-tool");
const { resolveSupervisionProfile } = require("./supervision-profile-resolver");
const { checkSupervisorReadiness } = require("./supervisor-readiness");

const MCP_EXECUTION_TOOL_NAMES = new Set([
  "run_host_command",
  "run_container_command"
]);
const MCP_HIDDEN_TOOL_NAMES = new Set([
  ...MCP_EXECUTION_TOOL_NAMES,
  ...INTERNAL_SUPERVISOR_TOOL_NAMES
]);

function stringifyToolResult(result) {
  if (result && typeof result.structuredContent !== "undefined") {
    return JSON.stringify(result.structuredContent, null, 2);
  }

  if (result && Array.isArray(result.content)) {
    const textParts = result.content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean);
    if (textParts.length) {
      return textParts.join("\n");
    }
  }

  return JSON.stringify(result || {}, null, 2);
}

function parseToolArguments(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function redactForLog(value, keyName = "") {
  const key = String(keyName || "").toLowerCase();
  const sensitive =
    key.includes("token") ||
    key.includes("secret") ||
    key.includes("password") ||
    key.includes("authorization") ||
    key.includes("api_key") ||
    key.includes("private_key") ||
    key.includes("cookie");

  if (sensitive) {
    return "<redacted>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, keyName));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactForLog(v, k);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  }
  return value;
}

function formatArgsForLog(args, maxChars = 1200) {
  try {
    const safe = redactForLog(args);
    const text = JSON.stringify(safe);
    if (typeof text !== "string") {
      return "{}";
    }
    return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text;
  } catch {
    return "<unserializable-args>";
  }
}

function asOpenAiTools(mcpTools, excludedToolNames = new Set()) {
  return (Array.isArray(mcpTools) ? mcpTools : [])
    .filter((tool) => tool && tool.name && tool.inputSchema)
    .filter((tool) => !excludedToolNames.has(String(tool.name)))
    .map((tool) => ({
      type: "function",
      function: {
        name: String(tool.name),
        description: String(tool.description || ""),
        parameters: tool.inputSchema
      }
    }));
}

function countToolCalls(response) {
  const calls = response && Array.isArray(response.toolCalls) ? response.toolCalls : [];
  return calls.length;
}

function summarizeEventData(data) {
  if (data === null || typeof data === "undefined") {
    return "";
  }
  if (typeof data === "string") {
    return data.slice(0, 600);
  }
  try {
    return JSON.stringify(data, null, 2).slice(0, 1200);
  } catch {
    return String(data).slice(0, 600);
  }
}

function formatInstructionTraceDetails(instructionInheritance) {
  const sources = Array.isArray(instructionInheritance?.selectedSources)
    ? instructionInheritance.selectedSources
    : [];
  const chosenCanonicalSource = instructionInheritance?.canonicalAvailable
    ? String(instructionInheritance.canonicalPath || "")
    : "";
  const fallbackPathUsed =
    !instructionInheritance?.canonicalAvailable && sources.length > 0
      ? String(sources[0].path || "")
      : "";
  return JSON.stringify(
    {
      chosen_canonical_source: chosenCanonicalSource || null,
      fallback_path_used: fallbackPathUsed || null,
      truncated: Boolean(instructionInheritance?.truncated),
      content_hash: String(instructionInheritance?.contentHash || ""),
      source_count: sources.length
    },
    null,
    2
  );
}

function addInstructionTrace(addTrace, instructionInheritance) {
  if (!instructionInheritance || typeof instructionInheritance !== "object") {
    return;
  }
  addTrace(
    "instructions",
    instructionInheritance.applied
      ? "Inherited workspace instructions applied."
      : "Inherited workspace instructions not applied.",
    formatInstructionTraceDetails(instructionInheritance)
  );
  if (instructionInheritance.warning) {
    addTrace("instructions-warning", String(instructionInheritance.warning));
  }
}

function formatSupervisorCheckDetails(result, stage) {
  return JSON.stringify(
    {
      stage: String(stage || ""),
      status: String(result?.status || "blocked"),
      ready: Boolean(result?.ready),
      summary: String(result?.summary || ""),
      checks: Array.isArray(result?.checks) ? result.checks : []
    },
    null,
    2
  );
}

async function runNativeStreamingMode({ config, messages, output, trace, addTrace }) {
  addTrace("start", "Prompt execution started (mode=lmstudio-native-stream).");

  if (config.mcpEnabled) {
    addTrace(
      "mcp",
      "MCP tool-calling is currently bypassed in lmstudio-native-stream mode."
    );
  }

  const streamResult = await createNativeStreamingChat({
    nativeBaseUrl: config.nativeBaseUrl,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    messages,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    onEvent: (event) => {
      const name = String(event.event || "event");
      const lowered = name.toLowerCase();
      const delta = typeof event.deltaText === "string" ? event.deltaText : "";
      const details = delta || summarizeEventData(event.data);

      if (lowered.startsWith("reasoning.")) {
        addTrace("reasoning", name, details);
      } else if (lowered === "done" || lowered.endsWith(".done") || lowered.endsWith(".completed")) {
        addTrace("stream-end", name, details);
      } else {
        addTrace("stream", name, details);
      }
    }
  });

  if (output) {
    output.appendLine(
      `[joshgpt] native stream completed events=${streamResult.events.length}`
    );
  }

  addTrace(
    "final",
    "Native streaming response completed.",
    `events=${streamResult.events.length}`
  );

  return {
    text:
      streamResult.text ||
      "Model returned no assistant text. Check trace for stream events.",
    usedTools: false,
    rounds: 1,
    trace
  };
}

async function runChatWithOptionalMcp({ config, messages, output }) {
  const trace = [];
  function addTrace(type, summary, details = "") {
    trace.push({
      timestamp: new Date().toISOString(),
      type: String(type || "event"),
      summary: String(summary || ""),
      details: String(details || "")
    });
  }

  if (config.chatEndpointMode === "lmstudio-native-stream") {
    addInstructionTrace(addTrace, config.instructionInheritance);
    return runNativeStreamingMode({
      config,
      messages,
      output,
      trace,
      addTrace
    });
  }

  const localShellEnabled = Boolean(config.localShellEnabled);
  const localTools = localShellEnabled ? [getLocalShellOpenAiTool()] : [];
  const supervisorEnabled = Boolean(config.supervisorEnabled);
  const supervisorModelEscalationEnabled = Boolean(
    config.supervisorModelEscalationEnabled ?? true
  );
  const supervisorProfileResolution = supervisorEnabled
    ? resolveSupervisionProfile({
        workspaceRoot: config.workspaceRoot,
        settingsFallback: {
          workerRoleSlug: config.supervisorWorkerRoleSlug,
          supervisorRoleSlug: config.supervisorSupervisorRoleSlug
        }
      })
    : {
        resolved: false,
        source: "none",
        profile: null,
        warning: "",
        error: ""
      };
  const supervisorTools =
    supervisorEnabled && supervisorModelEscalationEnabled
      ? [getSupervisorWrapperOpenAiTool()]
      : [];
  let supervisorPreflight = {
    ready: false,
    status: "blocked",
    summary: "Supervisor readiness check not run.",
    checks: []
  };
  let supervisorPreflightRechecked = false;
  let supervisorGuardrailState = {
    turnEscalationCount: 0,
    sessionEscalationCount: Math.max(0, Number(config.supervisorEscalationsInSession) || 0),
    lastEscalationAtMs: Math.max(0, Number(config.supervisorLastEscalationAtMs) || 0),
    lastEscalationQuestionHash: String(config.supervisorLastEscalationQuestionHash || "")
  };

  let mcpClient = null;
  let openAiTools = [];
  let mcpEnabled = Boolean(config.mcpEnabled);
  addInstructionTrace(addTrace, config.instructionInheritance);
  addTrace(
    "start",
    `Prompt execution started (mcp=${mcpEnabled ? "enabled" : "disabled"}, local_shell=${localShellEnabled ? "enabled" : "disabled"}, supervisor=${supervisorEnabled ? "enabled" : "disabled"})`
  );
  if (supervisorEnabled) {
    if (supervisorProfileResolution.resolved) {
      addTrace(
        "supervision-profile",
        `Supervisor profile resolved from ${supervisorProfileResolution.source}.`,
        JSON.stringify(
          {
            source: supervisorProfileResolution.source,
            profile_file: supervisorProfileResolution.filePath || null,
            worker_role_slug: supervisorProfileResolution.profile?.workerRoleSlug || "",
            supervisor_role_slug:
              supervisorProfileResolution.profile?.supervisorRoleSlug || ""
          },
          null,
          2
        )
      );
      if (supervisorProfileResolution.warning) {
        addTrace("supervision-profile-warning", supervisorProfileResolution.warning);
      }
    } else {
      addTrace(
        "supervision-profile-error",
        "Supervisor profile could not be resolved.",
        String(supervisorProfileResolution.error || "")
      );
    }
    supervisorPreflight = await checkSupervisorReadiness({
      dispatcherBaseUrl: config.supervisorDispatcherBaseUrl,
      capabilityBaseUrl: config.supervisorCapabilityBaseUrl,
      timeoutMs: config.mcpTimeoutMs,
      output
    });
    addTrace(
      "supervisor-preflight",
      `Supervisor readiness: ${supervisorPreflight.status}`,
      formatSupervisorCheckDetails(supervisorPreflight, "session_start")
    );
  }

  if (mcpEnabled) {
    try {
      mcpClient = new McpHttpClient({
        baseUrl: config.mcpBaseUrl,
        timeoutMs: config.mcpTimeoutMs,
        output
      });
      const mcpTools = await mcpClient.listTools();
      const mcpOpenAiTools = asOpenAiTools(mcpTools, MCP_HIDDEN_TOOL_NAMES);
      const supervisorToolsForTurn =
        supervisorEnabled &&
        supervisorModelEscalationEnabled &&
        supervisorProfileResolution.resolved &&
        supervisorPreflight.ready
          ? supervisorTools
          : [];
      openAiTools = [...localTools, ...supervisorToolsForTurn, ...mcpOpenAiTools];
      if (!openAiTools.length) {
        addTrace("mcp", "MCP connected but no tools were returned.");
        mcpEnabled = false;
      } else if (!mcpOpenAiTools.length && localShellEnabled) {
        addTrace("mcp", "MCP connected; execution tools excluded; local shell tool active.");
      } else {
        addTrace(
          "mcp",
          `Tools loaded (${openAiTools.length}).`,
          openAiTools.map((tool) => tool.function.name).join(", ")
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (output) {
        output.appendLine(`[joshgpt] MCP disabled for this turn: ${msg}`);
      }
      addTrace("mcp", "MCP disabled for this turn.", msg);
      mcpEnabled = false;
      if (localShellEnabled || supervisorEnabled) {
        const supervisorToolsForTurn =
          supervisorEnabled &&
          supervisorModelEscalationEnabled &&
          supervisorProfileResolution.resolved &&
          supervisorPreflight.ready
            ? supervisorTools
            : [];
        openAiTools = [...localTools, ...supervisorToolsForTurn];
        if (output) {
          output.appendLine(
            "[joshgpt] Falling back to extension-local tools for this turn."
          );
        }
        addTrace("tool", "Fallback enabled: extension-local tools remain active.");
      }
    }
  } else if (localShellEnabled || supervisorEnabled) {
    const supervisorToolsForTurn =
      supervisorEnabled &&
      supervisorModelEscalationEnabled &&
      supervisorProfileResolution.resolved &&
      supervisorPreflight.ready
        ? supervisorTools
        : [];
    openAiTools = [...localTools, ...supervisorToolsForTurn];
    addTrace("tool", "MCP disabled; extension-local tools are active.");
  }

  if (localShellEnabled) {
    const hasLocalShellTool = openAiTools.some(
      (tool) => tool && tool.function && tool.function.name === LOCAL_SHELL_TOOL_NAME
    );
    if (!hasLocalShellTool) {
      openAiTools = [...localTools, ...openAiTools];
      addTrace("tool", "Ensured local shell tool availability for this turn.");
    }
  }
  if (supervisorEnabled && supervisorModelEscalationEnabled) {
    if (!supervisorProfileResolution.resolved) {
      addTrace(
        "supervisor",
        "Supervisor wrapper tool withheld: unresolved supervision profile."
      );
    } else if (!supervisorPreflight.ready) {
      addTrace(
        "supervisor",
        "Supervisor wrapper tool withheld: readiness preflight is blocked."
      );
    }
    const hasSupervisorTool = openAiTools.some(
      (tool) =>
        tool && tool.function && tool.function.name === SUPERVISOR_WRAPPER_TOOL_NAME
    );
    if (!hasSupervisorTool && supervisorProfileResolution.resolved && supervisorPreflight.ready) {
      openAiTools = [...supervisorTools, ...openAiTools];
      addTrace("tool", "Ensured supervisor wrapper tool availability for this turn.");
    }
  } else if (supervisorEnabled) {
    addTrace(
      "supervisor",
      "Model-initiated supervisor escalation disabled by configuration."
    );
  }

  const workingMessages = Array.isArray(messages) ? [...messages] : [];
  const toolChoiceEnabled = Array.isArray(openAiTools) && openAiTools.length > 0;
  let usedToolsInTurn = false;
  const maxRounds = Number.isFinite(config.mcpMaxToolRounds)
    ? Math.max(1, config.mcpMaxToolRounds)
    : 4;

  for (let round = 0; round < maxRounds; round += 1) {
    addTrace(
      "round",
      `Round ${round + 1}: requesting model completion.`,
      `message_count=${workingMessages.length}`
    );
    const response = await createChatCompletion({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages: workingMessages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      tools: toolChoiceEnabled ? openAiTools : undefined,
      toolChoice: toolChoiceEnabled ? "auto" : undefined
    });

    const toolCallCount = countToolCalls(response);
    addTrace(
      "round",
      `Round ${round + 1}: model responded (tool_calls=${toolCallCount}).`
    );
    if (toolCallCount === 0) {
      addTrace("final", "Model returned final response without additional tool calls.");
      return {
        text: response.text,
        usedTools: usedToolsInTurn,
        rounds: round + 1,
        supervisorGuardrailState,
        trace
      };
    }

    const assistantMessage = {
      role: "assistant",
      content:
        typeof response.message?.content === "string" ? response.message.content : "",
      tool_calls: response.toolCalls
    };
    workingMessages.push(assistantMessage);

    if (output) {
      output.appendLine(`[joshgpt] model requested ${toolCallCount} tool call(s)`);
    }
    addTrace("tool", `Round ${round + 1}: executing ${toolCallCount} tool call(s).`);

    for (const toolCall of response.toolCalls) {
      usedToolsInTurn = true;
      const toolName = toolCall?.function?.name || "";
      const rawArgs = toolCall?.function?.arguments || "{}";
      const args = parseToolArguments(rawArgs);
      if (output) {
        output.appendLine(
          `[joshgpt] tool call -> ${toolName || "<unknown>"} args=${formatArgsForLog(args)}`
        );
      }
      addTrace(
        "tool",
        `Calling tool: ${toolName || "<unknown>"}`,
        JSON.stringify(args, null, 2)
      );

      let toolResultText;
      if (toolName === LOCAL_SHELL_TOOL_NAME) {
        try {
          const localResult = await runLocalShellToolCall(args, {
            workspaceRoot: config.workspaceRoot,
            defaultTimeoutSeconds: config.localShellDefaultTimeoutSeconds,
            maxTimeoutSeconds: config.localShellMaxTimeoutSeconds,
            defaultMaxOutputChars: config.localShellDefaultMaxOutputChars,
            maxOutputCharsCap: config.localShellMaxOutputChars,
            mirror: config.localShellMirror || null
          });
          toolResultText = JSON.stringify(localResult, null, 2);
          addTrace(
            "tool",
            `Local shell result: ${toolName}`,
            toolResultText.slice(0, 1200)
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResultText = `Local shell tool failed: ${msg}`;
          addTrace("tool-error", `Local shell failed: ${toolName}`, msg);
        }
      } else if (toolName === SUPERVISOR_WRAPPER_TOOL_NAME) {
        addTrace(
          "supervisor-escalation-request",
          "Supervisor escalation requested by model.",
          JSON.stringify(args, null, 2).slice(0, 1200)
        );
        if (!supervisorPreflightRechecked) {
          supervisorPreflightRechecked = true;
          supervisorPreflight = await checkSupervisorReadiness({
            dispatcherBaseUrl: config.supervisorDispatcherBaseUrl,
            capabilityBaseUrl: config.supervisorCapabilityBaseUrl,
            timeoutMs: config.mcpTimeoutMs,
            output
          });
          addTrace(
            "supervisor-preflight",
            `Supervisor readiness: ${supervisorPreflight.status}`,
            formatSupervisorCheckDetails(supervisorPreflight, "before_first_escalation")
          );
        }
        const guardrailEval = evaluateSupervisorEscalationGuardrails({
          input: args,
          state: supervisorGuardrailState,
          policy: {
            maxPerTurn: config.supervisorMaxEscalationsPerTurn,
            maxPerSession: config.supervisorMaxEscalationsPerSession,
            cooldownMs: config.supervisorEscalationCooldownMs
          }
        });
        let wrapperResult;
        if (!supervisorProfileResolution.resolved) {
          wrapperResult = buildGuardrailBlockedWrapperResult(
            `Missing supervision profile: ${supervisorProfileResolution.error || "role binding unavailable."}`
          );
        } else if (!supervisorPreflight.ready) {
          wrapperResult = buildGuardrailBlockedWrapperResult(
            `Supervisor preflight blocked: ${supervisorPreflight.summary}`
          );
        } else if (!guardrailEval.allowed) {
          wrapperResult = buildGuardrailBlockedWrapperResult(guardrailEval.reason);
        } else {
          supervisorGuardrailState = guardrailEval.state;
          wrapperResult = await runSupervisorWrapperToolCall(args, {
            dispatcherBaseUrl: config.supervisorDispatcherBaseUrl,
            capabilityBaseUrl: config.supervisorCapabilityBaseUrl,
            timeoutMs: config.mcpTimeoutMs,
            output,
            supervisionProfile: supervisorProfileResolution.profile,
            supervisionProfileSource: supervisorProfileResolution.source,
            sessionContext: config.supervisorSessionContext || {}
          });
        }
        toolResultText = JSON.stringify(wrapperResult, null, 2);
        const supervisorTracePayload = {
          wrapper_result: wrapperResult,
          guardrail_state: supervisorGuardrailState
        };
        addTrace(
          "supervisor-escalation-decision",
          `Supervisor wrapper result: action=${wrapperResult.action}`,
          JSON.stringify(supervisorTracePayload, null, 2).slice(0, 1200)
        );
        if (wrapperResult.action === "terminate") {
          addTrace(
            "supervisor",
            "Supervisor returned terminal decision; ending tool loop."
          );
          return {
            text: buildGuardedSupervisorMessage(wrapperResult),
            usedTools: true,
            rounds: round + 1,
            supervisorGuardrailState,
            trace
          };
        }
      } else {
        try {
          if (!mcpClient) {
            throw new Error("MCP client unavailable for non-local tool.");
          }
          const result = await mcpClient.callTool(toolName, args);
          toolResultText = stringifyToolResult(result);
          addTrace(
            "tool",
            `Tool result: ${toolName || "<unknown>"}`,
            toolResultText.slice(0, 1200)
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResultText = `MCP tool call failed: ${msg}`;
          addTrace("tool-error", `Tool failed: ${toolName || "<unknown>"}`, msg);
        }
      }

      workingMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: toolResultText
      });
    }
  }

  addTrace(
    "limit",
    "Stopped after reaching max tool-call rounds.",
    `max_rounds=${maxRounds}`
  );
  return {
    text:
      "Reached tool-call round limit before final response. Increase joshgpt.mcp.maxToolRounds if needed.",
    usedTools: true,
    rounds: maxRounds,
    supervisorGuardrailState,
    trace
  };
}

module.exports = {
  runChatWithOptionalMcp
};
