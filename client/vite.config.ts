import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const epubRoot = path.dirname(require.resolve('epubjs/package.json'));
const fsDeny = ['.env', '.env.*', '*.{crt,pem}'];
if (!here.split(path.sep).includes('.git')) fsDeny.push('**/.git/**');

const pdfjsDirs = ['cmaps', 'standard_fonts', 'wasm'] as const;

function pdfjsPackageRoot(from: string): string | null {
  const candidates = [
    path.resolve(from, 'node_modules/pdfjs-dist'),
    path.resolve(from, '../node_modules/pdfjs-dist'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json'))) ?? null;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function contentTypeFor(file: string): string {
  if (file.endsWith('.mjs') || file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

function resolvePdfjsFile(root: string, url: string): string | null {
  const prefix = '/pdfjs/';
  if (!url.startsWith(prefix)) return null;
  const rest = decodeURIComponent(url.slice(prefix.length));
  if (!rest || rest.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  const [group, ...nested] = rest.split('/');
  if (group === 'pdf.worker.min.mjs' && nested.length === 0) {
    const worker = path.join(root, 'build', 'pdf.worker.min.mjs');
    return fs.existsSync(worker) ? worker : null;
  }
  if (!pdfjsDirs.includes(group as (typeof pdfjsDirs)[number]) || nested.length === 0) return null;
  const full = path.resolve(root, group, ...nested);
  const base = path.resolve(root, group);
  const relative = path.relative(base, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

function pdfjsAssetsPlugin(): Plugin {
  return {
    name: 'qijuan-pdfjs-assets',
    configureServer(server) {
      const root = pdfjsPackageRoot(server.config.root);
      if (!root) return;
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const file = resolvePdfjsFile(root, url);
        if (!file) {
          next();
          return;
        }
        res.setHeader('Content-Type', contentTypeFor(file));
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      const root = pdfjsPackageRoot(here);
      if (!root) {
        this.error('pdfjs-dist is not installed; the PDF worker cannot be served from this origin');
        return;
      }
      const worker = path.join(root, 'build', 'pdf.worker.min.mjs');
      this.emitFile({
        type: 'asset',
        fileName: 'pdfjs/pdf.worker.min.mjs',
        source: fs.readFileSync(worker),
      });
      for (const dir of pdfjsDirs) {
        const base = path.join(root, dir);
        if (!fs.existsSync(base)) continue;
        for (const file of walkFiles(base)) {
          const relative = path.relative(base, file).split(path.sep).join('/');
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${dir}/${relative}`,
            source: fs.readFileSync(file),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssetsPlugin()],
  resolve: {
    alias: {
      // The GitHub snapshot publishes `module` as src/index.js and `main` as the
      // unbuilt lib/index.js. Load the source entry so Vite does not depend on that tarball.
      epubjs: path.join(epubRoot, 'src/index.js'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/health': 'http://127.0.0.1:8080',
      '/api': 'http://127.0.0.1:8080',
    },
    fs: { deny: fsDeny },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
