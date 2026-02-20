"use strict";

const {
  createChatCompletion,
  createNativeStreamingChat
} = require("./lmstudio-client");
const { McpHttpClient } = require("./mcp-client");

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

function asOpenAiTools(mcpTools) {
  return (Array.isArray(mcpTools) ? mcpTools : [])
    .filter((tool) => tool && tool.name && tool.inputSchema)
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
    return runNativeStreamingMode({
      config,
      messages,
      output,
      trace,
      addTrace
    });
  }

  let mcpClient = null;
  let openAiTools = [];
  let mcpEnabled = Boolean(config.mcpEnabled);
  addTrace(
    "start",
    `Prompt execution started (mcp=${mcpEnabled ? "enabled" : "disabled"})`
  );

  if (mcpEnabled) {
    try {
      mcpClient = new McpHttpClient({
        baseUrl: config.mcpBaseUrl,
        timeoutMs: config.mcpTimeoutMs,
        output
      });
      const mcpTools = await mcpClient.listTools();
      openAiTools = asOpenAiTools(mcpTools);
      if (!openAiTools.length) {
        addTrace("mcp", "MCP connected but no tools were returned.");
        mcpEnabled = false;
      } else {
        addTrace(
          "mcp",
          `MCP tools loaded (${openAiTools.length}).`,
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
    }
  }

  const workingMessages = Array.isArray(messages) ? [...messages] : [];
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
      tools: mcpEnabled ? openAiTools : undefined,
      toolChoice: mcpEnabled ? "auto" : undefined
    });

    const toolCallCount = countToolCalls(response);
    addTrace(
      "round",
      `Round ${round + 1}: model responded (tool_calls=${toolCallCount}).`
    );
    if (!mcpEnabled || toolCallCount === 0) {
      addTrace("final", "Model returned final response without additional tool calls.");
      return {
        text: response.text,
        usedTools: false,
        rounds: round + 1,
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
      const toolName = toolCall?.function?.name || "";
      const rawArgs = toolCall?.function?.arguments || "{}";
      const args = parseToolArguments(rawArgs);
      addTrace(
        "tool",
        `Calling tool: ${toolName || "<unknown>"}`,
        JSON.stringify(args, null, 2)
      );

      let toolResultText;
      try {
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
    trace
  };
}

module.exports = {
  runChatWithOptionalMcp
};
