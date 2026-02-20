#!/usr/bin/env node
"use strict";

const { McpHttpClient } = require("../src/mcp-client");

async function main() {
  const baseUrl = process.env.JOSHGPT_MCP_BASE_URL || "http://127.0.0.1:8790/mcp";
  const client = new McpHttpClient({ baseUrl, timeoutMs: 15000 });

  const tools = await client.listTools();
  const names = tools.map((t) => t && t.name).filter(Boolean);
  console.log(`[mcp-self-test] tools=${names.join(",")}`);

  if (!names.includes("list_files")) {
    throw new Error("Expected list_files tool in MCP tool list.");
  }

  const callResult = await client.callTool("list_files", {
    path: ".",
    recursive: false,
    max_entries: 3
  });

  const structured = callResult && callResult.structuredContent ? callResult.structuredContent : {};
  const returned = Number(structured.returned || 0);
  console.log(`[mcp-self-test] list_files.returned=${returned}`);

  if (returned < 0) {
    throw new Error("Invalid list_files return count.");
  }

  console.log("[mcp-self-test] PASS");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[mcp-self-test] FAIL: ${msg}`);
  process.exit(1);
});
