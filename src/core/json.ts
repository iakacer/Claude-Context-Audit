import * as fs from 'node:fs';

export interface JsonResult<T = unknown> {
  data: T | null;
  error?: string;
}

export interface JsonFileResult<T = unknown> {
  data: T | null;
  missing: boolean;
  error?: string;
}

/**
 * Tolerant JSON reader: returns `{data, error}` and never throws.
 */
export function readJson<T = unknown>(filePath: string): JsonResult<T> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { data: null, error: errorMessage(err) };
  }
  try {
    return { data: JSON.parse(text) as T };
  } catch (err) {
    return { data: null, error: errorMessage(err) };
  }
}

/**
 * Async tolerant JSON reader. A missing file is reported separately so callers
 * can skip it silently, while unreadable or invalid files carry an error.
 */
export async function readJsonFile<T = unknown>(
  filePath: string,
): Promise<JsonFileResult<T>> {
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      data: null,
      missing: code === 'ENOENT' || code === 'ENOTDIR',
      error: errorMessage(err),
    };
  }
  try {
    return { data: JSON.parse(text) as T, missing: false };
  } catch (err) {
    return { data: null, missing: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
