export interface Frontmatter {
  name?: string;
  description?: string;
}

/**
 * Parse the small YAML-ish frontmatter block used by skills and agents.
 *
 * Only the first two `---` lines matter, and only the single-line `name` and
 * `description` values are read. Missing or malformed frontmatter returns an
 * empty object instead of throwing.
 */
export function parseFrontmatter(text: string): Frontmatter {
  if (!text) {
    return {};
  }

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') {
    start += 1;
  }
  if (lines[start]?.trim() !== '---') {
    return {};
  }

  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return {};
  }

  const result: Frontmatter = {};
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    if (key !== 'name' && key !== 'description') {
      continue;
    }
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (key === 'name') {
      result.name = value;
    } else {
      result.description = value;
    }
  }
  return result;
}
