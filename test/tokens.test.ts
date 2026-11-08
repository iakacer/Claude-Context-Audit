import { describe, expect, it } from 'vitest';
import { estimateTokens, formatTokens } from '../src/core/tokens';

describe('estimateTokens', () => {
  it('counts every CJK character as one token', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('こんにちは')).toBe(5);
    expect(estimateTokens('한국어')).toBe(3);
  });

  it('counts other characters as four per token, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('  : ')).toBe(1);
  });

  it('mixes CJK and non-CJK text', () => {
    expect(estimateTokens('你好world')).toBe(4);
    expect(estimateTokens('plugin:vercel:vercel')).toBe(5);
  });
});

describe('formatTokens', () => {
  it('prints values below 1000 as-is', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('prints larger values with one decimal and a k suffix', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(65600)).toBe('65.6k');
  });
});
