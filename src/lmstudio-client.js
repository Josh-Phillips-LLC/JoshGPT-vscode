function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
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
  maxTokens
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
  const content = data?.choices?.[0]?.message?.content;

  return {
    data,
    text:
      typeof content === "string" && content.trim().length > 0
        ? content.trim()
        : JSON.stringify(data, null, 2)
  };
}

module.exports = {
  normalizeBaseUrl,
  listModels,
  createChatCompletion
};
