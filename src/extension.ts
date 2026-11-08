import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClaudePaths, findTranscriptDir } from './core/paths';
import {
  restoreUserMcp,
  setMcpDisabled,
  setPluginGlobal,
  setPluginOverride,
  stashUserMcp,
} from './core/writer';
import { loadState } from './state';
import { InventoryStatusBar } from './statusBar';
import { InventoryDecorations, InventoryNode, InventoryProvider } from './tree';

const MCP_WRITE_MESSAGE =
  'Applies to new Claude Code sessions in this folder. A Claude Code session running right now may overwrite this; if the change does not stick, close it and toggle again.';
const PLUGIN_WRITE_MESSAGE =
  'Applies to new Claude Code sessions in this folder.';

export function activate(context: vscode.ExtensionContext): void {
  try {
    activateInner(context);
  } catch (err) {
    showError(err);
  }
}

function activateInner(context: vscode.ExtensionContext): void {
  const paths = ClaudePaths();
  const provider = new InventoryProvider();
  const statusBar = new InventoryStatusBar();
  context.subscriptions.push(provider, statusBar);

  const treeView = vscode.window.createTreeView('claudeInventory.view', {
    treeDataProvider: provider,
  });
  treeView.message =
    'Badges: U user · P project · L local · PG plugin · C claude.ai · B built-in';
  context.subscriptions.push(
    treeView,
    vscode.window.registerFileDecorationProvider(new InventoryDecorations()),
  );

  let running = false;
  let queued = false;
  let waiters: Array<{
    resolve: () => void;
    reject: (reason: unknown) => void;
  }> = [];

  /**
   * Refresh requests that arrive while a scan is running are coalesced into one
   * extra scan. All callers resolve when their data has been rendered.
   */
  function requestRefresh(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
      queued = true;
      if (!running) {
        void drainRefresh();
      }
    });
  }

  async function drainRefresh(): Promise<void> {
    running = true;
    try {
      while (queued) {
        queued = false;
        const batch = waiters;
        waiters = [];
        try {
          await loadAndRender();
          for (const waiter of batch) {
            waiter.resolve();
          }
        } catch (err) {
          for (const waiter of batch) {
            waiter.reject(err);
          }
        }
      }
    } finally {
      running = false;
    }
  }

  async function loadAndRender(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      provider.setWorkspaceMissing(true);
      statusBar.hide();
      return;
    }

    const projectPath = folder.uri.fsPath;
    const configured = vscode.workspace
      .getConfiguration('claudeInventory')
      .get<number>('usageWindowDays', 30);
    const windowDays =
      Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : 30;

    const state = await loadState(projectPath, ClaudePaths(), windowDays);
    provider.setState(state);
    statusBar.update(state);
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRefresh(): void {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void requestRefresh().catch(showError);
    }, 800);
  }

  context.subscriptions.push({
    dispose: () => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
    },
  });

  function createWatcher(base: vscode.Uri, pattern: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(base, pattern),
    );
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
    return watcher;
  }

  const homeWatchers = [
    createWatcher(vscode.Uri.file(paths.home), '.claude.json'),
    createWatcher(vscode.Uri.file(paths.claudeDir), 'settings.json'),
    createWatcher(
      vscode.Uri.file(path.dirname(paths.installedPlugins)),
      'installed_plugins.json',
    ),
  ];
  context.subscriptions.push(...homeWatchers);

  let projectWatchers: vscode.FileSystemWatcher[] = [];

  function disposeProjectWatchers(): void {
    for (const watcher of projectWatchers) {
      watcher.dispose();
    }
    projectWatchers = [];
  }

  function configureProjectWatchers(): void {
    disposeProjectWatchers();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    const root = folder.uri;
    projectWatchers = [
      createWatcher(root, '.mcp.json'),
      createWatcher(root, '.claude/**'),
    ];
    const transcriptDir = findTranscriptDir(paths, folder.uri.fsPath);
    if (transcriptDir) {
      projectWatchers.push(
        createWatcher(vscode.Uri.file(transcriptDir), '*.jsonl'),
      );
    } else {
      // No transcript folder yet: watch the root so the first session shows up.
      projectWatchers.push(
        createWatcher(vscode.Uri.file(paths.transcriptsRoot), '**/*.jsonl'),
      );
    }
  }

  context.subscriptions.push({ dispose: disposeProjectWatchers });

  function currentProjectPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  function asNode(arg: unknown): InventoryNode | undefined {
    return arg instanceof InventoryNode ? arg : undefined;
  }

  async function pickNode(
    nodes: InventoryNode[],
    placeHolder: string,
    emptyMessage: string,
  ): Promise<InventoryNode | undefined> {
    if (nodes.length === 0) {
      await vscode.window.showInformationMessage(emptyMessage);
      return undefined;
    }
    const items = nodes.map((node) => {
      const label =
        typeof node.label === 'string' ? node.label : node.label?.label ?? '';
      const description =
        typeof node.description === 'string' ? node.description : undefined;
      return { label, description, node };
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder,
      matchOnDescription: true,
    });
    return picked?.node;
  }

  async function resolveMcpNode(
    arg: unknown,
    disabled: boolean,
  ): Promise<InventoryNode | undefined> {
    // `disabled` is the target state, so a usable node is currently the opposite.
    const node = asNode(arg);
    if (
      node &&
      node.kind === 'mcp' &&
      node.mcpId &&
      node.mcpDisabled === !disabled &&
      !node.contextValue?.startsWith('mcp:stashed')
    ) {
      return node;
    }
    const candidates = provider
      .getAllNodes()
      .filter(
        (candidate) =>
          candidate.kind === 'mcp' &&
          candidate.mcpId !== undefined &&
          candidate.mcpDisabled === !disabled &&
          !candidate.contextValue?.startsWith('mcp:stashed'),
      );
    return pickNode(
      candidates,
      disabled ? 'Select an MCP server to disable' : 'Select an MCP server to enable',
      disabled
        ? 'No enabled MCP servers to disable.'
        : 'No disabled MCP servers to enable.',
    );
  }

  async function resolvePluginNode(
    arg: unknown,
    mode: 'disable' | 'enable' | 'reset',
  ): Promise<InventoryNode | undefined> {
    const matches = (node: InventoryNode): boolean => {
      if (node.kind !== 'plugin' || node.pluginKey === undefined) {
        return false;
      }
      if (mode === 'disable') {
        return node.pluginEnabled === true;
      }
      if (mode === 'enable') {
        return node.pluginEnabled === false;
      }
      return node.hasLocalOverride === true;
    };

    const node = asNode(arg);
    if (node && matches(node)) {
      return node;
    }
    const placeHolder =
      mode === 'disable'
        ? 'Select a plugin to disable'
        : mode === 'enable'
          ? 'Select a plugin to enable'
          : 'Select a plugin override to reset';
    const emptyMessage =
      mode === 'disable'
        ? 'No enabled plugins to disable.'
        : mode === 'enable'
          ? 'No disabled plugins to enable.'
          : 'No local plugin overrides to reset.';
    return pickNode(provider.getAllNodes().filter(matches), placeHolder, emptyMessage);
  }

  async function guard(fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      showError(err);
    }
  }

  function registerCommand(
    id: string,
    handler: (...args: unknown[]) => Promise<void> | void,
  ): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args: unknown[]) =>
        guard(() => handler(...args)),
      ),
    );
  }

  registerCommand('claudeInventory.refresh', async () => {
    await requestRefresh();
  });

  registerCommand('claudeInventory.disableMcp', async (arg) => {
    const node = await resolveMcpNode(arg, true);
    if (!node || !node.mcpId) {
      return;
    }
    const id = node.mcpId;
    const projectPath = currentProjectPath();
    if (!projectPath) {
      await vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    await setMcpDisabled(paths, projectPath, id, true);
    await requestRefresh();
    await vscode.window.showInformationMessage(MCP_WRITE_MESSAGE);
  });

  registerCommand('claudeInventory.enableMcp', async (arg) => {
    const node = await resolveMcpNode(arg, false);
    if (!node || !node.mcpId) {
      return;
    }
    const id = node.mcpId;
    const projectPath = currentProjectPath();
    if (!projectPath) {
      await vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    await setMcpDisabled(paths, projectPath, id, false);
    await requestRefresh();
    await vscode.window.showInformationMessage(MCP_WRITE_MESSAGE);
  });

  registerCommand('claudeInventory.disablePlugin', async (arg) => {
    const node = await resolvePluginNode(arg, 'disable');
    if (!node || !node.pluginKey) {
      return;
    }
    const pluginKey = node.pluginKey;
    const projectPath = currentProjectPath();
    if (!projectPath) {
      await vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    await setPluginOverride(projectPath, pluginKey, false);
    await requestRefresh();
    await vscode.window.showInformationMessage(PLUGIN_WRITE_MESSAGE);
  });

  registerCommand('claudeInventory.enablePlugin', async (arg) => {
    const node = await resolvePluginNode(arg, 'enable');
    if (!node || !node.pluginKey) {
      return;
    }
    const pluginKey = node.pluginKey;
    const projectPath = currentProjectPath();
    if (!projectPath) {
      await vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    await setPluginOverride(projectPath, pluginKey, true);
    await requestRefresh();
    await vscode.window.showInformationMessage(PLUGIN_WRITE_MESSAGE);
  });

  registerCommand('claudeInventory.resetPlugin', async (arg) => {
    const node = await resolvePluginNode(arg, 'reset');
    if (!node || !node.pluginKey) {
      return;
    }
    const pluginKey = node.pluginKey;
    const projectPath = currentProjectPath();
    if (!projectPath) {
      await vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    await setPluginOverride(projectPath, pluginKey, null);
    await requestRefresh();
    await vscode.window.showInformationMessage(PLUGIN_WRITE_MESSAGE);
  });

  registerCommand('claudeInventory.disableMcpGlobal', async (arg) => {
    const node = asNode(arg);
    if (!node?.mcpId || !node.contextValue?.startsWith('mcp:on:user')) {
      await vscode.window.showInformationMessage(
        'Only user-level MCP servers can be disabled for all projects. For a plugin server, disable the plugin; claude.ai connectors are managed on claude.ai.',
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Disable "${node.mcpId}" in ALL projects? Its config moves to ~/.claude/mcp-disabled-stash.json and can be restored from this view.`,
      { modal: true },
      'Disable everywhere',
    );
    if (choice === undefined) {
      return;
    }
    await stashUserMcp(paths, node.mcpId);
    await requestRefresh();
    await vscode.window.showInformationMessage(MCP_WRITE_MESSAGE);
  });

  registerCommand('claudeInventory.enableMcpGlobal', async (arg) => {
    const node = asNode(arg);
    if (!node?.mcpId || !node.contextValue?.startsWith('mcp:stashed')) {
      return;
    }
    await restoreUserMcp(paths, node.mcpId);
    await requestRefresh();
    await vscode.window.showInformationMessage(MCP_WRITE_MESSAGE);
  });

  async function setPluginEverywhere(arg: unknown, value: boolean): Promise<void> {
    const node = asNode(arg);
    if (node?.kind !== 'plugin' || node.pluginKey === undefined) {
      return;
    }
    // A project override would hide the change, so drop it too.
    const projectPath = currentProjectPath();
    if (projectPath && node.hasLocalOverride) {
      await setPluginOverride(projectPath, node.pluginKey, null);
    }
    await setPluginGlobal(paths, node.pluginKey, value);
    await requestRefresh();
    await vscode.window.showInformationMessage(
      `${PLUGIN_WRITE_MESSAGE} Changed for all projects${
        node.hasLocalOverride ? ' (the override in this project was removed)' : ''
      }.`,
    );
  }

  registerCommand('claudeInventory.disablePluginGlobal', (arg) => setPluginEverywhere(arg, false));
  registerCommand('claudeInventory.enablePluginGlobal', (arg) => setPluginEverywhere(arg, true));

  registerCommand('claudeInventory.openSource', async (arg) => {
    const node = asNode(arg);
    const selected =
      node?.file !== undefined
        ? node
        : await pickNode(
            provider.getAllNodes().filter((candidate) => candidate.file !== undefined),
            'Select an item to open its source file',
            'No source files to open.',
          );
    const file = selected?.file;
    if (file === undefined) {
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file), {
      preview: true,
    });
  });

  registerCommand('claudeInventory.openLatestTranscript', async () => {
    const file = provider.getState()?.measurement?.sessionFile;
    if (!file) {
      await vscode.window.showInformationMessage(
        'No Claude Code session in this folder yet.',
      );
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file), {
      preview: true,
    });
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudeInventory.usageWindowDays')) {
        void requestRefresh().catch(showError);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      configureProjectWatchers();
      void requestRefresh().catch(showError);
    }),
  );

  configureProjectWatchers();
  void requestRefresh().catch(showError);
}

function showError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(message);
}

export function deactivate(): void {
  // Disposables registered in `activate` are cleaned up by VS Code.
}
