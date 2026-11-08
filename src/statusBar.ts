import * as vscode from 'vscode';
import { formatTokens } from './core/tokens';
import type { InventoryState } from './state';
import { topConsumers, unusedEnabledCount } from './state';

/**
 * Left status bar item: shows the measured starting context and a tooltip with
 * the biggest consumers and how many enabled items are unused.
 */
export class InventoryStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.name = 'Claude Context Inventory';
    this.item.command = 'workbench.view.extension.claudeInventory';
  }

  update(state: InventoryState): void {
    const measurement = state.measurement;
    this.item.text = measurement
      ? `$(pulse) Claude ≈${formatTokens(measurement.baselineTokens)}`
      : '$(pulse) Claude';

    const lines: string[] = ['**Claude Context Inventory**'];
    if (measurement) {
      const consumers = topConsumers(measurement, state.inventory, 3);
      for (const consumer of consumers) {
        lines.push(
          `- ${consumer.label} — ≈${formatTokens(consumer.tokens)} tok (${consumer.kind})`,
        );
      }
    } else {
      lines.push('No Claude Code session in this folder yet.');
    }

    const unused = unusedEnabledCount(state);
    lines.push('');
    lines.push(
      `${unused} unused but enabled item${unused === 1 ? '' : 's'} in the last ${state.usage.windowDays} days.`,
    );

    const tooltip = new vscode.MarkdownString(lines.join('\n'));
    this.item.tooltip = tooltip;
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
