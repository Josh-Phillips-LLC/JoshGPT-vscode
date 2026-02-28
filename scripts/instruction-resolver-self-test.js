#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveInheritedInstructions } = require("../src/instruction-resolver");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joshgpt-instructions-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testCanonicalSelectedWhenPresent() {
  withTempDir((workspaceRoot) => {
    writeFile(path.join(workspaceRoot, "AGENTS.md"), "# Canonical\nKeep this first.");
    writeFile(
      path.join(workspaceRoot, ".github", "copilot-instructions.md"),
      "Copilot adapter fallback."
    );

    const result = resolveInheritedInstructions({
      workspaceRoot,
      enabled: true,
      maxChars: 20000
    });

    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.canonicalAvailable, true);
    assert.ok(Array.isArray(result.selectedSources));
    assert.strictEqual(result.selectedSources[0].key, "canonical_agents");
    assert.ok(result.systemMessage.includes("Canonical"));
    assert.ok(result.contentHash.length > 10);
  });
}

function testFallbackBehaviorWhenCanonicalMissing() {
  withTempDir((workspaceRoot) => {
    writeFile(
      path.join(workspaceRoot, ".github", "copilot-instructions.md"),
      "Adapter instructions only."
    );

    const result = resolveInheritedInstructions({
      workspaceRoot,
      enabled: true,
      maxChars: 20000
    });

    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.canonicalAvailable, false);
    assert.ok(result.warning.includes("Canonical AGENTS.md"));
    assert.strictEqual(result.selectedSources[0].key, "workspace_copilot_adapter");
  });
}

function testTruncationBoundary() {
  withTempDir((workspaceRoot) => {
    writeFile(path.join(workspaceRoot, "AGENTS.md"), "A".repeat(9000));

    const result = resolveInheritedInstructions({
      workspaceRoot,
      enabled: true,
      maxChars: 1024
    });

    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.contentHash.length > 10);
    assert.ok(result.systemMessage.length > 0);
  });
}

function main() {
  testCanonicalSelectedWhenPresent();
  testFallbackBehaviorWhenCanonicalMissing();
  testTruncationBoundary();
  console.log("[instruction-resolver-test] PASS");
}

main();
