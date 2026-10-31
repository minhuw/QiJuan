import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { absoluteBlobPath } from '../src/blobs.js';
import { coverTintPair, deriveCoverTint, rgbToOklab, tintFromSamples } from '../src/cover-tint.js';
import { openDatabase } from '../src/db.js';
import { backfillCoverTints } from '../src/edition-fields.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { buildEpub, buildTextPdf } from './fixtures.js';
import { configureTestAssistant, embeddedMetadataAssistant, makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Synthetic covers made for these tests: ultramarine with a white title panel and a small vermilion mark. */
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', 'covers', name));

function oklch(hex: string): { l: number; c: number; h: number } {
  const [l, a, b] = rgbToOklab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

function hueOf(r: number, g: number, b: number): number {
  const [, a, bb] = rgbToOklab(r, g, b);
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

function hueDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** An 8-bit RGB PNG whose rows cycle through all five filter types. */
function rgbPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const rowBytes = width * 3;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(rowBytes);
    for (let x = 0; x < width; x += 1) row.set(pixel(x, y), x * 3);
    const filter = y % 5;
    const out = Buffer.alloc(rowBytes + 1);
    out[0] = filter;
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= 3 ? row[index - 3]! : 0;
      const up = previous[index]!;
      const upLeft = index >= 3 ? previous[index - 3]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        predictor = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      }
      out[index + 1] = (row[index]! - predictor) & 0xff;
    }
    rows.push(out);
    previous = row;
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    // The sampler does not check CRCs.
    return Buffer.concat([head, body, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('cover tint derivation', () => {
  const ultramarine = hueOf(0x2f, 0x4c, 0x8a);

  it('maps a JPEG cover to a very pale tint of its dominant hue', () => {
    const tint = deriveCoverTint(fixture('blue-baseline.jpg'), 'image/jpeg');
    expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    const { l, c, h } = oklch(tint!);
    expect(l).toBeGreaterThan(0.915);
    expect(l).toBeLessThan(0.945);
    expect(c).toBeLessThanOrEqual(0.031);
    expect(c).toBeGreaterThan(0.01);
    // The white panel and the small vermilion mark do not pull the hue away from the ground.
    expect(hueDistance(h, ultramarine)).toBeLessThan(12);
  });

  it('reads progressive and restart-interval JPEGs to the same tint', () => {
    const baseline = deriveCoverTint(fixture('blue-baseline.jpg'), 'image/jpeg');
    expect(deriveCoverTint(fixture('blue-progressive.jpg'), 'image/jpeg')).toBe(baseline);
    expect(deriveCoverTint(fixture('blue-restart.jpg'), 'image/jpeg')).toBe(baseline);
  });

  it('reads palette and filtered RGB PNGs', () => {
    const palette = deriveCoverTint(fixture('blue.png'), 'image/png');
    expect(hueDistance(oklch(palette!).h, ultramarine)).toBeLessThan(12);
    const green = rgbPng(40, 60, (x, y) => (y > 20 && y < 30 ? [250, 248, 240] : [0x3a, 0x74 + (x % 3), 0x4a]));
    const tint = deriveCoverTint(green, 'image/png');
    expect(tint).not.toBeNull();
    expect(hueDistance(oklch(tint!).h, hueOf(0x3a, 0x74, 0x4a))).toBeLessThan(12);
  });

  it('gives no tint for a neutral cover or an unreadable image', () => {
    expect(deriveCoverTint(fixture('grey.jpg'), 'image/jpeg')).toBeNull();
    expect(deriveCoverTint(rgbPng(20, 20, () => [240, 240, 240]), 'image/png')).toBeNull();
    expect(deriveCoverTint(Buffer.from('not an image'), 'image/jpeg')).toBeNull();
    expect(deriveCoverTint(fixture('blue-baseline.jpg').subarray(0, 200), 'image/jpeg')).toBeNull();
    expect(deriveCoverTint(Buffer.from('RIFF0000WEBPVP8 '), 'image/webp')).toBeNull();
  });

  it('takes the stronger of two hues instead of averaging them to grey', () => {
    const samples: number[] = [];
    for (let index = 0; index < 60; index += 1) samples.push(0xba, 0x38, 0x20);
    for (let index = 0; index < 40; index += 1) samples.push(0x2d, 0x64, 0x68);
    const { h, c } = oklch(tintFromSamples(samples)!);
    expect(hueDistance(h, hueOf(0xba, 0x38, 0x20))).toBeLessThan(12);
    expect(c).toBeGreaterThan(0.015);
  });

  it('pairs the day tint with a very dark night tint of the same hue, both readable', () => {
    const light = deriveCoverTint(fixture('blue-baseline.jpg'), 'image/jpeg')!;
    const pair = coverTintPair(light)!;
    expect(pair.light).toBe(light);
    const night = oklch(pair.dark);
    expect(night.l).toBeGreaterThan(0.18);
    expect(night.l).toBeLessThan(0.22);
    expect(night.c).toBeLessThanOrEqual(0.021);
    expect(hueDistance(night.h, oklch(light).h)).toBeLessThan(15);
    // Muted ink on the day band and night muted ink on the night band.
    expect(contrast('#665e52', pair.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#a79e8e', pair.dark)).toBeGreaterThanOrEqual(4.5);
    expect(coverTintPair('')).toBeNull();
    expect(coverTintPair(null)).toBeNull();
    expect(coverTintPair('red')).toBeNull();
  });
});

function multipart(parts: Array<{ name: string; filename: string; content: Buffer; type?: string }>) {
  const boundary = '----qijuanboundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
    );
    chunks.push(part.content);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function startApp(dir?: string) {
  const temp = dir ? null : makeTempDir();
  if (temp) cleanups.push(temp.cleanup);
  const root = dir ?? temp!.dir;
  const config = tempConfig(root);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  configureTestAssistant(config.dataDir);
  const app = await buildApp({
    config,
    clientDist: null,
    logger: false,
    assistant: embeddedMetadataAssistant(),
    openLibrary: {
      fetch: async () => {
        throw new Error('network disabled in test');
      },
    },
  });
  cleanups.push(() => {
    void app.close();
  });
  return { app, config, dir: root };
}

async function setUp(app: Awaited<ReturnType<typeof buildApp>>) {
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'ada', password, libraryName: 'Home' } });
  expect(setup.statusCode).toBe(201);
  const raw = setup.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
  return { cookie, libraryId: setup.json().library.id as number };
}

async function importBook(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  libraryId: number,
  epub = buildEpub(),
  filename = 'tale.epub',
): Promise<number> {
  const body = multipart([{ name: 'files', filename, content: epub }]);
  const created = await app.inject({
    method: 'POST',
    url: `/api/imports?libraryId=${libraryId}`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
  expect(created.statusCode).toBe(202);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${created.json().job.id}`, headers: { cookie } });
    const job = response.json().job as { status: string; items: Array<{ editionId: number | null }> };
    if (job.status === 'succeeded') return job.items[0]?.editionId ?? 0;
    if (job.status === 'failed') throw new Error('import failed');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('import did not finish');
}

async function saveCover(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, editionId: number, content: Buffer, type: string) {
  const body = multipart([{ name: 'cover', filename: 'cover', content, type }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/editions/${editionId}/cover`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json().edition as { coverTint: { light: string; dark: string } | null };
}

describe('cover tint storage', () => {
  it('stores the tint when a cover is saved and exposes both bands on the edition', async () => {
    const { app, config } = await startApp();
    const { cookie, libraryId } = await setUp(app);
    const editionId = await importBook(app, cookie, libraryId);

    const blue = fixture('blue-baseline.jpg');
    const edition = await saveCover(app, cookie, editionId, blue, 'image/jpeg');
    const expected = coverTintPair(deriveCoverTint(blue, 'image/jpeg'));
    expect(edition.coverTint).toEqual(expected);
    const db = new Database(config.databasePath, { readonly: true });
    const row = db.prepare('SELECT tint FROM covers WHERE edition_id = ?').get(editionId) as { tint: string };
    db.close();
    expect(row.tint).toBe(expected!.light);

    const fetched = await app.inject({ method: 'GET', url: `/api/editions/${editionId}`, headers: { cookie } });
    expect(fetched.json().edition.coverTint).toEqual(expected);

    // A neutral cover stores '' and the page gets no tint.
    const grey = await saveCover(app, cookie, editionId, fixture('grey.jpg'), 'image/jpeg');
    expect(grey.coverTint).toBeNull();
  });

  it('tints a cover taken from the book file at import, and gives a coverless edition none', async () => {
    const { app } = await startApp();
    const { cookie, libraryId } = await setUp(app);
    const bare = await importBook(app, cookie, libraryId, buildTextPdf(), 'text.pdf');
    const fetched = await app.inject({ method: 'GET', url: `/api/editions/${bare}`, headers: { cookie } });
    expect(fetched.json().edition).toMatchObject({ cover: null, coverTint: null });

    const blue = fixture('blue-baseline.jpg');
    const covered = await importBook(
      app,
      cookie,
      libraryId,
      buildEpub({ identifier: 'urn:uuid:5a0f3c1e-2b7d-4e8a-9c6f-0d1e2f3a4b5c', title: 'Blue Book', cover: blue }),
    );
    const edition = await app.inject({ method: 'GET', url: `/api/editions/${covered}`, headers: { cookie } });
    expect(edition.json().edition.coverTint).toEqual(coverTintPair(deriveCoverTint(blue, 'image/jpeg')));
  });

  it('backfills covers stored before tints, at start and on demand, and marks unreadable ones', async () => {
    const first = await startApp();
    const { cookie, libraryId } = await setUp(first.app);
    const blueId = await importBook(first.app, cookie, libraryId);
    await saveCover(first.app, cookie, blueId, fixture('blue-progressive.jpg'), 'image/jpeg');
    await first.app.close();

    // As if stored before the migration.
    const raw = new Database(first.config.databasePath);
    raw.prepare('UPDATE covers SET tint = NULL').run();
    raw.close();

    const second = await startApp(first.dir);
    const after = new Database(first.config.databasePath, { readonly: true });
    const row = after.prepare('SELECT tint, sha256 FROM covers WHERE edition_id = ?').get(blueId) as { tint: string; sha256: string };
    after.close();
    expect(row.tint).toBe(deriveCoverTint(fixture('blue-progressive.jpg'), 'image/jpeg'));
    await second.app.close();

    // A cover whose file has gone is marked, so the backfill does not read it again.
    const opened = openDatabase(first.config.databasePath);
    try {
      opened.sqlite.prepare('UPDATE covers SET tint = NULL').run();
      rmSync(absoluteBlobPath(first.config.dataDir, row.sha256));
      expect(backfillCoverTints(opened.db, first.config.dataDir)).toBe(1);
      const marked = opened.sqlite.prepare('SELECT tint FROM covers WHERE edition_id = ?').get(blueId) as { tint: string };
      expect(marked.tint).toBe('');
      expect(backfillCoverTints(opened.db, first.config.dataDir)).toBe(0);
    } finally {
      opened.sqlite.close();
    }
  });
});
