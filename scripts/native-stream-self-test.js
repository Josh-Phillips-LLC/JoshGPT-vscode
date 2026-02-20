#!/usr/bin/env node
"use strict";

const {
  createNativeStreamingChat,
  listModels
} = require("../src/lmstudio-client");

async function main() {
  const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";
  const nativeBaseUrl =
    process.env.LMSTUDIO_NATIVE_BASE_URL || "http://localhost:1234";
  const apiKey = process.env.LMSTUDIO_API_KEY || "lm-studio";
  const preferredModel = process.env.LMSTUDIO_MODEL || "";

  console.log(`[native-test] base_url=${baseUrl}`);
  console.log(`[native-test] native_base_url=${nativeBaseUrl}`);

  const { modelIds } = await listModels({ baseUrl, apiKey });
  if (!modelIds.length) {
    throw new Error("LM Studio returned no models.");
  }
  const selectedModel = preferredModel || modelIds[0];

  const { events, text } = await createNativeStreamingChat({
    nativeBaseUrl,
    baseUrl,
    apiKey,
    model: selectedModel,
    messages: [
      { role: "system", content: "You are concise." },
      {
        role: "user",
        content:
          "Reply in exactly three words: native stream working"
      }
    ],
    temperature: 0,
    maxTokens: 64
  });

  const reasoningEvents = events.filter((e) =>
    String(e.event || "").toLowerCase().startsWith("reasoning.")
  );

  console.log(`[native-test] selected_model=${selectedModel}`);
  console.log(`[native-test] event_count=${events.length}`);
  console.log(`[native-test] reasoning_event_count=${reasoningEvents.length}`);
  console.log(`[native-test] response=${text || "<empty>"}`);

  if (!events.length) {
    throw new Error("No stream events received from native endpoint.");
  }

  const hasMessageEvent = events.some((e) =>
    String(e.event || "").toLowerCase().startsWith("message.")
  );
  const hasReasoningEvent = reasoningEvents.length > 0;
  if (!String(text || "").trim() && !hasMessageEvent && !hasReasoningEvent) {
    throw new Error(
      "Native endpoint returned no assistant text and no message/reasoning stream events."
    );
  }

  console.log("[native-test] PASS");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[native-test] FAIL: ${msg}`);
  process.exit(1);
});
