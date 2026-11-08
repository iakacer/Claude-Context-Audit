import * as path from 'node:path';
import { ClaudePaths } from './core/paths';
import { loadState, topConsumers } from './state';

interface CliOptions {
  projectPath?: string;
  windowDays: number;
}

function parseArgs(argv: string[]): { options?: CliOptions; error?: string } {
  const options: CliOptions = { windowDays: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--days') {
      const value = argv[index + 1];
      index += 1;
      const parsed = parseDays(value);
      if (parsed === undefined) {
        return { error: `Invalid value for --days: ${value ?? '(missing)'}` };
      }
      options.windowDays = parsed;
      continue;
    }
    if (arg.startsWith('--days=')) {
      const value = arg.slice('--days='.length);
      const parsed = parseDays(value);
      if (parsed === undefined) {
        return { error: `Invalid value for --days: ${value}` };
      }
      options.windowDays = parsed;
      continue;
    }
    if (arg.startsWith('-')) {
      // Unknown flag: ignore rather than fail the debug tool.
      continue;
    }
    if (options.projectPath === undefined) {
      options.projectPath = arg;
    }
  }
  return { options };
}

function parseDays(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }
  return Math.floor(parsed);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  const options = parsed.options!;
  if (options.projectPath === undefined) {
    console.error('Usage: node dist/cli.js <projectPath> [--days N]');
    process.exitCode = 1;
    return;
  }

  const state = await loadState(
    path.resolve(options.projectPath),
    ClaudePaths(),
    options.windowDays,
  );
  const output = {
    inventory: state.inventory,
    measurement: state.measurement ?? null,
    usage: state.usage,
    top: state.measurement
      ? topConsumers(state.measurement, state.inventory, 10)
      : [],
  };
  console.log(JSON.stringify(output, null, 2));
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
