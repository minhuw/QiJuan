import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('docker compose', () => {
  it('parses the qijuan service, data volume, healthcheck, and port', () => {
    const document = parse(readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')) as {
      services: Record<string, {
        ports?: Array<string | number>;
        volumes?: string[];
        environment?: Record<string, string>;
        healthcheck?: { test?: string[] };
      }>;
      volumes?: Record<string, unknown>;
    };

    const service = document.services.qijuan;
    expect(service).toBeTruthy();
    expect(service.ports?.map(String).join(' ')).toContain('8080');
    expect(service.volumes?.join(' ')).toContain('/data');
    expect(service.environment?.QIJUAN_DATA_DIR).toBe('/data');
    expect(String(service.environment?.QIJUAN_PORT)).toBe('8080');
    expect(service.healthcheck?.test?.join(' ')).toContain('/health');
    expect(document.volumes).toHaveProperty('qijuan-data');
  });
});
