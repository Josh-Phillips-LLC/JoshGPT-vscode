const vscode = require("vscode");
const {
  inferNativeBaseUrl,
  normalizeBaseUrl,
  listModels: listModelsRequest
} = require("./lmstudio-client");
const { JoshGptSessionViewProvider } = require("./session-view-provider");
const { McpHttpClient } = require("./mcp-client");
const { runChatWithOptionalMcp } = require("./chat-runner");
const { createLocalShellMirror } = require("./local-shell-mirror");
const { resolveInheritedInstructions } = require("./instruction-resolver");
const { resolveSupervisionProfile } = require("./supervision-profile-resolver");
const { checkSupervisorReadiness } = require("./supervisor-readiness");

const DEFAULT_MCP_BASE_URL = "http://127.0.0.1:8790/mcp";
const DEFAULT_NATIVE_BASE_URL = "http://localhost:1234";
const DEFAULT_SUPERVISOR_DISPATCHER_BASE_URL = "http://127.0.0.1:8788/mcp";
const DEFAULT_SUPERVISOR_CAPABILITY_BASE_URL = "http://127.0.0.1:8789/mcp";
const DEFAULT_INSTRUCTION_MAX_CHARS = 30000;
const DEFAULT_LOCAL_SHELL_TERMINAL_NAME = "JoshGPT Local Shell";
let runtimeLocalShellMirror = null;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("joshgpt");
  const rootCfg = vscode.workspace.getConfiguration();
  const baseUrl = normalizeBaseUrl(cfg.get("baseUrl"));
  const nativeBaseUrl = normalizeBaseUrl(
    String(cfg.get("nativeBaseUrl") || inferNativeBaseUrl(baseUrl) || DEFAULT_NATIVE_BASE_URL)
  );
  const chatEndpointMode = String(cfg.get("chatEndpointMode") || "openai-compat").trim();
  const localShellMirrorEnabled = Boolean(cfg.get("localShell.mirrorTerminalEnabled") ?? true);
  const localShellMirrorTerminalName =
    String(cfg.get("localShell.mirrorTerminalName") || DEFAULT_LOCAL_SHELL_TERMINAL_NAME).trim() ||
    DEFAULT_LOCAL_SHELL_TERMINAL_NAME;
  const localShellMirrorReveal = Boolean(cfg.get("localShell.mirrorTerminalReveal") ?? true);

  return {
    baseUrl,
    nativeBaseUrl,
    chatEndpointMode:
      chatEndpointMode === "lmstudio-native-stream"
        ? "lmstudio-native-stream"
        : "openai-compat",
    model: String(cfg.get("model") || "").trim(),
    apiKey: String(cfg.get("apiKey") || "").trim(),
    systemPrompt: String(cfg.get("systemPrompt") || "").trim(),
    temperature: Number(cfg.get("temperature") || 0.2),
    maxTokens: Number(cfg.get("maxTokens") || 512),
    mcpEnabled: Boolean(rootCfg.get("joshgpt.mcp.enabled") ?? true),
    mcpBaseUrl: normalizeBaseUrl(
      String(rootCfg.get("joshgpt.mcp.baseUrl") || DEFAULT_MCP_BASE_URL)
    ),
    mcpTimeoutMs: Number(rootCfg.get("joshgpt.mcp.timeoutMs") || 15000),
    mcpMaxToolRounds: Number(rootCfg.get("joshgpt.mcp.maxToolRounds") || 4),
    supervisorEnabled: Boolean(rootCfg.get("joshgpt.supervisor.enabled") ?? true),
    supervisorModelEscalationEnabled: Boolean(
      rootCfg.get("joshgpt.supervisor.modelEscalationEnabled") ?? true
    ),
    supervisorDispatcherBaseUrl: normalizeBaseUrl(
      String(
        rootCfg.get("joshgpt.supervisor.dispatcherBaseUrl") ||
          DEFAULT_SUPERVISOR_DISPATCHER_BASE_URL
      )
    ),
    supervisorCapabilityBaseUrl: normalizeBaseUrl(
      String(
        rootCfg.get("joshgpt.supervisor.capabilityBaseUrl") ||
          DEFAULT_SUPERVISOR_CAPABILITY_BASE_URL
      )
    ),
    supervisorMaxEscalationsPerTurn: Number(
      rootCfg.get("joshgpt.supervisor.maxEscalationsPerTurn") || 1
    ),
    supervisorMaxEscalationsPerSession: Number(
      rootCfg.get("joshgpt.supervisor.maxEscalationsPerSession") || 3
    ),
    supervisorEscalationCooldownMs: Number(
      rootCfg.get("joshgpt.supervisor.escalationCooldownMs") || 15000
    ),
    supervisorWorkerRoleSlug: String(
      rootCfg.get("joshgpt.supervisor.workerRoleSlug") || ""
    ).trim(),
    supervisorSupervisorRoleSlug: String(
      rootCfg.get("joshgpt.supervisor.supervisorRoleSlug") || ""
    ).trim(),
    instructionsInheritVscodeInstructions: Boolean(
      rootCfg.get("joshgpt.instructions.inheritVscodeInstructions") ?? true
    ),
    instructionsMaxChars: Number(
      rootCfg.get("joshgpt.instructions.maxChars") || DEFAULT_INSTRUCTION_MAX_CHARS
    ),
    localShellEnabled: Boolean(cfg.get("localShell.enabled") ?? true),
    localShellDefaultTimeoutSeconds: Number(
      cfg.get("localShell.defaultTimeoutSeconds") || 30
    ),
    localShellMaxTimeoutSeconds: Number(cfg.get("localShell.maxTimeoutSeconds") || 300),
    localShellDefaultMaxOutputChars: Number(
      cfg.get("localShell.defaultMaxOutputChars") || 12000
    ),
    localShellMaxOutputChars: Number(cfg.get("localShell.maxOutputChars") || 50000),
    localShellMirrorTerminalEnabled: localShellMirrorEnabled,
    localShellMirrorTerminalName: localShellMirrorTerminalName,
    localShellMirrorTerminalReveal: localShellMirrorReveal,
    localShellMirror:
      localShellMirrorEnabled && runtimeLocalShellMirror
        ? {
            onStart: (event) => {
              runtimeLocalShellMirror.onStart({
                ...event,
                terminal_name: localShellMirrorTerminalName,
                reveal: localShellMirrorReveal
              });
            },
            onStdout: (event) => {
              runtimeLocalShellMirror.onStdout(event);
            },
            onStderr: (event) => {
              runtimeLocalShellMirror.onStderr(event);
            },
            onExit: (event) => {
              runtimeLocalShellMirror.onExit(event);
            }
          }
        : null,
    workspaceRoot:
      vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : process.cwd()
  };
}

