import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudePaths {
  home: string;
  claudeJson: string;
  claudeDir: string;
  userSettings: string;
  installedPlugins: string;
  /** Where user-level MCP servers go when they are switched off everywhere. */
  mcpStash: string;
  transcriptsRoot: string;
}

/** Build the well-known Claude Code paths from a home directory. */
export function ClaudePaths(home: string = os.homedir()): ClaudePaths {
  const claudeDir = path.join(home, '.claude');
  return {
    home,
    claudeJson: path.join(home, '.claude.json'),
    claudeDir,
    userSettings: path.join(claudeDir, 'settings.json'),
    installedPlugins: path.join(claudeDir, 'plugins', 'installed_plugins.json'),
    mcpStash: path.join(claudeDir, 'mcp-disabled-stash.json'),
    transcriptsRoot: path.join(claudeDir, 'projects'),
  };
}

/** Normalize a project key/path for comparison: slashes, trailing slashes, case. */
export function normKey(projectPath: string): string {
  return projectPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Strip trailing path separators (`/` or `\`) from a project path. */
export function stripTrailingSeparators(projectPath: string): string {
  return projectPath.replace(/[\\/]+$/, '');
}

/** Transcript directory name for a project path. */
export function slug(projectPath: string): string {
  return stripTrailingSeparators(projectPath).replace(/[^A-Za-z0-9]/g, '-');
}

/** Find the transcript directory for a project, matching its slug case-insensitively. */
export function findTranscriptDir(
  paths: ClaudePaths,
  projectPath: string,
): string | undefined {
  const wanted = slug(projectPath).toLowerCase();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(paths.transcriptsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.toLowerCase() === wanted) {
      return path.join(paths.transcriptsRoot, entry.name);
    }
  }
  return undefined;
}

/** Tool-name prefix used in transcripts for an MCP server id. */
export function mcpPrefix(id: string): string {
  return 'mcp__' + id.replace(/[^A-Za-z0-9_-]/g, '_') + '__';
}
