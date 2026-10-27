import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const epubRoot = path.dirname(require.resolve('epubjs/package.json'));
const fsDeny = ['.env', '.env.*', '*.{crt,pem}'];
if (!here.split(path.sep).includes('.git')) fsDeny.push('**/.git/**');

export default defineConfig({
  plugins: [react()],
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
