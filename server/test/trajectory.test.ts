import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import {
  AGENT_MAX_TOOL_CALLS,
  AGENT_MAX_TURNS,
  AGENT_TIMEOUT_MS,
  runMetadataAgent,
  type AgentStep,
  type RunMetadataAgentOptions,
} from '../src/metadata/assistant/agent.js';
import type { AssistantConfig, AssistantTransport } from '../src/metadata/assistant/client.js';
import { writeAssistantSettings } from '../src/metadata/assistant-settings.js';
import type { OpenLibraryTransport } from '../src/metadata/openLibrary.js';
import {
  TRAJECTORY_MAX_BYTES,
  appendTrajectoryStep,
  getTrajectory,
  pruneTrajectories,
  startTrajectory,
} from '../src/metadata/trajectory.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { buildEpub } from './fixtures.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';
const API_KEY = 'sk-trajectory-secret-0f9e8d7c';
const origin = 'https://ol.example';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

const config: AssistantConfig = { baseUrl: 'https://model.example/v1', model: 'scripted-model', apiKey: API_KEY };

const submission = {
  title: 'The Book',
  authors: ['Ada Lovelace'],
  translators: [],
  description: 'A book about a quiet library.',
  publisher: 'Quiet Press',
  publishedDate: '1843',
  language: 'en',
  identifiers: [{ scheme: 'isbn', value: '9780140328721' }],
  series: null,
  seriesOrder: null,
  coverId: null,
  isbn: '9780140328721',
};

interface ScriptedReply {
  content?: string | null;
  tool_calls?: Array<{ name: string; arguments: unknown }>;
}

