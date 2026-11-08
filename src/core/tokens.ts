const CJK_RE = /[\u3000-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/g;

/**
 * Rough token estimate: every CJK character counts as one token, all other
 * characters as a quarter token (rounded up).
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjkCount = text.match(CJK_RE)?.length ?? 0;
  const otherCount = text.length - cjkCount;
  return cjkCount + Math.ceil(otherCount / 4);
}

/** `<1000` as-is, otherwise one decimal followed by `k` (1234 -> "1.2k"). */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) {
    return '0';
  }
  const value = Math.round(tokens);
  if (value < 1000) {
    return String(value);
  }
  return `${(value / 1000).toFixed(1)}k`;
}
