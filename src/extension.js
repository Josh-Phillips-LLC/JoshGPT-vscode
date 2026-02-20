const vscode = require("vscode");
const {
  inferNativeBaseUrl,
  normalizeBaseUrl,
  listModels: listModelsRequest
} = require("./lmstudio-client");
const { JoshGptSessionViewProvider } = require("./session-view-provider");
const { McpHttpClient } = require("./mcp-client");
const { runChatWithOptionalMcp } = require("./chat-runner");

const DEFAULT_MCP_BASE_URL = "http://127.0.0.1:8790/mcp";
const DEFAULT_NATIVE_BASE_URL = "http://localhost:1234";

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("joshgpt");
  const rootCfg = vscode.workspace.getConfiguration();
  const baseUrl = normalizeBaseUrl(cfg.get("baseUrl"));
  const nativeBaseUrl = normalizeBaseUrl(
    String(cfg.get("nativeBaseUrl") || inferNativeBaseUrl(baseUrl) || DEFAULT_NATIVE_BASE_URL)
  );
  const chatEndpointMode = String(cfg.get("chatEndpointMode") || "openai-compat").trim();
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
    mcpMaxToolRounds: Number(rootCfg.get("joshgpt.mcp.maxToolRounds") || 4)
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

  const { text } = await runChatWithOptionalMcp({
    config: cfg,
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

function activate(context) {
  const output = vscode.window.createOutputChannel("JoshGPT");
  output.appendLine("[joshgpt] extension activated");
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
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
