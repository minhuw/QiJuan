import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  classifyEmbeddedIdentifier,
  identifierUrl,
  identifierUrn,
  normalizeIdentifier,
  normalizeIdentifierList,
  toIsbn13,
} from '../src/identifiers.js';
import type { AssistantTransport } from '../src/metadata/assistant/client.js';
import type { OpenLibraryTransport } from '../src/metadata/openLibrary.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { buildEpub, buildTextPdf, TEXT_PDF_AUTHOR, TEXT_PDF_TITLE } from './fixtures.js';
import { configureTestAssistant, makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('identifier normalization', () => {
  it('converts ISBN-10 to ISBN-13 and strips hyphens, spaces, and URN prefixes', () => {
    expect(normalizeIdentifier('isbn', '0-14-032872-6')).toEqual({ ok: true, scheme: 'isbn', value: '9780140328721' });
    expect(normalizeIdentifier('ISBN', 'urn:isbn:978 0 14 032872 1')).toEqual({
      ok: true,
      scheme: 'isbn',
      value: '9780140328721',
    });
    expect(normalizeIdentifier('isbn-13', '978-7-01-013418-5')).toEqual({ ok: true, scheme: 'isbn', value: '9787010134185' });
    expect(normalizeIdentifier('isbn', '080442957X')).toEqual({ ok: true, scheme: 'isbn', value: '9780804429573' });
    expect(toIsbn13('0140328726')).toBe('9780140328721');
  });

  it('rejects a bad checksum or shape with a reason', () => {
    expect(normalizeIdentifier('isbn', '9780140328722')).toEqual({ ok: false, reason: 'invalid_checksum' });
    expect(normalizeIdentifier('isbn', '0140328727')).toEqual({ ok: false, reason: 'invalid_checksum' });
    expect(normalizeIdentifier('isbn', '12345')).toEqual({ ok: false, reason: 'invalid_format' });
    expect(normalizeIdentifier('issn', '0317-8472')).toEqual({ ok: false, reason: 'invalid_checksum' });
    expect(normalizeIdentifier('bad scheme!', 'x')).toEqual({ ok: false, reason: 'invalid_scheme' });
    expect(normalizeIdentifier('doi', '')).toEqual({ ok: false, reason: 'invalid_value' });
  });

  it('normalizes DOI forms to lowercase without a resolver prefix', () => {
    for (const form of [
      '10.1000/XYZ.123',
      'doi:10.1000/xyz.123',
      'https://doi.org/10.1000/xyz.123',
      'http://dx.doi.org/10.1000/XYZ.123',
      'urn:doi:10.1000/xyz.123',
      'https://doi.org/10.1000%2Fxyz.123',
    ]) {
      expect(normalizeIdentifier('doi', form)).toEqual({ ok: true, scheme: 'doi', value: '10.1000/xyz.123' });
    }
    expect(normalizeIdentifier('doi', '11.1000/xyz')).toEqual({ ok: false, reason: 'invalid_format' });
  });

  it('validates ISSN, OCLC, LCCN, and platform ids', () => {
    expect(normalizeIdentifier('issn', '0317-8471')).toEqual({ ok: true, scheme: 'issn', value: '0317-8471' });
    expect(normalizeIdentifier('eissn', '2434 561x')).toEqual({ ok: true, scheme: 'issn', value: '2434-561X' });
    expect(normalizeIdentifier('oclc', '(OCoLC)ocm00012345')).toEqual({ ok: true, scheme: 'oclc', value: '12345' });
    expect(normalizeIdentifier('lccn', 'n78-890351')).toEqual({ ok: true, scheme: 'lccn', value: 'n78890351' });
    expect(normalizeIdentifier('lccn', '2001-1114')).toEqual({ ok: true, scheme: 'lccn', value: '2001001114' });
    expect(normalizeIdentifier('olid', 'https://openlibrary.org/books/ol7353617m')).toEqual({
      ok: true,
      scheme: 'olid',
      value: 'OL7353617M',
    });
    expect(normalizeIdentifier('olid', '/works/OL45804W')).toEqual({ ok: true, scheme: 'olid', value: 'OL45804W' });
    expect(normalizeIdentifier('google_books', 'https://books.google.com/books?id=zyTCAlFPjgYC&pg=1')).toEqual({
      ok: true,
      scheme: 'google_books',
      value: 'zyTCAlFPjgYC',
    });
    expect(normalizeIdentifier('douban', 'https://book.douban.com/subject/1084336/')).toEqual({
      ok: true,
      scheme: 'douban',
      value: '1084336',
    });
    expect(normalizeIdentifier('olid', 'OL1A')).toEqual({ ok: false, reason: 'invalid_format' });
    expect(normalizeIdentifier('uuid', 'urn:uuid:x')).toEqual({ ok: true, scheme: 'uuid', value: 'urn:uuid:x' });
  });

  it('builds canonical source URLs and feed identifiers', () => {
    expect(identifierUrl('doi', '10.1000/xyz.123')).toBe('https://doi.org/10.1000/xyz.123');
    expect(identifierUrl('douban', '1084336')).toBe('https://book.douban.com/subject/1084336/');
    expect(identifierUrl('olid', 'OL7353617M')).toBe('https://openlibrary.org/books/OL7353617M');
    expect(identifierUrl('olid', 'OL45804W')).toBe('https://openlibrary.org/works/OL45804W');
    expect(identifierUrl('google_books', 'zyTCAlFPjgYC')).toBe('https://books.google.com/books?id=zyTCAlFPjgYC');
    expect(identifierUrl('isbn', '9780140328721')).toBe('https://search.worldcat.org/search?q=bn:9780140328721');
    expect(identifierUrl('isbn', '9787010134185')).toBe('https://book.douban.com/isbn/9787010134185/');
    expect(identifierUrl('uuid', 'x')).toBeNull();
    expect(identifierUrn('isbn', '9780140328721')).toBe('urn:isbn:9780140328721');
    expect(identifierUrn('uuid', 'urn:uuid:x')).toBe('uuid:urn:uuid:x');
  });

  it('classifies embedded values and reports dropped ones', () => {
    expect(classifyEmbeddedIdentifier('urn:isbn:9780140328721', 'uuid')).toEqual({
      scheme: 'isbn',
      value: 'urn:isbn:9780140328721',
    });
    expect(classifyEmbeddedIdentifier('978-0-14-032872-1')).toEqual({ scheme: 'isbn', value: '978-0-14-032872-1' });
    expect(classifyEmbeddedIdentifier('https://doi.org/10.1000/x')).toEqual({ scheme: 'doi', value: 'https://doi.org/10.1000/x' });
    expect(
      normalizeIdentifierList([
        { scheme: 'isbn', value: '0140328726' },
        { scheme: 'isbn', value: '9780140328721' },
        { scheme: 'isbn', value: '9780140328722' },
      ]),
    ).toEqual({
      identifiers: [{ scheme: 'isbn', value: '9780140328721' }],
      dropped: [{ scheme: 'isbn', value: '9780140328722', reason: 'invalid_checksum' }],
    });
  });
});

type Submission = Record<string, unknown>;

function submission(title: string, overrides: Submission = {}): Submission {
  return {
    title,
    authors: ['Ada Lovelace'],
    translators: [],
    description: `About ${title}.`,
    publisher: 'QiJuan Press',
    publishedDate: '2024-01-01',
    language: 'en',
    identifiers: [],
    series: null,
    seriesOrder: null,
    coverId: null,
    isbn: null,
    ...overrides,
  };
}

/** Submits the metadata registered for each filename. */
function filenameAssistant(byFile: Map<string, Submission>): AssistantTransport {
  return {
    async fetch(_input, init) {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> };
      const user = body.messages?.find((message) => message.role === 'user');
      const input = JSON.parse(String(user?.content ?? '{}')) as { filename: string };
      const args = byFile.get(input.filename);
      if (!args) throw new Error(`no scripted submission for ${input.filename}`);
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_metadata', arguments: JSON.stringify(args) } }],
            },
          },
        ],
      });
    },
  };
}

