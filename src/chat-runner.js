"use strict";

const { createChatCompletion } = require("./lmstudio-client");
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

async function runChatWithOptionalMcp({ config, messages, output }) {
  let mcpClient = null;
  let openAiTools = [];
  let mcpEnabled = Boolean(config.mcpEnabled);

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
        mcpEnabled = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (output) {
        output.appendLine(`[joshgpt] MCP disabled for this turn: ${msg}`);
      }
      mcpEnabled = false;
    }
  }

  const workingMessages = Array.isArray(messages) ? [...messages] : [];
  const maxRounds = Number.isFinite(config.mcpMaxToolRounds)
    ? Math.max(1, config.mcpMaxToolRounds)
    : 4;

  for (let round = 0; round < maxRounds; round += 1) {
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
    if (!mcpEnabled || toolCallCount === 0) {
      return {
        text: response.text,
        usedTools: false,
        rounds: round + 1
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

    for (const toolCall of response.toolCalls) {
      const toolName = toolCall?.function?.name || "";
      const rawArgs = toolCall?.function?.arguments || "{}";
      const args = parseToolArguments(rawArgs);

      let toolResultText;
      try {
        const result = await mcpClient.callTool(toolName, args);
        toolResultText = stringifyToolResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResultText = `MCP tool call failed: ${msg}`;
      }

      workingMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: toolResultText
      });
    }
  }

  return {
    text:
      "Reached tool-call round limit before final response. Increase joshgpt.mcp.maxToolRounds if needed.",
    usedTools: true,
    rounds: maxRounds
  };
}

module.exports = {
  runChatWithOptionalMcp
};
