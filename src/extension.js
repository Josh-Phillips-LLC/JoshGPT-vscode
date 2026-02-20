const vscode = require("vscode");
const {
  normalizeBaseUrl,
  listModels: listModelsRequest,
  createChatCompletion
} = require("./lmstudio-client");
const { JoshGptSessionViewProvider } = require("./session-view-provider");

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("joshgpt");
  return {
    baseUrl: normalizeBaseUrl(cfg.get("baseUrl")),
    model: String(cfg.get("model") || "").trim(),
    apiKey: String(cfg.get("apiKey") || "").trim(),
    systemPrompt: String(cfg.get("systemPrompt") || "").trim(),
    temperature: Number(cfg.get("temperature") || 0.2),
    maxTokens: Number(cfg.get("maxTokens") || 512)
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

  const payload = {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    userPrompt,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens
  };

  output.appendLine(`[joshgpt] POST ${cfg.baseUrl}/chat/completions`);
  output.appendLine(`[joshgpt] model=${cfg.model}`);

  const { text } = await createChatCompletion(payload);

  output.appendLine("[joshgpt] response received");
  output.appendLine(text);
  output.show(true);

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: text
  });
  await vscode.window.showTextDocument(doc, { preview: false });
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
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
