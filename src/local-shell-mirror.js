"use strict";

const vscode = require("vscode");

function toTerminalText(value) {
  return String(value || "").replace(/\r?\n/g, "\r\n");
}

function nowTimeStamp() {
  return new Date().toISOString().slice(11, 19);
}

function createLocalShellMirror({ output } = {}) {
  let terminal = null;
  let emitter = null;
  let terminalName = "";

  function ensureTerminal(name) {
    const requestedName = String(name || "JoshGPT Local Shell").trim() || "JoshGPT Local Shell";
    if (terminal && emitter && terminalName === requestedName) {
      return;
    }
    if (terminal) {
      terminal.dispose();
      terminal = null;
    }
    if (emitter) {
      emitter.dispose();
      emitter = null;
    }

    emitter = new vscode.EventEmitter();
    terminal = vscode.window.createTerminal({
      name: requestedName,
      pty: {
        onDidWrite: emitter.event,
        open: () => {},
        close: () => {}
      }
    });
    terminalName = requestedName;
  }

  function write(text) {
    if (!emitter) {
      return;
    }
    emitter.fire(toTerminalText(text));
  }

  function onStart(event) {
    const command = String(event && event.command ? event.command : "").trim();
    const cwd = String(event && event.cwd ? event.cwd : "").trim();
    const shell = String(event && event.shell ? event.shell : "").trim();
    const timeoutSeconds = Number(event && event.timeout_seconds ? event.timeout_seconds : 0);
    const reveal = Boolean(event && typeof event.reveal === "boolean" ? event.reveal : true);

    ensureTerminal(event && event.terminal_name);
    if (terminal && reveal) {
      terminal.show(true);
    }

    write(`\r\n[${nowTimeStamp()}] JoshGPT local shell command\r\n`);
    write(`cwd: ${cwd}\r\n`);
    write(`shell: ${shell}\r\n`);
    write(`timeout: ${timeoutSeconds}s\r\n`);
    write(`$ ${command}\r\n`);

    if (output) {
      output.appendLine(`[joshgpt] mirrored local shell command in terminal "${terminalName}"`);
    }
  }

  function onStdout(event) {
    write(event && event.text ? event.text : "");
  }

  function onStderr(event) {
    write(event && event.text ? event.text : "");
  }

  function onExit(event) {
    const exitCode = Number(event && event.exit_code ? event.exit_code : 0);
    const signal = String(event && event.signal ? event.signal : "");
    const timedOut = Boolean(event && event.timed_out);
    const duration = Number(event && event.duration_ms ? event.duration_ms : 0);
    write(`\r\n[${nowTimeStamp()}] exit_code=${exitCode} signal=${signal || "-"} timed_out=${timedOut} duration_ms=${duration}\r\n`);
  }

  function dispose() {
    if (terminal) {
      terminal.dispose();
      terminal = null;
    }
    if (emitter) {
      emitter.dispose();
      emitter = null;
    }
  }

  return {
    onStart,
    onStdout,
    onStderr,
    onExit,
    dispose
  };
}

module.exports = {
  createLocalShellMirror
};
