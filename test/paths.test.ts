import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudePaths,
  findTranscriptDir,
  mcpPrefix,
  normKey,
  slug,
} from '../src/core/paths';

const fixtureHome = path.join(process.cwd(), 'test', 'fixtures', 'home');
const fixtureTranscriptDir = path.join(
  fixtureHome,
  '.claude',
  'projects',
  'D--PROJECTS----VSCODEPLUGIN',
);

describe('normKey', () => {
  it('normalizes backslashes, case and trailing slashes', () => {
    expect(normKey('D:\\Projects\\VSCodePlugin\\')).toBe('d:/projects/vscodeplugin');
    expect(normKey('d:/Projects/VSCodePlugin')).toBe('d:/projects/vscodeplugin');
    expect(normKey('C:\\Users\\X')).toBe('c:/users/x');
  });
});

describe('slug', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(slug('d:\\Projects\\项目\\VSCodePlugin')).toBe('d--Projects----VSCodePlugin');
  });
});

describe('mcpPrefix', () => {
  it('sanitizes plugin-scoped ids', () => {
    expect(mcpPrefix('plugin:vercel:vercel')).toBe('mcp__plugin_vercel_vercel__');
  });

  it('sanitizes claude.ai connector ids', () => {
    expect(mcpPrefix('claude.ai Gmail')).toBe('mcp__claude_ai_Gmail__');
  });
});

describe('ClaudePaths + findTranscriptDir', () => {
  it('builds the expected paths from a home directory', () => {
    const paths = ClaudePaths(fixtureHome);
    expect(paths.claudeJson).toBe(path.join(fixtureHome, '.claude.json'));
    expect(paths.claudeDir).toBe(path.join(fixtureHome, '.claude'));
    expect(paths.userSettings).toBe(path.join(fixtureHome, '.claude', 'settings.json'));
    expect(paths.installedPlugins).toBe(
      path.join(fixtureHome, '.claude', 'plugins', 'installed_plugins.json'),
    );
    expect(paths.transcriptsRoot).toBe(path.join(fixtureHome, '.claude', 'projects'));
  });

  it('matches a transcript directory whose name differs only by case', () => {
    const paths = ClaudePaths(fixtureHome);
    expect(findTranscriptDir(paths, 'd:\\Projects\\项目\\VSCodePlugin')).toBe(
      fixtureTranscriptDir,
    );
    expect(findTranscriptDir(paths, 'D:/Projects/项目/VSCodePlugin/')).toBe(
      fixtureTranscriptDir,
    );
  });

  it('returns undefined when no directory matches', () => {
    const paths = ClaudePaths(fixtureHome);
    expect(findTranscriptDir(paths, 'd:\\Projects\\SomewhereElse')).toBeUndefined();
  });

  it('returns undefined when the transcripts root does not exist', () => {
    const paths = ClaudePaths(path.join(fixtureHome, 'no-such-home'));
    expect(findTranscriptDir(paths, 'd:\\Projects\\项目\\VSCodePlugin')).toBeUndefined();
  });
});
