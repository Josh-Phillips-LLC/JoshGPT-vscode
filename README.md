# JoshGPT VS Code Extension Template (Spike)

This starter provides a minimal `JoshGPT` VS Code extension that calls LM Studio through its OpenAI-compatible REST API.

## What It Does

- Adds a JoshGPT activity-bar view with persistent chat sessions
- Adds command `JoshGPT: List Models`
- Adds command `JoshGPT: Ask Model`
- Adds command `JoshGPT: New Session`
- Uses OpenAI-compatible endpoints:
  - `GET /v1/models`
  - `POST /v1/chat/completions`

## Files

- `package.json` - extension manifest and settings
- `src/extension.js` - extension activation + command wiring
- `src/session-store.js` - persisted session state
- `src/session-view-provider.js` - webview session UI
- `src/lmstudio-client.js` - LM Studio API client
- `scripts/smoke-test.sh` - endpoint smoke test (outside VS Code)

## Quick Start

1. Copy this folder to a new extension workspace (or use it in place for spike testing).
2. Run `npm install` (this template has no required runtime dependencies).
3. Press `F5` in VS Code to launch an Extension Development Host.
4. In the Extension Host:
   - Open the `JoshGPT` icon in the Activity Bar
   - Create or select a session, then chat in the sidebar
   - Run `JoshGPT: List Models`
   - Run `JoshGPT: Ask Model`

## Session UI Behavior

- Sessions are stored in extension global state (`joshgpt.sessions.v1`) and survive window reloads.
- `Send` in the sidebar sends full in-session message history + `joshgpt.systemPrompt`.
- `Cmd+Enter` (or `Ctrl+Enter`) sends the current prompt.
- If no workspace folder is open, selecting a model still works (writes to user settings scope).

## Package Test

Create a VSIX:

```bash
npm run package:vsix
```

Install into an isolated extensions directory:

```bash
code --extensions-dir /tmp/vscode-lmstudio-ext-test \
  --install-extension ./joshgpt-0.0.1.vsix --force
```

Verify:

```bash
code --extensions-dir /tmp/vscode-lmstudio-ext-test --list-extensions | grep joshgpt
```

## Settings

- `joshgpt.baseUrl`
  - Host default: `http://localhost:1234/v1`
  - Devcontainer default recommendation: `http://host.docker.internal:1234/v1`
- `joshgpt.model`
- `joshgpt.apiKey`
  - LM Studio commonly accepts any bearer string (for example `lm-studio`)
- `joshgpt.systemPrompt`
- `joshgpt.temperature`
- `joshgpt.maxTokens`

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
