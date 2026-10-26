import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');

describe('tokens', () => {
  it('defines paper, ink, vermilion, and jade for light and dark', () => {
    expect(tokens).toContain('--paper:');
    expect(tokens).toContain('--ink:');
    expect(tokens).toContain('--vermilion:');
    expect(tokens).toContain('--jade:');
    expect(tokens).toContain('prefers-color-scheme: dark');
  });

  it('uses the serif stack, a visible focus ring, and reduced motion', () => {
    expect(tokens).toContain('"Source Han Serif SC"');
    expect(tokens).toContain('"Noto Serif CJK SC"');
    expect(tokens).toContain('"Songti SC"');
    expect(tokens).toContain('Palatino');
    expect(tokens).toContain('serif');
    expect(tokens).toContain(':focus-visible');
    expect(tokens).toContain('prefers-reduced-motion: reduce');
  });
});
