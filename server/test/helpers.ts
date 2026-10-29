import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { AssistantTransport } from '../src/metadata/assistant/client.js';
import { writeAssistantSettings } from '../src/metadata/assistant-settings.js';

// The integration suite opens SQLite databases, hashes files, and spawns helpers.
// The 5s default is too tight when Vitest runs all files in parallel on a busy host.
vi.setConfig({ testTimeout: 15_000 });

const TEST_ASSISTANT_BASE_URL = 'https://model.example/v1';

export function configureTestAssistant(dataDir: string): void {
  writeAssistantSettings(dataDir, { baseUrl: TEST_ASSISTANT_BASE_URL, model: 'scripted-model' });
}

/** A scripted model that submits the embedded fields, filling only the fields the old import path left empty. */
export function embeddedMetadataAssistant(options: { avoidIsbn?: boolean } = {}): AssistantTransport {
  return {
    async fetch(_input, init) {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const user = body.messages?.find((message) => message.role === 'user');
      const input = JSON.parse(String(user?.content ?? '{}')) as {
        filename?: string;
        fields?: {
          title?: string | null;
          authors?: string[];
          translators?: string[];
          description?: string | null;
          publisher?: string | null;
          publishedDate?: string | null;
          language?: string | null;
          identifiers?: Array<{ scheme: string; value: string }>;
          series?: string | null;
          seriesOrder?: number | null;
        };
      };
      const fields = input.fields ?? {};
      const filename = input.filename ?? 'untitled';
      const title = fields.title ?? filename.replace(/\.[^.]+$/, '');
      const identifiers = (fields.identifiers ?? []).map((identifier) =>
        options.avoidIsbn && identifier.scheme.toLowerCase() === 'isbn'
          ? { ...identifier, scheme: 'other' }
          : identifier,
      );
      const submission = {
        title,
        authors: fields.authors && fields.authors.length > 0 ? fields.authors : ['Test Author'],
        translators: fields.translators ?? [],
        description: fields.description ?? `Description for ${title}.`,
        publisher: fields.publisher ?? 'QiJuan Test Press',
        publishedDate: fields.publishedDate ?? '2024-01-01',
        language: fields.language ?? 'en',
        identifiers:
          identifiers.length > 0
            ? identifiers
            : [options.avoidIsbn ? { scheme: 'other', value: 'qijuan-test' } : { scheme: 'isbn', value: '9780140328721' }],
        series: fields.series ?? null,
        seriesOrder: fields.seriesOrder ?? null,
        coverId: null,
        isbn: null,
      };
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'submit_metadata', arguments: JSON.stringify(submission) },
                },
              ],
            },
          },
        ],
      });
    },
  };
}

export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'qijuan-'));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function tempConfig(dir: string, env: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...env, QIJUAN_DATA_DIR: dir });
}
