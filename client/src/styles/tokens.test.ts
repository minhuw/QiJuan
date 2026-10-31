import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(path.join(here, 'tokens.css'), 'utf8');
const styles = ['app.css', 'book-reader.css', 'globals.css'].map((file) => readFileSync(path.join(here, file), 'utf8'));

function block(source: string, start: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from);
}

describe('tokens', () => {
  it('defines ink, stock, and the state colours for light and dark', () => {
    for (const name of ['--ink:', '--stock:', '--ink-muted:', '--hairline:', '--vermilion:', '--emerald:', '--ochre:']) {
      expect(tokens).toContain(name);
    }
    expect(tokens).toMatch(/--ink:\s*#141210/i);
    expect(tokens).toMatch(/--stock:\s*#f1ebdd/i);
    const dark = block(tokens, 'prefers-color-scheme: dark');
    expect(dark).toMatch(/--stock:\s*#16140f/i);
    expect(dark).toMatch(/--ink:\s*#ede6d6/i);
    expect(dark).toContain('--hairline:');
  });

  it('uses the serif stack, a visible focus ring, and reduced motion', () => {
    expect(tokens).toContain('"Source Serif 4');
    expect(tokens).toContain('"Noto Serif SC"');
    expect(tokens).toContain('"Source Han Serif SC"');
    expect(tokens).toContain('"Songti SC"');
    expect(tokens).toContain('serif');
    expect(block(tokens, ':focus-visible')).toMatch(/outline:\s*2px solid var\(--ink\)/);
    expect(tokens).toContain('prefers-reduced-motion: reduce');
  });

  it('keeps retired palette tokens out of every stylesheet', () => {
    for (const source of [tokens, ...styles]) {
      expect(source).not.toMatch(/--(jade|paper|surface|line|gold|sidebar)[\w-]*/);
    }
  });
});