const noOpenLibrary: OpenLibraryTransport = {
  origin: 'https://ol.example',
  async fetch() {
    return new Response('missing', { status: 404 });
  },
};

interface ItemView {
  id: number;
  filename: string;
  status: string;
  error: string | null;
  editionId: number | null;
  assetId: number | null;
  candidateEditionId: number | null;
  conflicts: string[];
  merged: boolean;
  resolution: string | null;
  trajectoryId?: number;
}

interface JobView {
  id: number;
  status: string;
  summary: Record<string, number>;
  items: ItemView[];
}

async function startApp() {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  configureTestAssistant(config.dataDir);
  const byFile = new Map<string, Submission>();
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    assistant: filenameAssistant(byFile),
    openLibrary: noOpenLibrary,
  });
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

  async function waitForJob(id: number): Promise<JobView> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const job = response.json().job as JobView;
      if (job.status === 'succeeded' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`job ${id} did not finish`);
  }

  async function upload(files: Array<{ filename: string; content: Buffer; metadata: Submission }>): Promise<JobView> {
    const boundary = '----qijuanids';
    const chunks: Buffer[] = [];
    for (const file of files) {
      byFile.set(file.filename, file.metadata);
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        file.content,
        Buffer.from('\r\n'),
      );
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const created = await app.inject({
      method: 'POST',
      url: `/api/imports?libraryId=${libraryId}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie },
      payload: Buffer.concat(chunks),
    });
    expect(created.statusCode).toBe(202);
    return waitForJob(created.json().job.id as number);
  }

  async function edition(id: number, as = cookie) {
    const response = await app.inject({ method: 'GET', url: `/api/editions/${id}`, headers: { cookie: as } });
    expect(response.statusCode).toBe(200);
    return response.json().edition as {
      id: number;
      title: string;
      identifiers: Array<Record<string, unknown>>;
      assets: Array<{ format: string }>;
      locks: string[];
      suggestions: Array<{ otherEditionId: number; reasons: string[] }>;
    };
  }

  function count(sql: string): number {
    const db = new Database(config.databasePath, { readonly: true });
    try {
      return (db.prepare(sql).get() as { count: number }).count;
    } finally {
      db.close();
    }
  }

  return { app, config, cookie, libraryId, upload, waitForJob, edition, count };
}

const isbn = (value: string, sourceUrl?: string) => ({ scheme: 'isbn', value, ...(sourceUrl ? { sourceUrl } : {}) });

describe('identifier merging on import', () => {
  it('adds a second format with the same ISBN to the existing edition', async () => {
    const started = await startApp();
    const first = await started.upload([
      {
        filename: 'book.epub',
        content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000001', title: 'Quiet Book' }),
        metadata: submission('Quiet Book', { identifiers: [isbn('0-14-032872-6', 'https://openlibrary.org/isbn/0140328726')] }),
      },
    ]);
    expect(first.items[0]).toMatchObject({ status: 'succeeded', merged: false });
    const editionId = first.items[0]!.editionId!;

    // Same ISBN in another spelling, a case and punctuation variant of the title, and one shared author.
    const second = await started.upload([
      {
        filename: 'book.pdf',
        content: buildTextPdf(),
        metadata: submission('quiet  book!', {
          authors: ['ada lovelace', 'Someone Else'],
          identifiers: [isbn('9780140328721'), { scheme: 'oclc', value: 'ocm00012345' }],
        }),
      },
    ]);
    expect(second.items[0]).toMatchObject({ status: 'succeeded', merged: true, editionId, candidateEditionId: null });
    expect(started.count('SELECT count(*) AS count FROM editions')).toBe(1);
    const detail = await started.edition(editionId);
    expect(detail.title).toBe('Quiet Book');
    expect(detail.assets.map((asset) => asset.format)).toEqual(['epub', 'pdf']);
    expect(detail.identifiers).toEqual([
      expect.objectContaining({
        scheme: 'isbn',
        value: '9780140328721',
        url: 'https://search.worldcat.org/search?q=bn:9780140328721',
        source: 'agent',
        sourceUrl: 'https://openlibrary.org/isbn/0140328726',
      }),
      expect.objectContaining({ scheme: 'oclc', value: '12345', url: 'https://www.worldcat.org/oclc/12345', source: 'agent' }),
    ]);
  });

  it('merges on an exact platform id, and never on a different one', async () => {
    const started = await startApp();
    const olid = (value: string) => ({ scheme: 'olid', value });
    const first = await started.upload([
      { filename: 'a.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000011', title: 'Platform' }), metadata: submission('Platform', { identifiers: [olid('OL7353617M')] }) },
    ]);
    const editionId = first.items[0]!.editionId!;
    const same = await started.upload([
      { filename: 'a.pdf', content: buildTextPdf(), metadata: submission('Platform', { identifiers: [olid('/books/ol7353617m')] }) },
    ]);
    expect(same.items[0]).toMatchObject({ status: 'succeeded', merged: true, editionId });

    const other = await started.upload([
      {
        filename: 'b.epub',
        content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000012', title: 'Platform' }),
        metadata: submission('Platform', { identifiers: [olid('OL7353618M'), { scheme: 'uuid', value: 'shared-but-not-merging' }] }),
      },
    ]);
    expect(other.items[0]).toMatchObject({ status: 'succeeded', merged: false });
    expect(other.items[0]!.editionId).not.toBe(editionId);
  });

  it('holds a conflicting match for confirmation and merges it when an admin says so', async () => {
    const started = await startApp();
    const first = await started.upload([
      { filename: 'one.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000021', title: 'First Title' }), metadata: submission('First Title', { identifiers: [isbn('9780140328721')] }) },
    ]);
    const candidate = first.items[0]!.editionId!;
    const held = await started.upload([
      { filename: 'other.pdf', content: buildTextPdf(), metadata: submission('A Different Title', { authors: ['Nobody Shared'], identifiers: [isbn('9780140328721')] }) },
    ]);
    expect(held.status).toBe('succeeded');
    expect(held.summary.needs_confirmation).toBe(1);
    const item = held.items[0]!;
    expect(item).toMatchObject({
      status: 'needs_confirmation',
      editionId: null,
      assetId: null,
      candidateEditionId: candidate,
      conflicts: ['title', 'authors'],
      merged: false,
      incoming: {
        title: 'A Different Title',
        authors: ['Nobody Shared'],
        format: 'pdf',
        identifier: { scheme: 'isbn', value: '9780140328721' },
      },
    });
    expect(started.count('SELECT count(*) AS count FROM file_assets')).toBe(1);
    // The staged upload stays until the decision.
    const staged = new Database(started.config.databasePath, { readonly: true });
    const sourcePath = (staged.prepare('SELECT source_path AS p FROM job_items WHERE id = ?').get(item.id) as { p: string }).p;
    staged.close();
    expect(existsSync(path.join(started.config.dataDir, sourcePath))).toBe(true);

    const merged = await started.app.inject({
      method: 'POST',
      url: `/api/jobs/${held.id}/items/${item.id}/merge`,
      headers: { cookie: started.cookie },
    });
    expect(merged.statusCode).toBe(202);
    const done = await started.waitForJob(held.id);
    expect(done.items[0]).toMatchObject({ status: 'succeeded', editionId: candidate, merged: true, resolution: 'merge' });
    expect(started.count('SELECT count(*) AS count FROM editions')).toBe(1);
    const detail = await started.edition(candidate);
    expect(detail.title).toBe('First Title');
    expect(detail.assets.map((asset) => asset.format)).toEqual(['epub', 'pdf']);
    expect(existsSync(path.join(started.config.dataDir, sourcePath))).toBe(false);

    const again = await started.app.inject({
      method: 'POST',
      url: `/api/jobs/${held.id}/items/${item.id}/merge`,
      headers: { cookie: started.cookie },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'conflict' });
  });

  it('treats a format the edition already has as a conflict, and keeps it separate on request', async () => {
    const started = await startApp();
    const first = await started.upload([
      { filename: 'one.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000031', title: 'Same Book' }), metadata: submission('Same Book', { identifiers: [isbn('9780140328721')] }) },
    ]);
    const candidate = first.items[0]!.editionId!;
    const held = await started.upload([
      { filename: 'two.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000032', title: 'Same Book' }), metadata: submission('Same Book', { identifiers: [isbn('9780140328721')] }) },
    ]);
    const item = held.items[0]!;
    expect(item).toMatchObject({ status: 'needs_confirmation', candidateEditionId: candidate, conflicts: ['format'] });

    const separate = await started.app.inject({
      method: 'POST',
      url: `/api/jobs/${held.id}/items/${item.id}/keep-separate`,
      headers: { cookie: started.cookie },
    });
    expect(separate.statusCode).toBe(202);
    const done = await started.waitForJob(held.id);
    const created = done.items[0]!;
    expect(created).toMatchObject({ status: 'succeeded', merged: false, resolution: 'separate', candidateEditionId: candidate });
    expect(created.editionId).not.toBe(candidate);
    expect(started.count('SELECT count(*) AS count FROM editions')).toBe(2);
    // The two stay apart and show up as similar editions, for the same identifier.
    const detail = await started.edition(created.editionId!);
    expect(detail.suggestions).toEqual([
      expect.objectContaining({
        otherEditionId: candidate,
        reasons: ['title_author', 'identifier'],
        identifier: { scheme: 'isbn', value: '9780140328721' },
      }),
    ]);
  });

  it('lets only admins resolve, and refuses an item that is not waiting', async () => {
    const started = await startApp();
    await started.upload([
      { filename: 'one.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000041', title: 'Shared' }), metadata: submission('Shared', { identifiers: [isbn('9780140328721')] }) },
    ]);
    const held = await started.upload([
      { filename: 'two.pdf', content: buildTextPdf(), metadata: submission('Different', { identifiers: [isbn('9780140328721')] }) },
    ]);
    const item = held.items[0]!;
    expect(item.status).toBe('needs_confirmation');

    const reader = await started.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: started.cookie },
      payload: { username: 'bea', password: 'reader-password' },
    });
    const readerId = reader.json().user.id as number;
    await started.app.inject({
      method: 'POST',
      url: `/api/libraries/${started.libraryId}/grants`,
      headers: { cookie: started.cookie },
      payload: { userId: readerId },
    });
    const login = await started.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'bea', password: 'reader-password' },
    });
    const readerCookie = (login.headers['set-cookie'] as string).split(';')[0] ?? '';
    const forbidden = await started.app.inject({
      method: 'POST',
      url: `/api/jobs/${held.id}/items/${item.id}/merge`,
      headers: { cookie: readerCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    // The candidate is gone: merging is refused, keeping separate still works.
    const db = new Database(started.config.databasePath);
    db.prepare("UPDATE editions SET trashed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(item.candidateEditionId);
    db.close();
    const gone = await started.app.inject({
      method: 'POST',
      url: `/api/jobs/${held.id}/items/${item.id}/merge`,
      headers: { cookie: started.cookie },
    });
    expect(gone.statusCode).toBe(404);
    const missing = await started.app.inject({
      method: 'POST',
      url: `/api/jobs/${held.id}/items/999/keep-separate`,
      headers: { cookie: started.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('imports an upload with no identifier as Unidentified and notes dropped identifiers', async () => {
    const started = await startApp();
    const job = await started.upload([
      {
        filename: 'plain.epub',
        content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000051', title: 'Plain' }),
        metadata: submission('Plain', { identifiers: [isbn('9780140328722')] }),
      },
    ]);
    const item = job.items[0]!;
    expect(item).toMatchObject({ status: 'succeeded', error: null });
    // An upload keeps only the agent's identifiers; the invalid ISBN was dropped, so none are left.
    const detail = await started.edition(item.editionId!);
    expect(detail.identifiers).toEqual([]);
    const unidentified = await started.app.inject({
      method: 'GET',
      url: '/api/library?limit=20&identified=0',
      headers: { cookie: started.cookie },
    });
    expect(unidentified.json().editions.map((card: { id: number }) => card.id)).toEqual([item.editionId]);
    const trajectory = await started.app.inject({
      method: 'GET',
      url: `/api/metadata/trajectories/${item.trajectoryId}`,
      headers: { cookie: started.cookie },
    });
    expect(trajectory.statusCode).toBe(200);
    const steps = trajectory.json().trajectory.steps as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(steps.find((step) => step.kind === 'note')?.data).toEqual({
      message: 'identifiers_dropped',
      dropped: [{ scheme: 'isbn', value: '9780140328722', reason: 'invalid_checksum' }],
    });
  });

  it('merges a folder import by its embedded ISBN', async () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const config = tempConfig(temp.dir);
    migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
    const root = path.join(temp.dir, 'indexed');
    mkdirSync(root, { recursive: true });
    // The text PDF carries urn:isbn:9780000000002. The EPUB says the same, with the same title and author.
    writeFileSync(path.join(root, 'a.pdf'), buildTextPdf());
    writeFileSync(
      path.join(root, 'b.epub'),
      buildEpub({ identifier: 'urn:isbn:978-0-00-000000-2', title: TEXT_PDF_TITLE, author: TEXT_PDF_AUTHOR }),
    );
    const app = await buildApp({ config, clientDist: null, logger: false });
    cleanups.push(() => {
      void app.close();
    });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'ada', password, libraryName: 'Home' } });
    const cookie = (setup.headers['set-cookie'] as string).split(';')[0] ?? '';
    const db = new Database(config.databasePath);
    const library = db
      .prepare(`INSERT INTO libraries (name, mode, root_path, created_at) VALUES ('Shelf', 'indexed', ?, ?) RETURNING id`)
      .get(root, new Date().toISOString()) as { id: number };
    db.close();
    const created = await app.inject({
      method: 'POST',
      url: '/api/imports/folder',
      headers: { cookie },
      payload: { libraryId: library.id, path: '.' },
    });
    expect(created.statusCode).toBe(202);
    let job: JobView | null = null;
    for (let attempt = 0; attempt < 120 && !job; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: `/api/jobs/${created.json().job.id}`, headers: { cookie } });
      const view = response.json().job as JobView;
      if (view.status === 'succeeded' || view.status === 'failed') job = view;
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(job?.items.map((item) => [item.filename, item.status, item.merged])).toEqual([
      ['a.pdf', 'succeeded', false],
      ['b.epub', 'succeeded', true],
    ]);
    expect(job?.items[1]?.editionId).toBe(job?.items[0]?.editionId);
  });
});

describe('identifiers on existing editions', () => {
  it('suggests, never merges, when an edit gives two editions the same identifier', async () => {
    const started = await startApp();
    const job = await started.upload([
      { filename: 'x.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000061', title: 'Left' }), metadata: submission('Left', { authors: ['A'] }) },
      { filename: 'y.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000062', title: 'Right' }), metadata: submission('Right', { authors: ['B'] }) },
    ]);
    const [left, right] = job.items.map((item) => item.editionId!);
    for (const id of [left, right]) {
      const patched = await started.app.inject({
        method: 'PATCH',
        url: `/api/editions/${id}`,
        headers: { cookie: started.cookie },
        payload: { identifiers: [{ scheme: 'doi', value: 'https://doi.org/10.1000/SHARED' }] },
      });
      expect(patched.statusCode).toBe(200);
    }
    expect(started.count('SELECT count(*) AS count FROM editions WHERE trashed_at IS NULL')).toBe(2);
    const detail = await started.edition(left!);
    expect(detail.suggestions).toEqual([expect.objectContaining({ otherEditionId: right, reasons: ['identifier'] })]);
  });

  it('validates manual identifier edits, records them as manual, and locks the set', async () => {
    const started = await startApp();
    const job = await started.upload([
      { filename: 'm.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000071', title: 'Manual' }), metadata: submission('Manual', { identifiers: [isbn('9780140328721')] }) },
    ]);
    const id = job.items[0]!.editionId!;
    const patch = (identifiers: unknown) =>
      started.app.inject({ method: 'PATCH', url: `/api/editions/${id}`, headers: { cookie: started.cookie }, payload: { identifiers } });

    const bad = await patch([{ scheme: 'isbn', value: '9780140328722' }]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_identifier', index: 0 });
    // The error names the rejected row.
    const second = await patch([{ scheme: 'isbn', value: '9780140328721' }, { scheme: 'doi', value: 'not-a-doi' }]);
    expect(second.json()).toEqual({ error: 'invalid_identifier', index: 1 });
    expect((await patch([{ scheme: 'isbn' }])).statusCode).toBe(400);
    expect((await patch([{ scheme: 'doi', value: '10.1/x', sourceUrl: 'javascript:alert(1)' }])).statusCode).toBe(400);

    // A legacy value that does not validate (kept by migration 0016) may be sent back unchanged.
    const db = new Database(started.config.databasePath);
    db.prepare(
      "INSERT INTO edition_identifiers (edition_id, scheme, value, source, created_at) VALUES (?, 'isbn', 'legacy-isbn', 'embedded', ?)",
    ).run(id, '2026-01-01T00:00:00.000Z');
    db.close();
    const before = await started.edition(id);
    expect(before.identifiers.map((item) => item.value)).toEqual(['9780140328721', 'legacy-isbn']);
    // Send back the agent's ISBN and the legacy value as they came (url, source, ...), add a Douban id.
    const kept = await patch([...before.identifiers, { scheme: 'douban', value: 'https://book.douban.com/subject/1084336/' }]);
    expect(kept.statusCode).toBe(200);
    // Then remove the legacy value and rewrite the ISBN as ISBN-10: it is the same identifier.
    const ok = await patch([
      { scheme: 'isbn', value: '0-14-032872-6' },
      { scheme: 'douban', value: '1084336' },
    ]);
    expect(ok.statusCode).toBe(200);
    const after = ok.json().edition as typeof before;
    expect(after.identifiers).toEqual([
      expect.objectContaining({ scheme: 'isbn', value: '9780140328721', source: 'agent' }),
      expect.objectContaining({
        scheme: 'douban',
        value: '1084336',
        url: 'https://book.douban.com/subject/1084336/',
        source: 'manual',
        sourceUrl: null,
      }),
    ]);
    expect(after.locks).toContain('identifiers');
  });

  it('gives readers scheme, value, and url, and admins the provenance too', async () => {
    const started = await startApp();
    const job = await started.upload([
      { filename: 'r.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000081', title: 'Read' }), metadata: submission('Read', { identifiers: [{ scheme: 'doi', value: '10.1000/abc', sourceUrl: 'https://example.org/abc' }] }) },
    ]);
    const id = job.items[0]!.editionId!;
    const reader = await started.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: started.cookie },
      payload: { username: 'bea', password: 'reader-password' },
    });
    await started.app.inject({
      method: 'POST',
      url: `/api/libraries/${started.libraryId}/grants`,
      headers: { cookie: started.cookie },
      payload: { userId: reader.json().user.id },
    });
    const login = await started.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { username: 'bea', password: 'reader-password' },
    });
    const readerCookie = (login.headers['set-cookie'] as string).split(';')[0] ?? '';

    const admin = await started.edition(id);
    expect(admin.identifiers.find((item) => item.scheme === 'doi')).toEqual({
      scheme: 'doi',
      value: '10.1000/abc',
      url: 'https://doi.org/10.1000/abc',
      source: 'agent',
      sourceUrl: 'https://example.org/abc',
      createdAt: expect.any(String),
    });
    const readerView = await started.edition(id, readerCookie);
    expect(readerView.identifiers.find((item) => item.scheme === 'doi')).toEqual({
      scheme: 'doi',
      value: '10.1000/abc',
      url: 'https://doi.org/10.1000/abc',
    });
  });

  it('filters the library by identified=0|1', async () => {
    const started = await startApp();
    await started.upload([
      { filename: 'i.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000091', title: 'Has Isbn' }), metadata: submission('Has Isbn', { identifiers: [isbn('9780140328721')] }) },
      { filename: 'u.epub', content: buildEpub({ identifier: 'urn:uuid:aaaaaaaa-0000-4000-8000-000000000092', title: 'Only Uuid' }), metadata: submission('Only Uuid') },
    ]);
    const list = async (query: string) => {
      const response = await started.app.inject({ method: 'GET', url: `/api/library?limit=20${query}`, headers: { cookie: started.cookie } });
      return response;
    };
    const identified = await list('&identified=1');
    expect(identified.statusCode).toBe(200);
    expect(identified.json().editions.map((card: { title: string; identified: boolean }) => [card.title, card.identified])).toEqual([
      ['Has Isbn', true],
    ]);
    const unidentified = await list('&identified=0');
    expect(unidentified.json().editions.map((card: { title: string }) => card.title)).toEqual(['Only Uuid']);
    expect(unidentified.json().total).toBe(1);
    expect((await list('')).json().total).toBe(2);
    expect((await list('&identified=yes')).statusCode).toBe(400);
  });
});
