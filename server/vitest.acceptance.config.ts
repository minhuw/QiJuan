import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const fsDeny = ['.env', '.env.*', '*.{crt,pem}'];
if (!here.split(path.sep).includes('.git')) fsDeny.push('**/.git/**');

export default defineConfig({
  server: {
    fs: { deny: fsDeny },
  },
  test: {
    environment: 'node',
    include: ['test/acceptance/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
