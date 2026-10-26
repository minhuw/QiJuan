import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('project layout', () => {
  it('defines private workspaces, engines, and the ci scripts', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name: string;
      private: boolean;
      engines: { node: string };
      workspaces: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe('qijuan');
    expect(pkg.private).toBe(true);
    expect(pkg.workspaces).toEqual(expect.arrayContaining(['server', 'client']));
    expect(pkg.engines.node).toContain('>=22');
    expect(pkg.scripts.ci).toMatch(/typecheck/);
    expect(pkg.scripts.ci).toMatch(/test/);
    expect(pkg.scripts.ci).toMatch(/build/);
    expect(pkg.scripts['test:acceptance']).toMatch(/acceptance/);
  });

  it('ignores node_modules, dist, data, and coverage', () => {
    const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    const dockerignore = readFileSync(path.join(root, '.dockerignore'), 'utf8');
    for (const entry of ['node_modules', 'dist', 'data', 'coverage']) {
      expect(gitignore).toContain(entry);
      expect(dockerignore).toContain(entry);
    }
  });

  it('uses a current Node 22 bookworm image and checks /health', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^FROM node:22-bookworm\b/m);
    expect(dockerfile).not.toMatch(/linux\/amd64/);
    expect(dockerfile).toMatch(/EXPOSE 8080/);
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toContain('/health');
  });

  it('keeps acceptance tests out of the fast vitest config', () => {
    const fast = readFileSync(path.join(root, 'server/vitest.config.ts'), 'utf8');
    const acceptance = readFileSync(path.join(root, 'server/vitest.acceptance.config.ts'), 'utf8');
    expect(fast).toMatch(/test\/acceptance/);
    expect(acceptance).toMatch(/test\/acceptance/);
  });
});
