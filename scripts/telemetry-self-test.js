#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  TelemetryWriter,
  makeTelemetryId
} = require("../src/telemetry");

function readLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function testIdUniqueness() {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    ids.add(makeTelemetryId("req"));
  }
  assert.strictEqual(ids.size, 200, "Telemetry IDs should be unique.");
}

function testMetadataOnlyRedaction(tmpRoot) {
  const writer = new TelemetryWriter({
    enabled: true,
    workspaceRoot: tmpRoot,
    logDir: ".joshgpt/logs",
    includeContent: false,
    maxFileSizeMb: 10,
    maxFiles: 5
  });
  writer.log({
    event: "test.redaction",
    message: "Testing redaction and metadata-only mode.",
    chat_session_id: "session-a",
    turn_id: "turn-a",
    attrs: {
      prompt: "user prompt should be removed",
      response: "model response should be removed",
      api_key: "secret-key",
      nested: {
        token: "top-secret-token"
      }
    }
  });

  const lines = readLines(path.join(tmpRoot, ".joshgpt/logs/joshgpt-telemetry.ndjson"));
  assert.ok(lines.length >= 1, "Telemetry writer should write at least one line.");
  const payload = JSON.parse(lines[0]);
  assert.ok(payload.attrs, "Attrs should exist.");
  assert.strictEqual(payload.attrs.prompt, undefined, "Prompt should be omitted.");
  assert.strictEqual(payload.attrs.response, undefined, "Response should be omitted.");
  assert.strictEqual(payload.attrs.api_key, "<redacted>", "api_key should be redacted.");
  assert.strictEqual(payload.attrs.nested.token, "<redacted>", "nested token should be redacted.");
}

function testRotation(tmpRoot) {
  const writer = new TelemetryWriter({
    enabled: true,
    workspaceRoot: tmpRoot,
    logDir: ".joshgpt/logs",
    includeContent: true,
    maxFileSizeMb: 1,
    maxFiles: 3
  });

  const chunk = "x".repeat(3000);
  for (let i = 0; i < 500; i += 1) {
    writer.log({
      event: "test.rotation.write",
      message: `rotation write ${i}`,
      chat_session_id: "session-rotate",
      turn_id: `turn-${i}`,
      attrs: { blob: chunk }
    });
  }

  const base = path.join(tmpRoot, ".joshgpt/logs/joshgpt-telemetry.ndjson");
  const rotated = `${base}.1`;
  assert.ok(fs.existsSync(base), "Base telemetry file should exist.");
  assert.ok(fs.existsSync(rotated), "Rotated telemetry file should exist.");
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "joshgpt-telemetry-test-"));
  try {
    testIdUniqueness();
    testMetadataOnlyRedaction(tmpRoot);
    testRotation(tmpRoot);
    console.log("[telemetry-test] PASS");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
