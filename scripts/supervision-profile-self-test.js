#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveSupervisionProfile } = require("../src/supervision-profile-resolver");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "joshgpt-supervision-profile-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeProfile(workspaceRoot, body) {
  const filePath = path.join(workspaceRoot, ".joshgpt", "supervision.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2), "utf8");
}

function testWorkspaceProfilePreferred() {
  withTempDir((workspaceRoot) => {
    writeProfile(workspaceRoot, {
      version: 1,
      worker_role_slug: "implementation-specialist",
      supervisor_role_slug: "hr-ai-agent-specialist",
      authorized_scope_id: "extension-supervisor-scope",
      authorized_targets: ["workspace"],
      requested_decision_default: "next_step"
    });

    const result = resolveSupervisionProfile({
      workspaceRoot,
      settingsFallback: {
        workerRoleSlug: "fallback-worker",
        supervisorRoleSlug: "fallback-supervisor"
      }
    });
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.source, "workspace_file");
    assert.strictEqual(result.profile.workerRoleSlug, "implementation-specialist");
  });
}

function testSettingsFallback() {
  withTempDir((workspaceRoot) => {
    const result = resolveSupervisionProfile({
      workspaceRoot,
      settingsFallback: {
        workerRoleSlug: "fallback-worker",
        supervisorRoleSlug: "fallback-supervisor"
      }
    });
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.source, "settings_fallback");
    assert.ok(result.warning.includes("settings fallback"));
  });
}

function testMissingAllProfiles() {
  withTempDir((workspaceRoot) => {
    const result = resolveSupervisionProfile({
      workspaceRoot,
      settingsFallback: {}
    });
    assert.strictEqual(result.resolved, false);
    assert.strictEqual(result.source, "none");
    assert.ok(result.error.length > 0);
  });
}

function main() {
  testWorkspaceProfilePreferred();
  testSettingsFallback();
  testMissingAllProfiles();
  console.log("[supervision-profile-test] PASS");
}

main();
