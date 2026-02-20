#!/usr/bin/env node
"use strict";

const { runLocalShellToolCall } = require("../src/local-shell-tool");

async function main() {
  const result = await runLocalShellToolCall(
    {
      command: "pwd"
    },
    {
      workspaceRoot: process.cwd(),
      defaultTimeoutSeconds: 10,
      maxTimeoutSeconds: 30,
      defaultMaxOutputChars: 2000,
      maxOutputCharsCap: 10000
    }
  );

  console.log(`[local-shell-test] exit_code=${result.exit_code}`);
  console.log(`[local-shell-test] cwd=${result.cwd}`);
  console.log(`[local-shell-test] stdout=${(result.stdout || "").trim()}`);

  if (result.exit_code !== 0) {
    throw new Error("Local shell command returned non-zero exit code.");
  }
  if (!String(result.stdout || "").trim()) {
    throw new Error("Local shell command returned empty stdout.");
  }

  console.log("[local-shell-test] PASS");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[local-shell-test] FAIL: ${msg}`);
  process.exit(1);
});
