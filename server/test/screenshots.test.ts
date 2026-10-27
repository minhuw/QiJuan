import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const screenshots = ['library', 'book', 'reader', 'backup'].flatMap((name) =>
  ['1280', '768', '390'].map((width) => path.join(root, 'docs/screenshots', `${name}-${width}.png`)),
);

describe('screenshots', () => {
  it('stores twelve distinct library, book, reader, and backup captures', () => {
    expect(screenshots).toHaveLength(12);
    for (const file of screenshots) {
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size, file).toBeGreaterThan(10 * 1024);
    }
  });
});
