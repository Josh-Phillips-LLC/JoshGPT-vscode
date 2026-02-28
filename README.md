# JoshGPT VS Code Extension

JoshGPT VS Code extension for LM Studio with MCP tools, canonical workspace instruction inheritance, and Codex-CLI supervisor escalation via JoshGPT-MCP.

## Current Runtime Model

- Chat backend: LM Studio (`openai-compat` or `lmstudio-native-stream`).
- MCP tools: loaded from `joshgpt.mcp.baseUrl` (execution tools are hidden from model exposure).
- Supervisor escalation: model-first + extension-side wrapper orchestration.
  - Wrapper internally orchestrates:
    - `dispatch_role_task`
    - `submit_supervisor_question`
    - `ask_codex_supervisor`
    - `respond_supervisor_question`
  - Shared tokens are read from extension process env only:
    - `JOSHGPT_DISPATCHER_SHARED_TOKEN`
    - `JOSHGPT_SUPERVISOR_SHARED_TOKEN`
  - Raw token fields are never model-visible.

## Supervisor Trigger Model

- Default behavior: prompts go to the local model first; the model decides when to call `request_codex_supervisor_decision`.
- Model-visible supervisor args are intentionally minimal (`question` + optional reason/context fields).
- Extension injects role/scope metadata from profile resolution (never from model-provided token/role fields).
- Manual fallback is available:
  - Command Palette: `JoshGPT: Escalate To Supervisor`
  - Session UI: `Escalate` button

Guardrails:

- per-turn escalation cap (`joshgpt.supervisor.maxEscalationsPerTurn`)
- per-session escalation cap (`joshgpt.supervisor.maxEscalationsPerSession`)
- cooldown / duplicate suppression (`joshgpt.supervisor.escalationCooldownMs`)

Readiness:

- automatic preflight in prompt runs
- manual status check via `JoshGPT: Check Supervisor Status`

## Supervision Profile Resolution

Role bindings are resolved in this order:

1. `<workspaceRoot>/.joshgpt/supervision.json` (canonical)
2. settings fallback:
   - `joshgpt.supervisor.workerRoleSlug`
   - `joshgpt.supervisor.supervisorRoleSlug`

Canonical profile format:

```json
{
  "version": 1,
  "worker_role_slug": "implementation-specialist",
  "supervisor_role_slug": "hr-ai-agent-specialist",
  "authorized_scope_id": "extension-supervisor-scope",
  "authorized_targets": ["workspace"],
  "requested_decision_default": "next_step"
}
```

## Instruction Inheritance

For each request path (`Ask Model` and session chat), inherited instruction context is prepended as a system message when enabled.

Resolution order:

1. `<workspaceRoot>/AGENTS.md` (canonical)
2. `/workspace/instructions/role-instructions.md`
3. `<workspaceRoot>/.github/copilot-instructions.md`
4. `/workspace/instructions/AGENTS.md`
5. `/workspace/instructions/agent-runtime-policy.md`

Trace metadata includes:

- chosen canonical source
- fallback path used (if canonical missing)
- truncation state
- content hash

## Key Files

- `src/extension.js` - activation, config loading, command wiring
- `src/session-view-provider.js` - session UI + send path
- `src/chat-runner.js` - model/tool loop + supervisor gating behavior
- `src/instruction-resolver.js` - canonical-first inherited instruction resolver
- `src/supervisor-wrapper-tool.js` - model-visible supervisor wrapper implementation
- `src/mcp-client.js` - MCP HTTP client
- `src/local-shell-tool.js` - extension-host shell tool

## Settings

Existing settings remain. Added cutover settings:

- `joshgpt.supervisor.enabled`
- `joshgpt.supervisor.modelEscalationEnabled`
- `joshgpt.supervisor.dispatcherBaseUrl`
- `joshgpt.supervisor.capabilityBaseUrl`
- `joshgpt.supervisor.maxEscalationsPerTurn`
- `joshgpt.supervisor.maxEscalationsPerSession`
- `joshgpt.supervisor.escalationCooldownMs`
- `joshgpt.supervisor.workerRoleSlug`
- `joshgpt.supervisor.supervisorRoleSlug`
- `joshgpt.instructions.inheritVscodeInstructions`
- `joshgpt.instructions.maxChars`

## Supervisor Decision Gating

When supervisor wrapper returns:

- `pause_for_human` or `stop`: tool loop terminates immediately and returns guarded assistant output.
- `proceed`, `retry`, or `replan`: loop continues with structured tool result context.

## Setup

1. Start LM Studio endpoint.
2. Start JoshGPT-MCP stack.
3. Configure extension settings:
   - `joshgpt.mcp.baseUrl`
   - `joshgpt.supervisor.dispatcherBaseUrl`
   - `joshgpt.supervisor.capabilityBaseUrl`
4. Launch VS Code Extension Host (`F5`).
5. Ensure env tokens exist in extension host process:
   - `JOSHGPT_DISPATCHER_SHARED_TOKEN`
   - `JOSHGPT_SUPERVISOR_SHARED_TOKEN`

MCP stack example:

```bash
cd /Users/josh/Projects/Josh-Phillips-LLC/JoshGPT-MCP
cp .env.example .env
docker compose up --build -d
```

## Tests

```bash
npm run test:client
npm run test:local-shell
npm run test:native
npm run test:mcp
npm run test:instructions
npm run test:supervision-profile
npm run test:supervisor-readiness
npm run test:supervisor-wrapper
```

## Packaging

```bash
npm run package:latest-vsix
```