async function listModels(output) {
  const cfg = getConfig();
  const { modelIds } = await listModelsRequest({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey
  });

  output.appendLine(`[joshgpt] ${cfg.baseUrl}/models`);
  output.appendLine(`[joshgpt] models: ${modelIds.join(", ") || "<none>"}`);

  if (modelIds.length === 0) {
    vscode.window.showWarningMessage("LM Studio returned no models.");
    return;
  }

  const selected = await vscode.window.showQuickPick(modelIds, {
    title: "JoshGPT models (from LM Studio)",
    placeHolder: "Select a model to set joshgpt.model"
  });

  if (!selected) {
    return;
  }

  const hasWorkspaceFolder = (vscode.workspace.workspaceFolders || []).length > 0;
  const target = hasWorkspaceFolder
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  await vscode.workspace.getConfiguration("joshgpt").update("model", selected, target);

  const scopeLabel = hasWorkspaceFolder ? "workspace" : "user";
  vscode.window.showInformationMessage(`joshgpt.model set to ${selected} (${scopeLabel} scope)`);
}

async function askModel(output) {
  const cfg = getConfig();
  if (!cfg.baseUrl) {
    throw new Error("joshgpt.baseUrl is empty.");
  }
  if (!cfg.model) {
    throw new Error("joshgpt.model is empty.");
  }

  const userPrompt = await vscode.window.showInputBox({
    title: "JoshGPT: Ask Model",
    placeHolder: "Enter a prompt for JoshGPT (served by LM Studio)",
    ignoreFocusOut: true
  });

  if (!userPrompt) {
    return;
  }

  const modelMessages = [];
  const instructionInheritance = resolveInheritedInstructions({
    workspaceRoot: cfg.workspaceRoot,
    enabled: cfg.instructionsInheritVscodeInstructions,
    maxChars: cfg.instructionsMaxChars
  });
  if (instructionInheritance.applied && instructionInheritance.systemMessage) {
    modelMessages.push({
      role: "system",
      content: instructionInheritance.systemMessage
    });
  }
  if (cfg.systemPrompt) {
    modelMessages.push({ role: "system", content: cfg.systemPrompt });
  }
  modelMessages.push({ role: "user", content: userPrompt });

  if (cfg.chatEndpointMode === "lmstudio-native-stream") {
    output.appendLine(`[joshgpt] stream request -> ${cfg.nativeBaseUrl}/api/v1/chat`);
  } else {
    output.appendLine(`[joshgpt] completion request -> ${cfg.baseUrl}/chat/completions`);
  }
  output.appendLine(`[joshgpt] model=${cfg.model}`);
  output.appendLine(`[joshgpt] mode=${cfg.chatEndpointMode}`);
  if (cfg.chatEndpointMode === "lmstudio-native-stream") {
    output.appendLine(`[joshgpt] native stream endpoint -> ${cfg.nativeBaseUrl}/api/v1/chat`);
  }
  output.appendLine(
    `[joshgpt] mcp=${cfg.mcpEnabled ? "enabled" : "disabled"} base=${cfg.mcpBaseUrl || "<unset>"}`
  );
  output.appendLine(
    `[joshgpt] supervisor=${cfg.supervisorEnabled ? "enabled" : "disabled"} dispatcher=${cfg.supervisorDispatcherBaseUrl || "<unset>"} capability=${cfg.supervisorCapabilityBaseUrl || "<unset>"}`
  );
  output.appendLine(
    `[joshgpt] inherited_instructions=${instructionInheritance.applied ? "applied" : "not-applied"} canonical=${instructionInheritance.canonicalAvailable ? "yes" : "no"} hash=${instructionInheritance.contentHash || "<none>"} truncated=${instructionInheritance.truncated ? "yes" : "no"}`
  );
  output.appendLine(
    `[joshgpt] local_shell=${cfg.localShellEnabled ? "enabled" : "disabled"}`
  );
  output.appendLine(
    `[joshgpt] local_shell_terminal_mirror=${cfg.localShellMirrorTerminalEnabled ? "enabled" : "disabled"} name="${cfg.localShellMirrorTerminalName}"`
  );

  const { text } = await runChatWithOptionalMcp({
    config: {
      ...cfg,
      instructionInheritance,
      supervisorSessionContext: {
        objective: userPrompt,
        roleContextRef: instructionInheritance.canonicalPath || "workspace://AGENTS.md",
        attemptHistory: [],
        evidenceSummary: "",
        blockedReason: "insufficient_context",
        currentPhase: "validation",
        requestedDecision: "next_step"
      }
    },
    messages: modelMessages,
    output
  });

  output.appendLine("[joshgpt] response received");
  output.appendLine(text);
  output.show(true);

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: text
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function mcpStatus(output) {
  const cfg = getConfig();
  if (!cfg.mcpEnabled) {
    vscode.window.showInformationMessage("JoshGPT MCP is disabled in settings (joshgpt.mcp.enabled=false).");
    return;
  }
  if (!cfg.mcpBaseUrl) {
    throw new Error("joshgpt.mcp.baseUrl is empty.");
  }

  const client = new McpHttpClient({
    baseUrl: cfg.mcpBaseUrl,
    timeoutMs: cfg.mcpTimeoutMs,
    output
  });

  const tools = await client.listTools();
  const names = tools.map((t) => t && t.name).filter(Boolean);
  output.appendLine(`[joshgpt] MCP tools: ${names.join(", ") || "<none>"}`);
  output.show(true);
  vscode.window.showInformationMessage(
    `JoshGPT MCP connected: ${names.length} tool(s) at ${cfg.mcpBaseUrl}`
  );
}

async function supervisorStatus(output) {
  const cfg = getConfig();
  if (!cfg.supervisorEnabled) {
    vscode.window.showInformationMessage(
      "Supervisor flow is disabled (joshgpt.supervisor.enabled=false)."
    );
    return;
  }

  const profile = resolveSupervisionProfile({
    workspaceRoot: cfg.workspaceRoot,
    settingsFallback: {
      workerRoleSlug: cfg.supervisorWorkerRoleSlug,
      supervisorRoleSlug: cfg.supervisorSupervisorRoleSlug
    }
  });
  const readiness = await checkSupervisorReadiness({
    dispatcherBaseUrl: cfg.supervisorDispatcherBaseUrl,
    capabilityBaseUrl: cfg.supervisorCapabilityBaseUrl,
    timeoutMs: cfg.mcpTimeoutMs,
    output
  });
  output.appendLine(`[joshgpt] supervisor_status=${readiness.status}`);
  output.appendLine(`[joshgpt] supervisor_summary=${readiness.summary}`);
  output.appendLine(
    `[joshgpt] supervision_profile_source=${profile.source} resolved=${profile.resolved ? "yes" : "no"}`
  );
  if (profile.warning) {
    output.appendLine(`[joshgpt] supervision_profile_warning=${profile.warning}`);
  }
  if (profile.error) {
    output.appendLine(`[joshgpt] supervision_profile_error=${profile.error}`);
  }
  output.show(true);
  if (readiness.ready && profile.resolved) {
    vscode.window.showInformationMessage("Supervisor readiness check passed.");
  } else {
    const msg = [
      `Supervisor status: ${readiness.status}.`,
      profile.resolved ? "" : `Profile error: ${profile.error || "missing role bindings."}`,
      readiness.summary
    ]
      .filter(Boolean)
      .join(" ");
    vscode.window.showWarningMessage(msg);
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel("JoshGPT");
  output.appendLine("[joshgpt] extension activated");
  runtimeLocalShellMirror = createLocalShellMirror({ output });
  context.subscriptions.push({
    dispose: () => {
      if (runtimeLocalShellMirror) {
        runtimeLocalShellMirror.dispose();
        runtimeLocalShellMirror = null;
      }
    }
  });
  const sessionProvider = new JoshGptSessionViewProvider(context, output, getConfig);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      JoshGptSessionViewProvider.viewType,
      sessionProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("joshgpt.newSession", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.joshgpt");
      await sessionProvider.createSessionFromCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("joshgpt.listModels", async () => {
      try {
        await listModels(output);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[joshgpt] error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("joshgpt.askModel", async () => {
      try {
        await askModel(output);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[joshgpt] error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("joshgpt.mcpStatus", async () => {
      try {
        await mcpStatus(output);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[joshgpt] error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("joshgpt.checkSupervisorStatus", async () => {
      try {
        await supervisorStatus(output);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[joshgpt] error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("joshgpt.escalateToSupervisor", async () => {
      try {
        await vscode.commands.executeCommand("workbench.view.extension.joshgpt");
        await sessionProvider.escalateActiveSessionFromCommand();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[joshgpt] error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
