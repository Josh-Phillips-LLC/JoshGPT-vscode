"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_SCOPE_ID = "extension-supervisor-scope";
const DEFAULT_TARGETS = ["workspace"];
const DEFAULT_REQUESTED_DECISION = "next_step";

const ALLOWED_REQUESTED_DECISION = new Set([
  "next_step",
  "prioritize",
  "deconflict",
  "stop_or_continue"
]);

function asString(value) {
  return String(value || "").trim();
}

function asStringList(value, maxItems = 20) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  for (const item of value) {
    const text = asString(item);
    if (!text) {
      continue;
    }
    out.push(text);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function normalizeRequestedDecision(value, fallback = DEFAULT_REQUESTED_DECISION) {
  const normalized = asString(value).toLowerCase();
  if (ALLOWED_REQUESTED_DECISION.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeProfile(raw, { source, filePath }) {
  const profile = raw && typeof raw === "object" ? raw : {};
  const workerRoleSlug = asString(
    profile.worker_role_slug || profile.workerRoleSlug
  );
  const supervisorRoleSlug = asString(
    profile.supervisor_role_slug || profile.supervisorRoleSlug
  );

  if (!workerRoleSlug || !supervisorRoleSlug) {
    return {
      ok: false,
      source,
      filePath,
      error:
        "Supervision profile requires non-empty worker_role_slug and supervisor_role_slug."
    };
  }

  return {
    ok: true,
    source,
    filePath,
    profile: {
      workerRoleSlug,
      supervisorRoleSlug,
      authorizedScopeId: asString(
        profile.authorized_scope_id || profile.authorizedScopeId
      ) || DEFAULT_SCOPE_ID,
      authorizedTargets: (() => {
        const targets = asStringList(
          profile.authorized_targets || profile.authorizedTargets,
          20
        );
        return targets.length ? targets : DEFAULT_TARGETS;
      })(),
      requestedDecisionDefault: normalizeRequestedDecision(
        profile.requested_decision_default || profile.requestedDecisionDefault,
        DEFAULT_REQUESTED_DECISION
      )
    }
  };
}

function resolveProfileFromWorkspaceFile(workspaceRoot) {
  const root = asString(workspaceRoot) || process.cwd();
  const filePath = path.join(root, ".joshgpt", "supervision.json");
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      source: "workspace_file",
      filePath,
      error: "Supervision profile file not found."
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      source: "workspace_file",
      filePath,
      error: `Failed to parse supervision profile JSON: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  if (Number(parsed && parsed.version) !== 1) {
    return {
      ok: false,
      source: "workspace_file",
      filePath,
      error: "Supervision profile requires version=1."
    };
  }

  return normalizeProfile(parsed, {
    source: "workspace_file",
    filePath
  });
}

function resolveProfileFromSettingsFallback(settingsFallback = {}) {
  const normalized = normalizeProfile(
    {
      worker_role_slug: settingsFallback.workerRoleSlug,
      supervisor_role_slug: settingsFallback.supervisorRoleSlug,
      authorized_scope_id: settingsFallback.authorizedScopeId,
      authorized_targets: settingsFallback.authorizedTargets,
      requested_decision_default: settingsFallback.requestedDecisionDefault
    },
    {
      source: "settings_fallback",
      filePath: ""
    }
  );
  if (!normalized.ok) {
    return {
      ...normalized,
      error:
        "Settings fallback requires joshgpt.supervisor.workerRoleSlug and " +
        "joshgpt.supervisor.supervisorRoleSlug."
    };
  }
  return normalized;
}

function resolveSupervisionProfile({ workspaceRoot, settingsFallback = {} } = {}) {
  const fromWorkspace = resolveProfileFromWorkspaceFile(workspaceRoot);
  if (fromWorkspace.ok) {
    return {
      resolved: true,
      source: "workspace_file",
      profile: fromWorkspace.profile,
      filePath: fromWorkspace.filePath,
      warning: "",
      error: ""
    };
  }

  const fromSettings = resolveProfileFromSettingsFallback(settingsFallback);
  if (fromSettings.ok) {
    return {
      resolved: true,
      source: "settings_fallback",
      profile: fromSettings.profile,
      filePath: fromWorkspace.filePath,
      warning:
        "Workspace supervision profile unavailable; using settings fallback role bindings.",
      error: ""
    };
  }

  return {
    resolved: false,
    source: "none",
    profile: null,
    filePath: fromWorkspace.filePath,
    warning: "",
    error: fromWorkspace.error || fromSettings.error || "No supervision profile available."
  };
}

module.exports = {
  resolveSupervisionProfile
};
