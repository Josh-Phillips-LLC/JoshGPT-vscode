# JoshGPT VS Code Extension Template (Spike)

This starter provides a minimal `JoshGPT` VS Code extension that supports:
- OpenAI-compatible LM Studio REST API for chat, with local shell tool-calling in the extension host.
- Native LM Studio streaming REST API for rich trace events (including `reasoning.*` when emitted by the model).

## What It Does

- Adds a JoshGPT activity-bar view with persistent chat sessions
- Includes a Trace pane for model/tool execution events per session
- Includes an in-extension Settings panel for editing `joshgpt.*` configuration
- Adds command `JoshGPT: List Models`
- Adds command `JoshGPT: Ask Model`
- Adds command `JoshGPT: New Session`
- Adds command `JoshGPT: MCP Status`
- Provides built-in local shell tool: `run_local_shell_command`
- Supports endpoint modes:
  - `openai-compat` (default)
  - `lmstudio-native-stream`
- Uses OpenAI-compatible endpoints:
  - `GET /v1/models`
  - `POST /v1/chat/completions`

## Files

- `package.json` - extension manifest and settings
- `src/extension.js` - extension activation + command wiring
- `src/session-store.js` - persisted session state
- `src/session-view-provider.js` - webview session UI
- `src/lmstudio-client.js` - LM Studio API client
- `src/mcp-client.js` - MCP HTTP client (streamable-http)
- `src/local-shell-tool.js` - extension-host local shell tool execution
- `src/local-shell-mirror.js` - dedicated terminal mirror for local shell tool calls
- `src/chat-runner.js` - LM Studio + local shell + optional MCP tool-call loop
- `scripts/smoke-test.sh` - endpoint smoke test (outside VS Code)

## Quick Start

1. Copy this folder to a new extension workspace (or use it in place for spike testing).
2. Run `npm install` (this template has no required runtime dependencies).
3. Press `F5` in VS Code to launch an Extension Development Host.
4. In the Extension Host:
   - Open the `JoshGPT` icon in the Activity Bar
   - Create or select a session, then chat in the sidebar
   - Run `JoshGPT: MCP Status` to verify tool connectivity
   - Run `JoshGPT: List Models`
   - Run `JoshGPT: Ask Model`

## Session UI Behavior

- Sessions are stored in extension global state (`joshgpt.sessions.v1`) and survive window reloads.
- `Send` in the sidebar sends full in-session message history + `joshgpt.systemPrompt`.
- `Cmd+Enter` (or `Ctrl+Enter`) sends the current prompt.
- If no workspace folder is open, selecting a model still works (writes to user settings scope).
- Trace pane shows execution events, not hidden model chain-of-thought tokens.
- In native stream mode, trace includes raw stream event names and payload snippets.
- Output channel logs tool calls with argument payloads (redacted/truncated for sensitive/large values).
- Local shell execution is mirrored to a `JoshGPT Local Shell` terminal by default.
- Settings pane accepts JSON for supported keys, then writes through VS Code config APIs (User or Workspace scope).

## Package Test

Create a VSIX:

```bash
npm run package:vsix
```

Install into an isolated extensions directory:

```bash
code --extensions-dir /tmp/vscode-lmstudio-ext-test \
  --install-extension ./joshgpt-0.0.9.vsix --force
```

Verify:

```bash
code --extensions-dir /tmp/vscode-lmstudio-ext-test --list-extensions | grep joshgpt
```

## Settings

- `joshgpt.baseUrl`
  - Host default: `http://localhost:1234/v1`
  - Devcontainer default recommendation: `http://host.docker.internal:1234/v1`
- `joshgpt.chatEndpointMode`
  - `openai-compat`: OpenAI-style endpoint with MCP tool calling.
  - `lmstudio-native-stream`: Native `/api/v1/chat` streaming endpoint.
- `joshgpt.nativeBaseUrl`
  - Host default: `http://localhost:1234`
- `joshgpt.model`
- `joshgpt.apiKey`
  - LM Studio commonly accepts any bearer string (for example `lm-studio`)
- `joshgpt.systemPrompt`
- `joshgpt.temperature`
- `joshgpt.maxTokens`
- `joshgpt.mcp.enabled`
- `joshgpt.mcp.baseUrl`
  - Recommended local default: `http://127.0.0.1:8790/mcp`
- `joshgpt.mcp.timeoutMs`
- `joshgpt.mcp.maxToolRounds`
- `joshgpt.localShell.enabled`
- `joshgpt.localShell.defaultTimeoutSeconds`
- `joshgpt.localShell.maxTimeoutSeconds`
- `joshgpt.localShell.defaultMaxOutputChars`
- `joshgpt.localShell.maxOutputChars`
- `joshgpt.localShell.mirrorTerminalEnabled`
- `joshgpt.localShell.mirrorTerminalName`
- `joshgpt.localShell.mirrorTerminalReveal`

## Tool Calling (OpenAI-Compatible Mode)

- JoshGPT always exposes `run_local_shell_command` when `joshgpt.localShell.enabled=true`.
  - Commands run in the extension host environment.
  - If VS Code is attached to a container, the command runs in that container.
  - Mirror mode writes command/output/exit status to a dedicated terminal (`joshgpt.localShell.mirrorTerminal*` settings).
- When `joshgpt.mcp.enabled=true`, JoshGPT also loads MCP tool metadata via `tools/list`.
- MCP execution tools (`run_host_command`, `run_container_command`) are intentionally excluded from model exposure in JoshGPT.
- Non-exec MCP tools are still available and executed through MCP `tools/call`.
- The loop stops when the model returns a normal assistant response or `joshgpt.mcp.maxToolRounds` is reached.

## Native Streaming Mode

- Set `joshgpt.chatEndpointMode=lmstudio-native-stream`.
- JoshGPT calls `POST /api/v1/chat` with `stream: true` at `joshgpt.nativeBaseUrl`.
- Trace pane records stream events and payload snippets. If your model emits reasoning events, you will see entries like `reasoning.start`, `reasoning.delta`, and `reasoning.end`.

### MCP Prerequisite (Optional)

Run `JoshGPT-MCP` and expose it (example at `127.0.0.1:8790`):

```bash
cd /Users/josh/Projects/JoshGPT-MCP
cp .env.example .env
JOSHGPT_MCP_PUBLISH_PORT=8790 docker compose up -d
```

## Smoke Test

Run from this template directory:

```bash
LMSTUDIO_BASE_URL=http://localhost:1234/v1 \
bash ./scripts/smoke-test.sh
```

Run the direct client-module self-test used by the extension:

```bash
LMSTUDIO_BASE_URL=http://localhost:1234/v1 \
npm run test:client
```

Run local shell self-test:

```bash
npm run test:local-shell
```

Run native streaming self-test:

```bash
LMSTUDIO_BASE_URL=http://localhost:1234/v1 \
LMSTUDIO_NATIVE_BASE_URL=http://localhost:1234 \
npm run test:native
```

For container-based testing, use:

```bash
LMSTUDIO_BASE_URL=http://host.docker.internal:1234/v1 \
bash ./scripts/smoke-test.sh
```

Optionally pin a specific model:

```bash
LMSTUDIO_MODEL=oss20b-local bash ./scripts/smoke-test.sh
```

```bash
LMSTUDIO_MODEL=oss20b-local npm run test:client
```

## Notes

- This is intentionally a small spike, not a full agent orchestration extension.
- Tool-calling/MCP orchestration can be layered on after basic chat reliability is proven.