function scripted(script: (index: number) => ScriptedReply | Promise<ScriptedReply>): AssistantTransport {
  let index = 0;
  return {
    async fetch() {
      const reply = await script(index);
      index += 1;
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: reply.content ?? null,
              ...(reply.tool_calls
                ? {
                    tool_calls: reply.tool_calls.map((call, position) => ({
                      id: `call_${index}_${position}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                    })),
                  }
                : {}),
            },
          },
        ],
      });
    },
  };
}

/** search → record → submit, with a model note on the first turn. */
function searchRecordSubmit(onTurn?: (index: number) => Promise<void>): AssistantTransport {
  return scripted(async (index) => {
    await onTurn?.(index);
    if (index === 0) {
      return {
        content: 'Searching by title first.',
        tool_calls: [{ name: 'search_open_library', arguments: { title: 'The Book' } }],
      };
    }
    if (index === 1) return { tool_calls: [{ name: 'get_open_library_record', arguments: { key: '/works/OL123W' } }] };
    return { tool_calls: [{ name: 'submit_metadata', arguments: submission }] };
  });
}

const openLibrary: OpenLibraryTransport = {
  origin,
  async fetch(input) {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/search.json') {
      return Response.json({ docs: [{ key: '/works/OL123W', title: 'The Book' }, { key: '/works/OL9W', title: 'Other' }] });
    }
    if (url.pathname.startsWith('/works/')) return Response.json({ key: '/works/OL123W', title: 'The Book' });
    return Response.json({ docs: [] });
  },
};

function agentOptions(transport: AssistantTransport, steps: AgentStep[]): RunMetadataAgentOptions {
  return {
    transport,
    openLibrary,
    config,
    metadataPrivate: false,
    input: {
      filename: 'quiet-book.epub',
      format: 'epub',
      fields: {
        title: 'Embedded Title',
        authors: ['Embedded Author'],
        translators: [],
        description: null,
        publisher: null,
        publishedDate: null,
        language: 'en',
        identifiers: [],
        series: null,
        seriesOrder: null,
      },
    },
    onStep: (step) => steps.push(step),
  };
}

describe('metadata agent steps', () => {
  it('records search, record, and submit in order', async () => {
    const steps: AgentStep[] = [];
    const result = await runMetadataAgent(agentOptions(searchRecordSubmit(), steps));
    expect(result.proposal.title).toBe('The Book');

    expect(steps.map((step) => step.kind)).toEqual([
      'input',
      'model',
      'tool_call',
      'tool_result',
      'model',
      'tool_call',
      'tool_result',
      'model',
      'submit',
      'end',
    ]);
    expect(steps.map((step) => step.seq)).toEqual(steps.map((_, index) => index + 1));
    for (const step of steps) expect(Number.isNaN(Date.parse(step.at))).toBe(false);

    const [input, note, search, searchResult, , record, recordResult, , submit, end] = steps;
    expect(input).toMatchObject({
      kind: 'input',
      prompt: 'metadata-assistant',
      model: 'scripted-model',
      input: { filename: 'quiet-book.epub', format: 'epub', fields: { title: 'Embedded Title' } },
      limits: { turns: AGENT_MAX_TURNS, toolCalls: AGENT_MAX_TOOL_CALLS, ms: AGENT_TIMEOUT_MS },
    });
    expect(note).toMatchObject({ kind: 'model', turn: 1, text: 'Searching by title first.', toolCalls: ['search_open_library'] });
    expect(search).toMatchObject({ kind: 'tool_call', name: 'search_open_library', args: { title: 'The Book' } });
    expect(searchResult).toMatchObject({
      kind: 'tool_result',
      name: 'search_open_library',
      summary: { count: 2, key: '/works/OL123W', title: 'The Book' },
      truncated: false,
    });
    expect(JSON.parse((searchResult as { result: string }).result)).toMatchObject({ results: expect.any(Array) });
    expect(record).toMatchObject({ kind: 'tool_call', name: 'get_open_library_record', args: { key: '/works/OL123W' } });
    expect(recordResult).toMatchObject({ summary: { key: '/works/OL123W', title: 'The Book' } });
    expect(submit).toMatchObject({ kind: 'submit', accepted: true, proposal: { title: 'The Book' } });
    expect(end).toMatchObject({ kind: 'end', outcome: 'accepted', error: null, turns: 3, toolCalls: 3 });
    expect(JSON.stringify(steps)).not.toContain(API_KEY);
    expect(JSON.stringify(steps)).not.toContain('You identify books');
  });

  it('records a rejected submission and the corrected one', async () => {
    const steps: AgentStep[] = [];
    await runMetadataAgent(
      agentOptions(
        scripted((index) => ({
          tool_calls: [{ name: 'submit_metadata', arguments: index === 0 ? { title: 'Only a title' } : submission }],
        })),
        steps,
      ),
    );
    const submits = steps.filter((step) => step.kind === 'submit');
    expect(submits[0]).toMatchObject({ accepted: false, error: 'metadata_incomplete', missing: expect.arrayContaining(['authors']) });
    expect(submits[1]).toMatchObject({ accepted: true });
  });

  it('ends with failed when the model request fails', async () => {
    const steps: AgentStep[] = [];
    const transport: AssistantTransport = { fetch: async () => new Response('nope', { status: 500 }) };
    await expect(runMetadataAgent(agentOptions(transport, steps))).rejects.toMatchObject({ code: 'metadata_unavailable' });
    expect(steps.map((step) => step.kind)).toEqual(['input', 'end']);
    expect(steps[1]).toMatchObject({ outcome: 'failed', error: 'metadata_unavailable', turns: 1, toolCalls: 0 });
  });

  it('ends with timeout when the time budget runs out', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const steps: AgentStep[] = [];
    const transport = scripted(() => {
      clock += AGENT_TIMEOUT_MS + 1;
      return { tool_calls: [{ name: 'search_open_library', arguments: { title: 'The Book' } }] };
    });
    await expect(runMetadataAgent(agentOptions(transport, steps))).rejects.toMatchObject({ code: 'metadata_incomplete' });
    expect(steps.at(-1)).toMatchObject({ kind: 'end', outcome: 'timeout', error: 'metadata_incomplete' });
  });

  it('ends with limit when the model never submits', async () => {
    const steps: AgentStep[] = [];
    const transport = scripted(() => ({ tool_calls: [{ name: 'search_open_library', arguments: { title: 'Again' } }] }));
    await expect(runMetadataAgent(agentOptions(transport, steps))).rejects.toMatchObject({ code: 'metadata_incomplete' });
    expect(steps.at(-1)).toMatchObject({ kind: 'end', outcome: 'limit', turns: AGENT_MAX_TURNS, toolCalls: AGENT_MAX_TURNS });
  });

  it('keeps running when the observer throws', async () => {
    const options = agentOptions(searchRecordSubmit(), []);
    options.onStep = () => {
      throw new Error('observer broke');
    };
    await expect(runMetadataAgent(options)).resolves.toMatchObject({ turns: 3 });
  });
});

function openTempDatabase() {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const databasePath = `${temp.dir}/qijuan.sqlite`;
  migrate({ databasePath, migrationsDir: defaultMigrationsDir() });
  const opened = openDatabase(databasePath);
  cleanups.push(() => opened.sqlite.close());
  const stamp = '2026-01-01T00:00:00.000Z';
  const library = opened.sqlite
    .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Home', 'managed', ?, ?) RETURNING id`)
    .get(temp.dir, stamp) as { id: number };
  const job = opened.sqlite
    .prepare(
      `INSERT INTO jobs (library_id, source, status, created_at, updated_at) VALUES (?, 'lookup', 'running', ?, ?) RETURNING id`,
    )
    .get(library.id, stamp, stamp) as { id: number };
  return { ...opened, jobId: job.id };
}

function step(seq: number, body: Record<string, unknown>): AgentStep {
  return { seq, at: new Date().toISOString(), ...body } as AgentStep;
}

describe('trajectory storage', () => {
  it('caps the stored size and still records the end', () => {
    const { db, sqlite, jobId } = openTempDatabase();
    const recorder = startTrajectory(db, { jobId, model: 'scripted-model' });
    const big = 'x'.repeat(12_000);
    let seq = 0;
    for (let index = 0; index < 40; index += 1) {
      seq += 1;
      recorder.onStep(
        step(seq, {
          kind: 'tool_result',
          callId: `call_${index}`,
          name: 'search_open_library',
          summary: { count: 5 },
          result: big,
          truncated: false,
          durationMs: 12,
        }),
      );
    }
    seq += 1;
    recorder.onStep(step(seq, { kind: 'end', outcome: 'limit', error: 'metadata_incomplete', reason: null, turns: 4, toolCalls: 6, totalMs: 900 }));

    const sizes = sqlite
      .prepare('SELECT SUM(LENGTH(CAST(data AS BLOB))) AS bytes FROM metadata_trajectory_steps WHERE trajectory_id = ?')
      .get(recorder.id) as { bytes: number };
    expect(sizes.bytes).toBeLessThanOrEqual(TRAJECTORY_MAX_BYTES);

    const found = getTrajectory(db, recorder.id)!.trajectory;
    expect(found.truncated).toBe(true);
    expect(found.outcome).toBe('limit');
    expect(found.summary).toEqual({ turns: 4, toolCalls: 6, totalMs: 900 });
    expect(found.steps.at(-1)?.kind).toBe('end');
    const shortened = found.steps.find((entry) => entry.data.omitted === true);
    expect(shortened?.data).toMatchObject({ name: 'search_open_library', summary: { count: 5 }, durationMs: 12 });
    expect(shortened?.data.result).toBeUndefined();
  });

  it('prunes trajectories older than thirty days', () => {
    const { db, sqlite, jobId } = openTempDatabase();
    const now = new Date('2026-03-01T00:00:00.000Z');
    const old = startTrajectory(db, { jobId, model: 'm' }, new Date('2026-01-29T23:59:59.000Z'));
    appendTrajectoryStep(db, old.id, step(1, { kind: 'model', turn: 1, text: null, toolCalls: [], durationMs: 1 }));
    const recent = startTrajectory(db, { jobId, model: 'm' }, new Date('2026-01-30T00:00:01.000Z'));

    expect(pruneTrajectories(db, now)).toBe(1);
    expect(getTrajectory(db, old.id)).toBeNull();
    expect(getTrajectory(db, recent.id)).not.toBeNull();
    const orphaned = sqlite
      .prepare('SELECT COUNT(*) AS count FROM metadata_trajectory_steps WHERE trajectory_id = ?')
      .get(old.id) as { count: number };
    expect(orphaned.count).toBe(0);
  });
});

async function startApp(assistant: AssistantTransport, options: { configure?: boolean } = {}) {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const appConfig = tempConfig(temp.dir);
  migrate({ databasePath: appConfig.databasePath, migrationsDir: defaultMigrationsDir() });
  if (options.configure !== false) {
    writeAssistantSettings(appConfig.dataDir, { baseUrl: config.baseUrl, model: 'scripted-model', apiKey: API_KEY });
  }
  const app = await buildApp({ config: appConfig, clientDist: null, logger: false, assistant, openLibrary });
  cleanups.push(() => {
    void app.close();
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  const cookie = (setup.headers['set-cookie'] as string).split(';')[0] ?? '';
  const libraryId = setup.json().library.id as number;
  return { app, appConfig, cookie, libraryId };
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function upload(app: App, cookie: string, libraryId: number, content: Buffer): Promise<number> {
  const boundary = '----qijuanboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="quiet.epub"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const created = await app.inject({
    method: 'POST',
    url: `/api/imports?libraryId=${libraryId}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie },
    payload,
  });
  expect(created.statusCode).toBe(202);
  return created.json().job.id as number;
}

async function waitForJob(app: App, cookie: string, id: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
    const job = response.json().job as {
      status: string;
      result: unknown;
      trajectoryId?: number;
      trajectoryStepCount?: number;
      items: Array<{ status: string; error: string | null; editionId: number | null; trajectoryId?: number; trajectoryStepCount?: number }>;
    };
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${id} did not finish`);
}

async function addReader(app: App, adminCookie: string, libraryId: number): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie: adminCookie },
    payload: { username: 'bea', password },
  });
  expect(created.statusCode).toBe(201);
  const userId = created.json().user.id as number;
  const grant = await app.inject({
    method: 'POST',
    url: `/api/libraries/${libraryId}/grants`,
    headers: { cookie: adminCookie },
    payload: { userId },
  });
  expect(grant.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/api/session/login', payload: { username: 'bea', password } });
  expect(login.statusCode).toBe(200);
  return (login.headers['set-cookie'] as string).split(';')[0] ?? '';
}

describe('trajectory api', () => {
  it('shows partial steps while the upload runs, then the whole run, to admins only', async () => {
    const midRun: Array<{ items: number | undefined; steps: string[] }> = [];
    const started: { app?: App; cookie?: string; jobId?: number } = {};
    const assistant = searchRecordSubmit(async (index) => {
      if (index !== 2 || !started.app || !started.jobId) return;
      // Poll from inside the third model request: the first two turns are already stored.
      const job = await started.app.inject({ method: 'GET', url: `/api/jobs/${started.jobId}`, headers: { cookie: started.cookie! } });
      const item = job.json().job.items[0] as { trajectoryId?: number; trajectoryStepCount?: number };
      const trajectory = await started.app.inject({
        method: 'GET',
        url: `/api/metadata/trajectories/${item.trajectoryId}`,
        headers: { cookie: started.cookie! },
      });
      midRun.push({
        items: item.trajectoryStepCount,
        steps: (trajectory.json().trajectory.steps as Array<{ kind: string }>).map((entry) => entry.kind),
      });
    });
    const { app, appConfig, cookie, libraryId } = await startApp(assistant);
    Object.assign(started, { app, cookie });
    started.jobId = await upload(app, cookie, libraryId, buildEpub());
    const job = await waitForJob(app, cookie, started.jobId);

    expect(midRun).toEqual([
      {
        items: 7,
        steps: ['input', 'model', 'tool_call', 'tool_result', 'model', 'tool_call', 'tool_result'],
      },
    ]);
    const item = job.items[0]!;
    expect(item.status).toBe('succeeded');
    expect(item.trajectoryId).toEqual(expect.any(Number));
    // The run's ten steps, then the cover notes: no Open Library image, so the file's own cover.
    expect(item.trajectoryStepCount).toBe(12);

    const response = await app.inject({
      method: 'GET',
      url: `/api/metadata/trajectories/${item.trajectoryId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const trajectory = response.json().trajectory as {
      outcome: string;
      model: string;
      summary: unknown;
      steps: Array<{ seq: number; kind: string; data: Record<string, unknown> }>;
    };
    expect(trajectory.outcome).toBe('accepted');
    expect(trajectory.model).toBe('scripted-model');
    expect(trajectory.summary).toMatchObject({ turns: 3, toolCalls: 3 });
    expect(trajectory.steps.map((entry) => entry.kind)).toEqual([
      'input',
      'model',
      'tool_call',
      'tool_result',
      'model',
      'tool_call',
      'tool_result',
      'model',
      'submit',
      'end',
      'note',
      'note',
    ]);
    expect(trajectory.steps.slice(-2).map((entry) => entry.data.message)).toEqual([
      'No cover from Open Library',
      'Cover taken from the file',
    ]);
    expect(trajectory.steps[0]?.data).toMatchObject({ input: { filename: 'quiet.epub', format: 'epub' } });

    // Readers: no trajectory fields in any job payload, and 403 from the endpoint.
    const readerCookie = await addReader(app, cookie, libraryId);
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: readerCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().jobs).toHaveLength(1);
    expect(list.body).not.toContain('trajectory');
    const single = await app.inject({ method: 'GET', url: `/api/jobs/${started.jobId}`, headers: { cookie: readerCookie } });
    expect(single.statusCode).toBe(200);
    expect(single.body).not.toContain('trajectory');
    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/metadata/trajectories/${item.trajectoryId}`,
      headers: { cookie: readerCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).not.toContain('quiet.epub');

    const adminList = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } });
    expect(adminList.json().jobs[0].items[0]).toMatchObject({ trajectoryId: item.trajectoryId, trajectoryStepCount: 12 });

    const missing = await app.inject({ method: 'GET', url: '/api/metadata/trajectories/999999', headers: { cookie } });
    expect(missing.statusCode).toBe(404);

    // The API key is never stored with the trajectory, nor anywhere in the database.
    const raw = new Database(appConfig.databasePath, { readonly: true });
    const rows = [
      ...raw.prepare('SELECT * FROM metadata_trajectories').all(),
      ...raw.prepare('SELECT * FROM metadata_trajectory_steps').all(),
      ...raw.prepare('SELECT * FROM jobs').all(),
      ...raw.prepare('SELECT * FROM job_items').all(),
    ];
    raw.close();
    expect(JSON.stringify(rows)).not.toContain(API_KEY);
    expect(response.body).not.toContain(API_KEY);
  });

  it('records the lookup run with its job and preview, and 404s once pruned', async () => {
    let lookup = false;
    const assistant = scripted(() =>
      lookup
        ? { tool_calls: [{ name: 'submit_metadata', arguments: { ...submission, title: 'Looked Up' } }] }
        : { tool_calls: [{ name: 'submit_metadata', arguments: submission }] },
    );
    const { app, appConfig, cookie, libraryId } = await startApp(assistant);
    const imported = await waitForJob(app, cookie, await upload(app, cookie, libraryId, buildEpub()));
    const editionId = imported.items[0]!.editionId!;

    lookup = true;
    const queued = await app.inject({
      method: 'POST',
      url: `/api/editions/${editionId}/metadata/lookup`,
      headers: { cookie },
    });
    expect(queued.statusCode).toBe(202);
    const job = await waitForJob(app, cookie, queued.json().job.id as number);
    expect(job.status).toBe('succeeded');
    expect(job.trajectoryId).toEqual(expect.any(Number));
    // input, model, submit, end, and one cover note.
    expect(job.trajectoryStepCount).toBe(5);

    const response = await app.inject({
      method: 'GET',
      url: `/api/metadata/trajectories/${job.trajectoryId}`,
      headers: { cookie },
    });
    const trajectory = response.json().trajectory as { editionId: number; previewId: number; jobItemId: number | null };
    const previewId = (job.result as { preview: { previewId: number } }).preview.previewId;
    expect(trajectory).toMatchObject({ editionId, previewId, jobItemId: null });

    const db = openDatabase(appConfig.databasePath);
    db.sqlite.prepare("UPDATE metadata_trajectories SET created_at = '2020-01-01T00:00:00.000Z'").run();
    expect(pruneTrajectories(db.db)).toBe(2);
    db.sqlite.close();
    const gone = await app.inject({ method: 'GET', url: `/api/metadata/trajectories/${job.trajectoryId}`, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
    const after = await app.inject({ method: 'GET', url: `/api/jobs/${queued.json().job.id}`, headers: { cookie } });
    expect(after.body).not.toContain('trajectory');
  });

  it('writes no trajectory when the assistant is not configured', async () => {
    const { app, appConfig, cookie, libraryId } = await startApp(scripted(() => ({})), { configure: false });
    const job = await waitForJob(app, cookie, await upload(app, cookie, libraryId, buildEpub()));
    expect(job.items[0]).toMatchObject({ status: 'failed', error: 'metadata_assistant_unconfigured' });
    expect(job.items[0]).not.toHaveProperty('trajectoryId');
    const raw = new Database(appConfig.databasePath, { readonly: true });
    const count = raw.prepare('SELECT COUNT(*) AS count FROM metadata_trajectories').get() as { count: number };
    raw.close();
    expect(count.count).toBe(0);
  });

  it('records a failed upload run', async () => {
    const assistant: AssistantTransport = { fetch: async () => new Response('down', { status: 503 }) };
    const { app, cookie, libraryId } = await startApp(assistant);
    const job = await waitForJob(app, cookie, await upload(app, cookie, libraryId, buildEpub()));
    const item = job.items[0]!;
    expect(item).toMatchObject({ status: 'failed', error: 'metadata_unavailable', trajectoryStepCount: 2 });
    const response = await app.inject({ method: 'GET', url: `/api/metadata/trajectories/${item.trajectoryId}`, headers: { cookie } });
    expect(response.json().trajectory).toMatchObject({ outcome: 'failed', error: 'metadata_unavailable' });
  });
});
