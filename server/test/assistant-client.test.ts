import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AssistantError,
  buildChatUrl,
  postChatCompletion,
  testAssistant,
  type AssistantConfig,
  type AssistantTransport,
} from '../src/metadata/assistant/client.js';
import {
  clearAssistantSettings,
  publicAssistantSettings,
  readAssistantSettings,
  writeAssistantSettings,
} from '../src/metadata/assistant-settings.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig, buildApp } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';
const adminKey = 'sk-admin-secret-9876';
const baseUrl = 'https://api.example.com/v1';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function cookieFrom(response: { headers: { 'set-cookie'?: string | string[] | undefined } }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(';')[0] ?? '';
}

function settingsPath(dir: string): string {
  return path.join(dir, 'metadata-assistant.json');
}

function publicUnconfigured() {
  return {
    configured: false,
    baseUrl: null,
    model: null,
    apiKeyConfigured: false,
    apiKeyHint: null,
  };
}

async function startApp(transport: AssistantTransport = {}) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const app = await buildApp({ config, clientDist: null, logger: false, assistant: transport });
  cleanups.push(() => {
    void app.close();
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  return { app, config, tempDir: temp.dir, cookie: cookieFrom(setup) };
}

async function readerCookie(app: Awaited<ReturnType<typeof buildApp>>, cookie: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie },
    payload: { username: 'reader', password },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/session/login',
    payload: { username: 'reader', password },
  });
  expect(login.statusCode).toBe(200);
  return cookieFrom(login);
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantError);
    return (error as AssistantError).code;
  }
  throw new Error('expected the assistant request to fail');
}

describe('assistant settings', () => {
  it('writes a private file and never exposes the key in the public view', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);

    const view = writeAssistantSettings(temp.dir, {
      baseUrl: ` ${baseUrl}/ `,
      model: ' gpt-test ',
      apiKey: ` ${adminKey} `,
    });
    expect(view).toEqual({
      configured: true,
      baseUrl,
      model: 'gpt-test',
      apiKeyConfigured: true,
      apiKeyHint: '9876',
    });
    expect(JSON.stringify(view)).not.toContain(adminKey);

    const file = settingsPath(temp.dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(temp.dir).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ baseUrl, model: 'gpt-test', apiKey: adminKey });
    expect(typeof stored.updatedAt).toBe('string');
    expect(readAssistantSettings(temp.dir)).toEqual({ baseUrl, model: 'gpt-test', apiKey: adminKey });
    expect(readFileSync(file, 'utf8')).not.toContain('"baseUrl":"https://api.example.com/v1//"');
  });

  it('keeps an existing key for blank updates and clears settings explicitly', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    writeAssistantSettings(temp.dir, { baseUrl, model: 'first', apiKey: adminKey });

    const blank = writeAssistantSettings(temp.dir, { baseUrl, model: 'second', apiKey: '   ' });
    expect(blank.apiKeyConfigured).toBe(true);
    expect(blank.apiKeyHint).toBe('9876');
    expect(readAssistantSettings(temp.dir)?.apiKey).toBe(adminKey);

    const absent = writeAssistantSettings(temp.dir, { baseUrl, model: 'third' });
    expect(absent.apiKeyConfigured).toBe(true);
    expect(absent.apiKeyHint).toBe('9876');
    expect(readAssistantSettings(temp.dir)?.apiKey).toBe(adminKey);

    clearAssistantSettings(temp.dir);
    expect(readAssistantSettings(temp.dir)).toBeNull();
    expect(existsSync(settingsPath(temp.dir))).toBe(false);
    expect(publicAssistantSettings(null)).toEqual(publicUnconfigured());
  });

  it('stores null for a first save with a blank key', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const view = writeAssistantSettings(temp.dir, { baseUrl: 'http://localhost:11434/v1', model: 'local', apiKey: '' });
    expect(view).toEqual({
      configured: true,
      baseUrl: 'http://localhost:11434/v1',
      model: 'local',
      apiKeyConfigured: false,
      apiKeyHint: null,
    });
    expect(readAssistantSettings(temp.dir)).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'local',
      apiKey: null,
    });
  });

  it('rejects invalid base urls, models, and keys', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const invalid = [
      { baseUrl: 'ftp://api.example.com/v1', model: 'gpt-test' },
      { baseUrl: 'not a url', model: 'gpt-test' },
      { baseUrl, model: '   ' },
      { baseUrl, model: 'x'.repeat(101) },
      { baseUrl, model: 'gpt-test', apiKey: 'k'.repeat(501) },
      { baseUrl: `https://api.example.com/${'a'.repeat(2100)}`, model: 'gpt-test' },
    ];
    for (const input of invalid) {
      expect(() => writeAssistantSettings(temp.dir, input)).toThrow();
    }
    expect(existsSync(settingsPath(temp.dir))).toBe(false);
  });

  it('treats a missing or invalid file as unconfigured', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    expect(readAssistantSettings(temp.dir)).toBeNull();

    writeFileSync(settingsPath(temp.dir), '{not json');
    expect(readAssistantSettings(temp.dir)).toBeNull();

    writeFileSync(
      settingsPath(temp.dir),
      JSON.stringify({ baseUrl: 'ftp://api.example.com/v1', model: 'gpt-test', apiKey: null, updatedAt: 'now' }),
    );
    expect(readAssistantSettings(temp.dir)).toBeNull();

    writeFileSync(
      settingsPath(temp.dir),
      JSON.stringify({ baseUrl, model: 'gpt-test', apiKey: 42, updatedAt: 'now' }),
    );
    expect(readAssistantSettings(temp.dir)).toBeNull();
  });
});

