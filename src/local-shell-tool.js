"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const LOCAL_SHELL_TOOL_NAME = "run_local_shell_command";

function asInt(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function bounded(value, min, max, fallback) {
  const parsed = asInt(value, fallback);
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
}

function truncateText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const suffix = "\n...[truncated]";
  const headBudget = Math.max(0, maxChars - suffix.length);
  return {
    text: `${text.slice(0, headBudget)}${suffix}`,
    truncated: true
  };
}

function appendLimitedText(state, chunk, maxChars) {
  const text = String(chunk || "");
  if (!text) {
    return;
  }
  if (state.text.length >= maxChars) {
    state.truncated = true;
    return;
  }
  const remaining = maxChars - state.text.length;
  if (text.length > remaining) {
    state.text += text.slice(0, remaining);
    state.truncated = true;
    return;
  }
  state.text += text;
}

function asFinalText(state, maxChars) {
  const base = truncateText(state.text || "", maxChars);
  return {
    text: base.text,
    truncated: Boolean(base.truncated || state.truncated)
  };
}

function safeMirrorCall(mirror, methodName, payload) {
  if (!mirror || typeof mirror[methodName] !== "function") {
    return;
  }
  try {
    mirror[methodName](payload);
  } catch {
    // Mirror is best-effort and must not break command execution.
  }
}

function pickShell(command) {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoProfile", "-Command", command]
    };
  }
  if (fs.existsSync("/bin/bash")) {
    return {
      executable: "/bin/bash",
      args: ["-lc", command]
    };
  }
  return {
    executable: "/bin/sh",
    args: ["-lc", command]
  };
}

function resolveCwd(rawCwd, workspaceRoot) {
  const fallback = String(workspaceRoot || process.cwd() || ".").trim() || ".";
  const requested = String(rawCwd || "").trim();
  const candidate = requested
    ? (path.isAbsolute(requested) ? requested : path.resolve(fallback, requested))
    : fallback;
  const normalized = path.resolve(candidate);
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
    throw new Error(`Working directory does not exist or is not a directory: ${normalized}`);
  }
  return normalized;
}

function getLocalShellOpenAiTool() {
  return {
    type: "function",
    function: {
      name: LOCAL_SHELL_TOOL_NAME,
      description:
        "Run a shell command in the current extension host environment. " +
        "When VS Code is attached to a container, this runs inside that container.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            description: "Shell command text to execute."
          },
          cwd: {
            type: "string",
            description:
              "Optional working directory. Relative paths resolve from current workspace root."
          },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: 900,
            description: "Optional timeout in seconds."
          },
          max_output_chars: {
            type: "integer",
            minimum: 256,
            maximum: 200000,
            description: "Optional max characters kept for stdout and stderr."
          }
        },
        required: ["command"]
      }
    }
  };
}

async function runLocalShellToolCall(
  input,
  {
    workspaceRoot,
    defaultTimeoutSeconds = 30,
    maxTimeoutSeconds = 300,
    defaultMaxOutputChars = 12000,
    maxOutputCharsCap = 50000,
    mirror = null
  } = {}
) {
  const command = String(input && input.command ? input.command : "").trim();
  if (!command) {
    throw new Error("run_local_shell_command requires a non-empty 'command'.");
  }

  const cwd = resolveCwd(input && input.cwd, workspaceRoot);
  const timeoutSeconds = bounded(
    input && input.timeout_seconds,
    1,
    Math.max(1, asInt(maxTimeoutSeconds, 300)),
    Math.max(1, asInt(defaultTimeoutSeconds, 30))
  );
  const maxOutputChars = bounded(
    input && input.max_output_chars,
    256,
    Math.max(256, asInt(maxOutputCharsCap, 50000)),
    Math.max(256, asInt(defaultMaxOutputChars, 12000))
  );

  const shell = pickShell(command);
  const startedAt = Date.now();

  safeMirrorCall(mirror, "onStart", {
    tool: LOCAL_SHELL_TOOL_NAME,
    command,
    cwd,
    shell: shell.executable,
    shell_args: shell.args,
    timeout_seconds: timeoutSeconds,
    max_output_chars: maxOutputChars,
    started_at: new Date(startedAt).toISOString()
  });

  return new Promise((resolve) => {
    const child = spawn(shell.executable, shell.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutState = { text: "", truncated: false };
    const stderrState = { text: "", truncated: false };
    let spawnError = null;
    let timedOut = false;
    let timeoutHandle = null;

    function clearTimer() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore signal failures.
      }
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore signal failures.
          }
        }
      }, 1000);
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      appendLimitedText(stdoutState, text, maxOutputChars);
      safeMirrorCall(mirror, "onStdout", { text });
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      appendLimitedText(stderrState, text, maxOutputChars);
      safeMirrorCall(mirror, "onStderr", { text });
    });

    child.on("error", (err) => {
      spawnError = err || new Error("Failed to spawn local shell command.");
    });

    child.on("close", (code, signalValue) => {
      clearTimer();
      const elapsedMs = Date.now() - startedAt;
      const stdoutTrunc = asFinalText(stdoutState, maxOutputChars);
      const stderrTrunc = asFinalText(stderrState, maxOutputChars);

      let exitCode = typeof code === "number" ? code : 0;
      let signal = String(signalValue || "");
      if (spawnError) {
        exitCode = typeof spawnError.code === "number" ? spawnError.code : 1;
        signal = String(signal || spawnError.signal || "");
      }

      const result = {
        tool: LOCAL_SHELL_TOOL_NAME,
        environment: "extension-host",
        command,
        cwd,
        shell: shell.executable,
        timeout_seconds: timeoutSeconds,
        max_output_chars: maxOutputChars,
        duration_ms: elapsedMs,
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        stdout: stdoutTrunc.text,
        stderr: stderrTrunc.text,
        stdout_truncated: stdoutTrunc.truncated,
        stderr_truncated: stderrTrunc.truncated
      };

      safeMirrorCall(mirror, "onExit", result);
      resolve(result);
    });
  });
}

module.exports = {
  LOCAL_SHELL_TOOL_NAME,
  getLocalShellOpenAiTool,
  runLocalShellToolCall
};
