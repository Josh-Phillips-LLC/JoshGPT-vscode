"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_MAX_CHARS = 30000;

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function boundedMaxChars(value) {
  return Math.max(1024, asInt(value, DEFAULT_MAX_CHARS));
}

function resolveSources(workspaceRoot) {
  const root = String(workspaceRoot || process.cwd() || ".").trim() || ".";
  return [
    {
      key: "canonical_agents",
      kind: "canonical",
      path: path.join(root, "AGENTS.md")
    },
    {
      key: "runtime_loader",
      kind: "loader",
      path: "/workspace/instructions/role-instructions.md"
    },
    {
      key: "workspace_copilot_adapter",
      kind: "adapter",
      path: path.join(root, ".github", "copilot-instructions.md")
    },
    {
      key: "runtime_agents_adapter",
      kind: "adapter",
      path: "/workspace/instructions/AGENTS.md"
    },
    {
      key: "runtime_policy",
      kind: "policy",
      path: "/workspace/instructions/agent-runtime-policy.md"
    }
  ];
}

function readSourceFile(source) {
  const exists = fs.existsSync(source.path);
  if (!exists) {
    return {
      ...source,
      exists: false,
      readable: false,
      content: "",
      bytes: 0
    };
  }

  try {
    const content = fs.readFileSync(source.path, "utf8");
    return {
      ...source,
      exists: true,
      readable: true,
      content,
      bytes: Buffer.byteLength(content, "utf8")
    };
  } catch {
    return {
      ...source,
      exists: true,
      readable: false,
      content: "",
      bytes: 0
    };
  }
}

function renderCombinedContent(readableSources, maxChars) {
  let out = "";
  let truncated = false;

  for (const source of readableSources) {
    if (out.length >= maxChars) {
      truncated = true;
      break;
    }

    const blockHeader =
      `### ${source.key} (${source.kind})\n` +
      `source: ${source.path}\n\n`;
    const blockBody = String(source.content || "").trim();
    const block = `${blockHeader}${blockBody}\n\n`;

    const remaining = maxChars - out.length;
    if (block.length > remaining) {
      out += block.slice(0, remaining);
      truncated = true;
      break;
    }
    out += block;
  }

  return {
    text: out.trim(),
    truncated
  };
}

function buildSystemMessage(combinedText) {
  if (!combinedText) {
    return "";
  }
  return (
    "Use the following inherited workspace instructions as authoritative context. " +
    "Treat canonical AGENTS.md role boundaries as primary.\n\n" +
    combinedText
  );
}

function resolveInheritedInstructions({
  workspaceRoot,
  enabled = true,
  maxChars = DEFAULT_MAX_CHARS
} = {}) {
  const maxCharsCap = boundedMaxChars(maxChars);
  const sources = resolveSources(workspaceRoot).map(readSourceFile);
  const canonical = sources.find((item) => item.key === "canonical_agents") || null;
  const readable = sources.filter((item) => item.readable);

  if (!enabled) {
    return {
      enabled: false,
      applied: false,
      warning: "Instruction inheritance disabled by configuration.",
      maxChars: maxCharsCap,
      canonicalPath: canonical ? canonical.path : null,
      canonicalAvailable: Boolean(canonical && canonical.readable),
      selectedSources: sources.map((item) => ({
        key: item.key,
        kind: item.kind,
        path: item.path,
        exists: item.exists,
        readable: item.readable,
        bytes: item.bytes
      })),
      contentHash: "",
      truncated: false,
      systemMessage: ""
    };
  }

  if (!readable.length) {
    return {
      enabled: true,
      applied: false,
      warning: "No inheritable instruction files were readable.",
      maxChars: maxCharsCap,
      canonicalPath: canonical ? canonical.path : null,
      canonicalAvailable: false,
      selectedSources: sources.map((item) => ({
        key: item.key,
        kind: item.kind,
        path: item.path,
        exists: item.exists,
        readable: item.readable,
        bytes: item.bytes
      })),
      contentHash: "",
      truncated: false,
      systemMessage: ""
    };
  }

  const combined = renderCombinedContent(readable, maxCharsCap);
  const hash = crypto
    .createHash("sha256")
    .update(combined.text, "utf8")
    .digest("hex");

  const warning = canonical && !canonical.readable
    ? "Canonical AGENTS.md not readable; fallback instructions applied."
    : "";

  return {
    enabled: true,
    applied: Boolean(combined.text),
    warning,
    maxChars: maxCharsCap,
    canonicalPath: canonical ? canonical.path : null,
    canonicalAvailable: Boolean(canonical && canonical.readable),
    selectedSources: readable.map((item) => ({
      key: item.key,
      kind: item.kind,
      path: item.path,
      exists: item.exists,
      readable: item.readable,
      bytes: item.bytes
    })),
    contentHash: hash,
    truncated: combined.truncated,
    systemMessage: buildSystemMessage(combined.text)
  };
}

module.exports = {
  resolveInheritedInstructions
};