describe('assistant client', () => {
  it('types metadata_incomplete as an assistant error code', () => {
    const error = new AssistantError('metadata_incomplete');
    expect(error.code).toBe('metadata_incomplete');
    expect(error.message).toBe('metadata_incomplete');
  });

  it('builds the chat completions url without duplicate slashes', () => {
    expect(buildChatUrl(`${baseUrl}/`)).toBe(`${baseUrl}/chat/completions`);
    expect(buildChatUrl('http://localhost:11434/v1///')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('posts JSON and sends authorization only when a key exists', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init: RequestInit }> = [];
    const transport: AssistantTransport = {
      async fetch(input, init) {
        calls.push({ input, init: init ?? {} });
        return Response.json({ choices: [] });
      },
    };
    const body = { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] };

    await expect(
      postChatCompletion(transport, { baseUrl: `${baseUrl}/`, model: 'gpt-test', apiKey: adminKey }, body),
    ).resolves.toEqual({ choices: [] });

    const first = calls[0];
    const href =
      typeof first.input === 'string'
        ? first.input
        : first.input instanceof URL
          ? first.input.href
          : first.input.url;
    expect(href).toBe(`${baseUrl}/chat/completions`);
    const headers = new Headers(first.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`Bearer ${adminKey}`);
    expect(first.init.method).toBe('POST');
    expect(first.init.redirect).toBe('error');
    expect(first.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(first.init.body))).toEqual(body);

    await postChatCompletion(transport, { baseUrl, model: 'gpt-test', apiKey: null }, body);
    await postChatCompletion(transport, { baseUrl, model: 'gpt-test', apiKey: '' }, body);
    expect(new Headers(calls[1].init.headers).has('authorization')).toBe(false);
    expect(new Headers(calls[2].init.headers).has('authorization')).toBe(false);
  });

  it('maps status, network, timeout, and parse failures to named errors', async () => {
    const config: AssistantConfig = { baseUrl, model: 'gpt-test', apiKey: adminKey };
    const respond =
      (status: number, text = '') =>
      async (): Promise<Response> =>
        new Response(text, { status });

    expect(await errorCode(postChatCompletion({ fetch: respond(401) }, config, {}))).toBe('assistant_unauthorized');
    expect(await errorCode(postChatCompletion({ fetch: respond(403) }, config, {}))).toBe('assistant_unauthorized');
    expect(await errorCode(postChatCompletion({ fetch: respond(500, 'server secret') }, config, {}))).toBe(
      'metadata_unavailable',
    );
    expect(
      await errorCode(
        postChatCompletion(
          {
            async fetch() {
              throw new Error('offline');
            },
          },
          config,
          {},
        ),
      ),
    ).toBe('metadata_unavailable');
    expect(
      await errorCode(
        postChatCompletion(
          {
            async fetch() {
              throw new DOMException('The operation was aborted.', 'AbortError');
            },
          },
          config,
          {},
        ),
      ),
    ).toBe('metadata_unavailable');
    expect(await errorCode(postChatCompletion({ fetch: respond(200, 'not json') }, config, {}))).toBe(
      'assistant_invalid_response',
    );

    try {
      await postChatCompletion({ fetch: respond(500, 'body-secret') }, config, { prompt: 'body-secret' });
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantError);
      expect(String((error as Error).message)).not.toContain(adminKey);
      expect(String((error as Error).message)).not.toContain('body-secret');
    }
  });

  it('caps response bodies at two megabytes', async () => {
    const config: AssistantConfig = { baseUrl, model: 'gpt-test', apiKey: null };
    const tooLarge = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect(await errorCode(postChatCompletion({ fetch: async () => new Response(tooLarge) }, config, {}))).toBe(
      'assistant_invalid_response',
    );
  });

  it('tests the model with a tiny no-tools request', async () => {
    const calls: RequestInit[] = [];
    const transport: AssistantTransport = {
      async fetch(_input, init) {
        calls.push(init ?? {});
        return Response.json({ id: 'chatcmpl-test' });
      },
    };
    const result = await testAssistant(transport, { baseUrl, model: 'gpt-test', apiKey: adminKey });
    expect(result).toEqual({ model: 'gpt-test' });
    const body = JSON.parse(String(calls[0].body)) as {
      model: string;
      max_tokens: number;
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gpt-test');
    expect(body.max_tokens).toBe(8);
    expect(body.tools).toBeUndefined();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content.toLowerCase()).toContain('ok');
  });
});

