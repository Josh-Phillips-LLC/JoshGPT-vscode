"use strict";

const crypto = require("crypto");
const {
  createChatCompletion,
  createNativeStreamingChat
} = require("./lmstudio-client");
const { McpHttpClient } = require("./mcp-client");
const {
  buildCorrelationHeaders
} = require("./telemetry");
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
  emitSupervisorLog,
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

async function runNativeStreamingMode({
  config,
  messages,
  output,
  trace,
  addTrace,
  emitTelemetry,
  nextRequestId,
  correlationContext
}) {
  addTrace("start", "Prompt execution started (mode=lmstudio-native-stream).");
  emitTelemetry({
    event: "turn.start",
    message: "Prompt execution started (lmstudio-native-stream).",
    operation: "turn",
    status: "start"
  });

  if (config.mcpEnabled) {
    addTrace(
      "mcp",
      "MCP tool-calling is currently bypassed in lmstudio-native-stream mode."
    );
  }

  const lmRequestId = nextRequestId();
  emitTelemetry({
    event: "lm.request.start",
    message: "LM native stream request started.",
    operation: "lmstudio.native_stream",
    status: "start",
    request_id: lmRequestId,
    endpoint: `${config.nativeBaseUrl}/api/v1/chat`,
    model: String(config.model || "")
  });

  const startedAtMs = Date.now();
  let streamResult;
  try {
    streamResult = await createNativeStreamingChat({
      nativeBaseUrl: config.nativeBaseUrl,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      correlationHeaders: buildCorrelationHeaders({
        chatSessionId: correlationContext.chatSessionId,
        turnId: correlationContext.turnId,
        requestId: lmRequestId
      }),
      onEvent: (event) => {
        const name = String(event.event || "event");
        const lowered = name.toLowerCase();
        const delta = typeof event.deltaText === "string" ? event.deltaText : "";
        const details = delta || summarizeEventData(event.data);

        if (lowered.startsWith("reasoning.")) {
          addTrace("reasoning", name, details);
        } else if (
          lowered === "done" ||
          lowered.endsWith(".done") ||
          lowered.endsWith(".completed")
        ) {
          addTrace("stream-end", name, details);
        } else {
          addTrace("stream", name, details);
        }
      }
    });
    emitTelemetry({
      event: "lm.request.complete",
      message: "LM native stream request completed.",
      operation: "lmstudio.native_stream",
      status: "ok",
      request_id: lmRequestId,
      endpoint: `${config.nativeBaseUrl}/api/v1/chat`,
      model: String(config.model || ""),
      duration_ms: Math.max(0, Date.now() - startedAtMs),
      attrs: {
        event_count: Array.isArray(streamResult.events) ? streamResult.events.length : 0
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitTelemetry({
      event: "lm.request.error",
      message: "LM native stream request failed.",
      operation: "lmstudio.native_stream",
      status: "error",
      request_id: lmRequestId,
      endpoint: `${config.nativeBaseUrl}/api/v1/chat`,
      model: String(config.model || ""),
      duration_ms: Math.max(0, Date.now() - startedAtMs),
      error_code: "lm_request_failed",
      attrs: {
        error: msg
      }
    });
    throw err;
  }

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
  emitTelemetry({
    event: "turn.complete",
    message: "Prompt execution completed (lmstudio-native-stream).",
    operation: "turn",
    status: "ok",
    attrs: {
      rounds: 1
    }
  });

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

  const telemetry =
    config && config.telemetry && typeof config.telemetry.log === "function"
      ? config.telemetry
      : null;
  const correlation = config && config.correlation && typeof config.correlation === "object"
    ? config.correlation
    : {};
  const correlationContext = {
    chatSessionId: String(correlation.chatSessionId || "unknown"),
    turnId: String(correlation.turnId || "unknown")
  };
  const requestIdFactory =
    typeof correlation.requestIdFactory === "function"
      ? correlation.requestIdFactory
      : null;
  function nextRequestId() {
    if (requestIdFactory) {
      try {
        const value = String(requestIdFactory() || "").trim();
        if (value) {
          return value;
        }
      } catch {
        // Fall through to generated ID.
      }
    }
    return `req-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }
  function emitTelemetry(payload = {}) {
    if (!telemetry) {
      return;
    }
    telemetry.log({
      service: "joshgpt-vscode",
      source: "vscode",
      chat_session_id: correlationContext.chatSessionId,
      turn_id: correlationContext.turnId,
      ...payload
    });
  }

  if (config.chatEndpointMode === "lmstudio-native-stream") {
    addInstructionTrace(addTrace, config.instructionInheritance);
    return runNativeStreamingMode({
      config,
      messages,
      output,
      trace,
      addTrace,
      emitTelemetry,
      nextRequestId,
      correlationContext
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
  emitTelemetry({
    event: "turn.start",
    message: "Prompt execution started.",
    component: "chat-runner",
    operation: "turn",
    status: "start",
    model: String(config.model || "")
  });
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
              supervisorProfileResolution.profile?.supervisorRoleSlug || "",
            assigned_supervisor_role_slug: String(
              config.supervisorAssignedRoleSlug || ""
            )
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
        output,
        correlation: {
          chatSessionId: correlationContext.chatSessionId,
          turnId: correlationContext.turnId
        },
        requestIdFactory: nextRequestId,
        telemetry
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
      emitTelemetry({
        event: "mcp.disabled",
        message: "MCP disabled for this turn.",
        component: "chat-runner",
        operation: "mcp.bootstrap",
        status: "error",
        error_code: "mcp_bootstrap_failed",
        attrs: {
          error: msg
        }
      });
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
    const lmRequestId = nextRequestId();
    const lmStartedAtMs = Date.now();
    emitTelemetry({
      event: "lm.request.start",
      message: "LM chat completion request started.",
      component: "chat-runner",
      operation: "lmstudio.chat_completion",
      status: "start",
      request_id: lmRequestId,
      model: String(config.model || ""),
      endpoint: `${config.baseUrl}/chat/completions`,
      attrs: {
        round: round + 1,
        message_count: workingMessages.length,
        tool_count: toolChoiceEnabled ? openAiTools.length : 0
      }
    });

    let response;
    try {
      response = await createChatCompletion({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages: workingMessages,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        tools: toolChoiceEnabled ? openAiTools : undefined,
        toolChoice: toolChoiceEnabled ? "auto" : undefined,
        correlationHeaders: buildCorrelationHeaders({
          chatSessionId: correlationContext.chatSessionId,
          turnId: correlationContext.turnId,
          requestId: lmRequestId
        })
      });
      emitTelemetry({
        event: "lm.request.complete",
        message: "LM chat completion request completed.",
        component: "chat-runner",
        operation: "lmstudio.chat_completion",
        status: "ok",
        request_id: lmRequestId,
        model: String(config.model || ""),
        endpoint: `${config.baseUrl}/chat/completions`,
        duration_ms: Math.max(0, Date.now() - lmStartedAtMs),
        attrs: {
          round: round + 1
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitTelemetry({
        event: "lm.request.error",
        message: "LM chat completion request failed.",
        component: "chat-runner",
        operation: "lmstudio.chat_completion",
        status: "error",
        request_id: lmRequestId,
        model: String(config.model || ""),
        endpoint: `${config.baseUrl}/chat/completions`,
        duration_ms: Math.max(0, Date.now() - lmStartedAtMs),
        error_code: "lm_request_failed",
        attrs: {
          round: round + 1,
          error: msg
        }
      });
      throw err;
    }

    const toolCallCount = countToolCalls(response);
    addTrace(
      "round",
      `Round ${round + 1}: model responded (tool_calls=${toolCallCount}).`
    );
    if (toolCallCount === 0) {
      addTrace("final", "Model returned final response without additional tool calls.");
      emitTelemetry({
        event: "turn.complete",
        message: "Prompt execution completed.",
        component: "chat-runner",
        operation: "turn",
        status: "ok",
        model: String(config.model || ""),
        attrs: {
          rounds: round + 1,
          used_tools: usedToolsInTurn
        }
      });
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
        const localShellRequestId = nextRequestId();
        const localShellStartedAtMs = Date.now();
        emitTelemetry({
          event: "local_shell.start",
          message: "Local shell tool call started.",
          component: "chat-runner",
          operation: "local_shell",
          status: "start",
          request_id: localShellRequestId,
          tool_call_id: String(toolCall.id || ""),
          attrs: {
            tool_name: toolName
          }
        });
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
          emitTelemetry({
            event: "local_shell.complete",
            message: "Local shell tool call completed.",
            component: "chat-runner",
            operation: "local_shell",
            status: "ok",
            request_id: localShellRequestId,
            tool_call_id: String(toolCall.id || ""),
            duration_ms: Math.max(0, Date.now() - localShellStartedAtMs),
            attrs: {
              tool_name: toolName,
              exit_code: Number(localResult && localResult.exit_code)
            }
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResultText = `Local shell tool failed: ${msg}`;
          addTrace("tool-error", `Local shell failed: ${toolName}`, msg);
          emitTelemetry({
            event: "local_shell.error",
            message: "Local shell tool call failed.",
            component: "chat-runner",
            operation: "local_shell",
            status: "error",
            request_id: localShellRequestId,
            tool_call_id: String(toolCall.id || ""),
            duration_ms: Math.max(0, Date.now() - localShellStartedAtMs),
            error_code: "local_shell_failed",
            attrs: {
              tool_name: toolName,
              error: msg
            }
          });
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
          emitSupervisorLog(output, config.supervisorLogLevel, "escalation_blocked", {
            invocation_source: "model_tool",
            reason_type: "profile_unresolved",
            reason:
              supervisorProfileResolution.error || "role binding unavailable."
          });
          wrapperResult = buildGuardrailBlockedWrapperResult(
            `Missing supervision profile: ${supervisorProfileResolution.error || "role binding unavailable."}`
          );
        } else if (!supervisorPreflight.ready) {
          emitSupervisorLog(output, config.supervisorLogLevel, "escalation_blocked", {
            invocation_source: "model_tool",
            reason_type: "preflight_blocked",
            reason: supervisorPreflight.summary
          });
          wrapperResult = buildGuardrailBlockedWrapperResult(
            `Supervisor preflight blocked: ${supervisorPreflight.summary}`
          );
        } else if (!guardrailEval.allowed) {
          emitSupervisorLog(output, config.supervisorLogLevel, "escalation_blocked", {
            invocation_source: "model_tool",
            reason_type: "guardrail_denied",
            reason: guardrailEval.reason
          });
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
            assignedSupervisorRoleSlug: config.supervisorAssignedRoleSlug,
            logLevel: config.supervisorLogLevel,
            invocationSource: "model_tool",
            sessionContext: config.supervisorSessionContext || {},
            telemetry,
            correlation: {
              chatSessionId: correlationContext.chatSessionId,
              turnId: correlationContext.turnId,
              toolCallId: String(toolCall.id || ""),
              requestIdFactory: nextRequestId
            }
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
          emitTelemetry({
            event: "turn.complete",
            message: "Prompt execution terminated by supervisor decision.",
            component: "chat-runner",
            operation: "turn",
            status: "ok",
            model: String(config.model || ""),
            attrs: {
              rounds: round + 1,
              supervisor_action: wrapperResult.action
            }
          });
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
          const result = await mcpClient.callTool(toolName, args, {
            toolCallId: String(toolCall.id || "")
          });
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
  emitTelemetry({
    event: "turn.complete",
    message: "Prompt execution reached max tool-call rounds.",
    component: "chat-runner",
    operation: "turn",
    status: "ok",
    model: String(config.model || ""),
    attrs: {
      rounds: maxRounds,
      used_tools: true
    }
  });
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
