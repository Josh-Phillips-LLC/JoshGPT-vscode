function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function inferNativeBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return "";
  }
  if (normalized.endsWith("/v1")) {
    return normalized.slice(0, -3);
  }
  return normalized;
}

function buildHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey || "lm-studio"}`
  };
}

async function listModels({ baseUrl, apiKey }) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const res = await fetch(`${normalizedBase}/models`, {
    headers: buildHeaders(apiKey)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Model list failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const modelIds = Array.isArray(data.data)
    ? data.data.map((m) => m && m.id).filter(Boolean)
    : [];

  return {
    data,
    modelIds
  };
}

async function createChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  systemPrompt,
  userPrompt,
  temperature,
  maxTokens,
  tools,
  toolChoice
}) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const payloadMessages =
    Array.isArray(messages) && messages.length > 0
      ? messages
      : [
          { role: "system", content: systemPrompt || "You are concise." },
          { role: "user", content: userPrompt }
        ];

  const payload = {
    model,
    messages: payloadMessages,
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : 512,
    stream: false
  };
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = toolChoice || "auto";
  }

  const res = await fetch(`${normalizedBase}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Chat completion failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const message = data?.choices?.[0]?.message || {};
  const content = message?.content;
  const finishReason = data?.choices?.[0]?.finish_reason || "";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  return {
    data,
    message,
    finishReason,
    toolCalls,
    text:
      typeof content === "string" && content.trim().length > 0
        ? content.trim()
        : JSON.stringify(data, null, 2)
  };
}

function normalizeSseFrame(rawFrame) {
  const lines = String(rawFrame || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  return {
    event,
    dataRaw: dataLines.join("\n").trim()
  };
}

function parseMaybeJson(input) {
  const text = String(input || "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildNativeInput(messages, { systemPrompt, userPrompt } = {}) {
  if (Array.isArray(messages) && messages.length > 0) {
    const lines = [];
    for (const item of messages) {
      const role = String(item?.role || "user").toUpperCase();
      const content = String(item?.content || "").trim();
      if (!content) {
        continue;
      }
      lines.push(`${role}: ${content}`);
    }
    if (lines.length > 0) {
      return [{ type: "text", content: lines.join("\n\n") }];
    }
  }

  const fallback = [
    String(systemPrompt || "").trim(),
    String(userPrompt || "").trim()
  ]
    .filter(Boolean)
    .join("\n\n");
  return [{ type: "text", content: fallback || "Hello." }];
}

function extractTextDeltaFromNativeEvent(eventName, payload, rawText) {
  const evt = String(eventName || "").toLowerCase();
  const p = payload && typeof payload === "object" ? payload : null;

  if (evt.startsWith("reasoning.")) {
    return "";
  }

  if (!p) {
    return "";
  }

  const allowDirectCandidates =
    evt.startsWith("message.") ||
    evt === "message" ||
    evt.includes("output_text") ||
    evt.endsWith(".delta") ||
    evt === "chat.end";

  const candidates = allowDirectCandidates
    ? [
        p.delta,
        p.text,
        p.content,
        p.output_text,
        p.message,
        p.response && p.response.output_text,
        p.data && p.data.delta,
        p.data && p.data.text,
        p.data && p.data.content,
        p.data && p.data.output_text
      ]
    : [];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  // Common shape for OpenAI-style nested response deltas.
  const out = p.output && Array.isArray(p.output) ? p.output : [];
  for (const item of out) {
    const content = item && Array.isArray(item.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === "string" && c.text.length > 0) {
        return c.text;
      }
      if (typeof c?.delta === "string" && c.delta.length > 0) {
        return c.delta;
      }
    }
  }

  const resultOut =
    p.result && Array.isArray(p.result.output) ? p.result.output : [];
  for (const item of resultOut) {
    if (
      item &&
      String(item.type || "").toLowerCase() === "message" &&
      typeof item.content === "string" &&
      item.content.length > 0
    ) {
      return item.content;
    }
  }

  if (evt.endsWith(".delta") && typeof rawText === "string" && rawText.length > 0) {
    return rawText;
  }
  return "";
}

async function createNativeStreamingChat({
  nativeBaseUrl,
  baseUrl,
  apiKey,
  model,
  messages,
  systemPrompt,
  userPrompt,
  temperature,
  maxTokens,
  onEvent
}) {
  const normalizedNativeBase = normalizeBaseUrl(nativeBaseUrl || inferNativeBaseUrl(baseUrl));
  if (!normalizedNativeBase) {
    throw new Error("Native LM Studio base URL is empty.");
  }
  const endpoint = `${normalizedNativeBase}/api/v1/chat`;

  const nativeInput = buildNativeInput(messages, { systemPrompt, userPrompt });

  const payload = {
    model,
    input: nativeInput,
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
    stream: true
  };
  if (Number.isFinite(maxTokens)) {
    payload.max_output_tokens = maxTokens;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Native streaming chat failed (${res.status}): ${body}`);
  }
  if (!res.body) {
    throw new Error("Native streaming response body is unavailable.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let buffer = "";
  let assistantText = "";
  let sawMessageDelta = false;
  const events = [];

  function emitEvent(eventName, dataRaw) {
    if (!eventName) {
      return;
    }

    const maybeJson = parseMaybeJson(dataRaw);
    const data = maybeJson || dataRaw;
    let deltaText = extractTextDeltaFromNativeEvent(eventName, maybeJson, dataRaw);
    const loweredEvent = String(eventName || "").toLowerCase();
    if (loweredEvent === "message.delta" && deltaText) {
      sawMessageDelta = true;
    }
    if (loweredEvent === "chat.end" && sawMessageDelta) {
      deltaText = "";
    }
    if (deltaText) {
      assistantText += deltaText;
    }

    const event = {
      event: String(eventName),
      data,
      dataRaw: String(dataRaw || ""),
      deltaText: String(deltaText || "")
    };
    events.push(event);
    if (typeof onEvent === "function") {
      onEvent(event);
    }
  }

  function consumeFrame(rawFrame) {
    const frame = normalizeSseFrame(rawFrame);
    if (!frame.dataRaw) {
      return;
    }

    if (frame.dataRaw === "[DONE]") {
      emitEvent("done", frame.dataRaw);
      return;
    }
    emitEvent(frame.event, frame.dataRaw);
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex < 0) {
        break;
      }
      const rawFrame = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      consumeFrame(rawFrame);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeFrame(buffer);
  }

  return {
    endpoint,
    events,
    text: assistantText.trim() || ""
  };
}

module.exports = {
  normalizeBaseUrl,
  inferNativeBaseUrl,
  listModels,
  createChatCompletion,
  createNativeStreamingChat
};
