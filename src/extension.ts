import * as vscode from 'vscode';

class EmptyTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getChildren(): vscode.TreeItem[] {
    return [];
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new EmptyTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeInventory.view', provider),
    vscode.commands.registerCommand('claudeInventory.refresh', () => {
      // Wired up in a later task.
    }),
  );
}

export function deactivate(): void {
  // Nothing to dispose.
}
