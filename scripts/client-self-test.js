#!/usr/bin/env node
"use strict";

const { listModels, createChatCompletion } = require("../src/lmstudio-client");

async function main() {
  const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";
  const apiKey = process.env.LMSTUDIO_API_KEY || "lm-studio";
  const preferredModel = process.env.LMSTUDIO_MODEL || "";

  console.log(`[client-test] base_url=${baseUrl}`);
  const { modelIds } = await listModels({ baseUrl, apiKey });
  if (!modelIds.length) {
    throw new Error("LM Studio returned no models.");
  }
  console.log(`[client-test] model_count=${modelIds.length}`);
  console.log(`[client-test] first_model=${modelIds[0]}`);

  const selectedModel = preferredModel || modelIds[0];
  const { text } = await createChatCompletion({
    baseUrl,
    apiKey,
    model: selectedModel,
    systemPrompt: "You are concise.",
    userPrompt: "Reply exactly with: client module OK",
    temperature: 0,
    maxTokens: 32
  });

  console.log(`[client-test] selected_model=${selectedModel}`);
  console.log(`[client-test] response=${text}`);

  if (text.trim() !== "client module OK") {
    throw new Error(
      `Unexpected model response. Expected 'client module OK', got '${text.trim()}'`
    );
  }

  console.log("[client-test] PASS");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[client-test] FAIL: ${msg}`);
  process.exit(1);
});