describe('assistant routes', () => {
  it('requires an administrator and masks the saved key', async () => {
    const started = await startApp();
    const unauth = await started.app.inject({ method: 'GET', url: '/api/metadata/assistant' });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json()).toEqual({ error: 'unauthorized' });

    const reader = await readerCookie(started.app, started.cookie);
    const readerRequests = [
      started.app.inject({ method: 'GET', url: '/api/metadata/assistant', headers: { cookie: reader } }),
      started.app.inject({
        method: 'PUT',
        url: '/api/metadata/assistant',
        headers: { cookie: reader },
        payload: { baseUrl, model: 'gpt-test', apiKey: adminKey },
      }),
      started.app.inject({ method: 'DELETE', url: '/api/metadata/assistant', headers: { cookie: reader } }),
      started.app.inject({ method: 'POST', url: '/api/metadata/assistant/test', headers: { cookie: reader } }),
    ];
    for (const response of await Promise.all(readerRequests)) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden' });
    }
    expect(existsSync(settingsPath(started.tempDir))).toBe(false);

    const initial = await started.app.inject({
      method: 'GET',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.json()).toEqual({ assistant: publicUnconfigured() });

    const invalid = await started.app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
      payload: { baseUrl: 'ftp://api.example.com/v1', model: 'gpt-test' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'invalid_request' });

    const saved = await started.app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
      payload: { baseUrl: `${baseUrl}/`, model: 'gpt-router', apiKey: adminKey },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.json()).toEqual({
      assistant: {
        configured: true,
        baseUrl,
        model: 'gpt-router',
        apiKeyConfigured: true,
        apiKeyHint: '9876',
      },
    });
    expect(saved.body).not.toContain(adminKey);
    expect(statSync(settingsPath(started.tempDir)).mode & 0o777).toBe(0o600);

    const fetched = await started.app.inject({
      method: 'GET',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
    });
    expect(fetched.json()).toEqual(saved.json());

    const blank = await started.app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
      payload: { baseUrl, model: 'gpt-router-2', apiKey: '   ' },
    });
    expect(blank.statusCode).toBe(200);
    expect(blank.json().assistant.apiKeyHint).toBe('9876');
    expect(readAssistantSettings(started.tempDir)?.apiKey).toBe(adminKey);

    const removed = await started.app.inject({
      method: 'DELETE',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.headers['cache-control']).toBe('no-store');
    expect(removed.json()).toEqual({ assistant: publicUnconfigured() });
    expect(existsSync(settingsPath(started.tempDir))).toBe(false);
  });

  it('tests the saved assistant and reports named failures', async () => {
    let mode: 'ok' | 'unauthorized' | 'network' | 'malformed' = 'ok';
    const calls: RequestInit[] = [];
    const transport: AssistantTransport = {
      async fetch(_input, init) {
        calls.push(init ?? {});
        if (mode === 'network') throw new Error('offline');
        if (mode === 'unauthorized') return new Response('', { status: 401 });
        if (mode === 'malformed') return new Response('not json', { status: 200 });
        return Response.json({ choices: [{ message: { content: 'OK' } }] });
      },
    };
    const started = await startApp(transport);

    const unconfigured = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(unconfigured.statusCode).toBe(400);
    expect(unconfigured.headers['cache-control']).toBe('no-store');
    expect(unconfigured.json()).toEqual({ error: 'metadata_assistant_unconfigured' });

    const saved = await started.app.inject({
      method: 'PUT',
      url: '/api/metadata/assistant',
      headers: { cookie: started.cookie },
      payload: { baseUrl, model: 'gpt-test', apiKey: adminKey },
    });
    expect(saved.statusCode).toBe(200);

    const ok = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json()).toEqual({ ok: true, model: 'gpt-test' });
    expect(ok.body).not.toContain(adminKey);
    expect(new Headers(calls[0].headers).get('authorization')).toBe(`Bearer ${adminKey}`);

    mode = 'unauthorized';
    const unauthorized = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(unauthorized.statusCode).toBe(502);
    expect(unauthorized.json()).toEqual({ error: 'assistant_unauthorized' });
    expect(unauthorized.body).not.toContain(adminKey);

    mode = 'network';
    const network = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(network.statusCode).toBe(502);
    expect(network.json()).toEqual({ error: 'metadata_unavailable' });

    mode = 'malformed';
    const malformed = await started.app.inject({
      method: 'POST',
      url: '/api/metadata/assistant/test',
      headers: { cookie: started.cookie },
    });
    expect(malformed.statusCode).toBe(502);
    expect(malformed.json()).toEqual({ error: 'assistant_invalid_response' });
  });
});
