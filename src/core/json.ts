import * as fs from 'node:fs';

export interface JsonResult<T = unknown> {
  data: T | null;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
