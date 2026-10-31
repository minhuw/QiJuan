import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { writeImmutableBlob } from '../src/blobs.js';
import { openDatabase } from '../src/db.js';
import {
  type FileNameInput,
  FILE_NAME_MAX_BYTES,
  asciiFilename,
  contentDisposition,
  displayFilename,
} from '../src/file-names.js';
import { migrate } from '../src/migrate.js';
import { defaultMigrationsDir } from '../src/paths.js';
import { makeTempDir, tempConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
const password = 'correct-horse-battery';

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function name(overrides: Partial<FileNameInput> = {}): string {
  return displayFilename({
    title: 'A Quiet Index',
    authors: ['Ada Lovelace'],
    publishedDate: '2019-05-01',
    series: null,
    seriesOrder: null,
    format: 'epub',
    originalFilename: 'upload.epub',
    ...overrides,
  });
}

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

describe('display file names', () => {
  it('formats author - title (year).ext for Latin and CJK books', () => {
    expect(name()).toBe('Ada Lovelace - A Quiet Index (2019).epub');
    expect(
      name({
        title: '黑格尔《精神现象学》句读（第一卷）',
        authors: ['邓晓芒'],
        publishedDate: '2014',
        format: 'pdf',
        originalFilename: '黑格尔_精神现象学_句读_ 第一卷 … Anna’s Archive.pdf',
      }),
    ).toBe('邓晓芒 - 黑格尔《精神现象学》句读（第一卷） (2014).pdf');
  });

  it('joins two authors with 、 when either is CJK and with & otherwise', () => {
    expect(name({ authors: ['Ada Lovelace', 'Charles Babbage'] })).toBe(
      'Ada Lovelace & Charles Babbage - A Quiet Index (2019).epub',
    );
    expect(name({ authors: ['邓晓芒', '杨祖陶'] })).toBe('邓晓芒、杨祖陶 - A Quiet Index (2019).epub');
    expect(name({ authors: ['Hegel', '邓晓芒'] })).toBe('Hegel、邓晓芒 - A Quiet Index (2019).epub');
    expect(name({ authors: ['夏目漱石', 'ソウセキ'] })).toContain('夏目漱石、ソウセキ - ');
  });

  it('keeps the first two of three or more authors and marks the rest', () => {
    expect(name({ authors: ['Ada Lovelace', 'Charles Babbage', 'Mary Somerville'] })).toBe(
      'Ada Lovelace & Charles Babbage et al. - A Quiet Index (2019).epub',
    );
    expect(name({ authors: ['甲', '乙', '丙', '丁'] })).toBe('甲、乙等 - A Quiet Index (2019).epub');
  });

  it('drops a missing author, year, or both cleanly', () => {
    expect(name({ authors: [] })).toBe('A Quiet Index (2019).epub');
    expect(name({ authors: ['  ', ''] })).toBe('A Quiet Index (2019).epub');
    expect(name({ publishedDate: null })).toBe('Ada Lovelace - A Quiet Index.epub');
    expect(name({ publishedDate: 'unknown' })).toBe('Ada Lovelace - A Quiet Index.epub');
    expect(name({ authors: [], publishedDate: null })).toBe('A Quiet Index.epub');
  });

  it('takes the year as the first four digits of the published date', () => {
    expect(name({ publishedDate: '2019' })).toContain('(2019).epub');
    expect(name({ publishedDate: '2019-05' })).toContain('(2019).epub');
    expect(name({ publishedDate: 'May 2019' })).toContain('(2019).epub');
  });

  it('adds [series #n] after the title when the edition has a series with an order', () => {
    expect(name({ series: 'Engines', seriesOrder: 2 })).toBe('Ada Lovelace - A Quiet Index [Engines #2] (2019).epub');
    expect(name({ series: 'Engines', seriesOrder: 2.5 })).toContain('[Engines #2.5] (2019)');
    expect(name({ series: 'Engines', seriesOrder: null })).toBe('Ada Lovelace - A Quiet Index (2019).epub');
    expect(name({ series: null, seriesOrder: 3 })).toBe('Ada Lovelace - A Quiet Index (2019).epub');
    // The title already names the series.
    expect(name({ title: 'Quiet Index 3', series: 'Quiet Index', seriesOrder: 3 })).toBe(
      'Ada Lovelace - Quiet Index 3 (2019).epub',
    );
    expect(name({ title: '精神现象学句读（第一卷）', authors: ['邓晓芒'], series: '精神现象学句读', seriesOrder: 1 })).toBe(
      '邓晓芒 - 精神现象学句读（第一卷） (2019).epub',
    );
    expect(name({ authors: [], publishedDate: null, series: 'Engines', seriesOrder: 1 })).toBe(
      'A Quiet Index [Engines #1].epub',
    );
  });

  it('replaces every illegal character and control character', () => {
    expect(name({ title: 'Logic: A Primer' })).toBe('Ada Lovelace - Logic - A Primer (2019).epub');
    expect(name({ title: '精神现象学：导论' })).toContain('精神现象学：导论');
    for (const char of ['/', '\\', '*', '?', '"', '<', '>', '|']) {
      expect(name({ authors: [], publishedDate: null, title: `a${char}b` })).toBe('a_b.epub');
    }
    for (const char of ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085']) {
      expect(name({ authors: [], publishedDate: null, title: `a${char}b` })).toBe('a_b.epub');
    }
    // Tabs and newlines are whitespace and collapse instead.
    expect(name({ authors: [], publishedDate: null, title: 'a\t\n  b' })).toBe('a b.epub');
    expect(name({ authors: ['A/B'], title: 'T?' })).toBe('A_B - T_ (2019).epub');
    expect(name({ series: 'S:1', seriesOrder: 1 })).toContain('[S - 1 #1]');
  });

  it('collapses whitespace and trims trailing dots and spaces', () => {
    expect(name({ authors: [' Ada   Lovelace '], title: '  A   Quiet  Index  ' })).toBe(
      'Ada Lovelace - A Quiet Index (2019).epub',
    );
    expect(name({ authors: [], publishedDate: null, title: 'Notes. . .  ' })).toBe('Notes.epub');
    // Dots inside the name stay.
    expect(name({ authors: ['Ada Jr.'], title: 'Vol. 2' })).toBe('Ada Jr. - Vol. 2 (2019).epub');
  });

  it('keeps the name within 200 UTF-8 bytes by shortening the title at whole characters', () => {
    const title = '精神现象学'.repeat(30);
    const result = name({ title, authors: ['邓晓芒'], publishedDate: '2014', format: 'pdf' });
    expect(bytes(result)).toBeLessThanOrEqual(FILE_NAME_MAX_BYTES);
    expect(result.startsWith('邓晓芒 - 精神现象学')).toBe(true);
    expect(result.endsWith(' (2014).pdf')).toBe(true);
    expect(result).not.toContain('\uFFFD');
    // Whole three-byte characters: 200 - "邓晓芒 - " (12) - " (2014).pdf" (11) leaves 177, so 59 characters.
    expect(result).toBe(`邓晓芒 - ${title.slice(0, 59)} (2014).pdf`);
    expect(bytes(result)).toBe(200);

    const series = name({ title, authors: ['邓晓芒'], series: '句读', seriesOrder: 1, copy: 2 });
    expect(bytes(series)).toBeLessThanOrEqual(FILE_NAME_MAX_BYTES);
    expect(series.endsWith(' [句读 #1] (2019) (2).epub')).toBe(true);

    // Emoji and combining marks are never split.
    const accent = 'e\u0301';
    const family = '👩\u200d👩\u200d👧';
    const graphemes = name({ authors: [], publishedDate: null, title: `${accent}${family}`.repeat(40) });
    expect(bytes(graphemes)).toBeLessThanOrEqual(FILE_NAME_MAX_BYTES);
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(graphemes.replace(/\.epub$/, ''))];
    expect(segments.length).toBeGreaterThan(10);
    expect(segments.every(({ segment }) => segment === accent || segment === family)).toBe(true);

    // A name exactly at the limit stays whole.
    const exact = 'a'.repeat(FILE_NAME_MAX_BYTES - '.epub'.length);
    expect(name({ authors: [], publishedDate: null, title: exact })).toBe(`${exact}.epub`);
  });

  it('shortens the whole name when the authors alone fill the budget, still keeping the extension', () => {
    const result = name({ authors: ['作者'.repeat(60), 'B'] });
    expect(bytes(result)).toBeLessThanOrEqual(FILE_NAME_MAX_BYTES);
    expect(result.endsWith('.epub')).toBe(true);
  });

  it('numbers a second and third file of the same format by asset order', () => {
    expect(name({ copy: 1 })).toBe('Ada Lovelace - A Quiet Index (2019).epub');
    expect(name({ copy: 2 })).toBe('Ada Lovelace - A Quiet Index (2019) (2).epub');
    expect(name({ copy: 3, format: 'pdf' })).toBe('Ada Lovelace - A Quiet Index (2019) (3).pdf');
  });

  it('falls back to the original file name when there is no usable title', () => {
    expect(name({ title: '', originalFilename: 'scan_0001.PDF', format: 'pdf' })).toBe('scan_0001.pdf');
    expect(name({ title: '  ...  ', originalFilename: 'a:b?.epub' })).toBe('a - b_.epub');
    expect(name({ title: null, originalFilename: 'dir/sub/book.epub', copy: 2 })).toBe('book (2).epub');
    expect(name({ title: '', originalFilename: '' })).toBe('book.epub');
    const long = name({ title: '', originalFilename: `${'长'.repeat(100)}.pdf`, format: 'pdf' });
    expect(bytes(long)).toBeLessThanOrEqual(FILE_NAME_MAX_BYTES);
    expect(long.endsWith('长.pdf')).toBe(true);
  });
});

describe('content disposition', () => {
  it('keeps non-ASCII book names out of the raw header', () => {
    const file = '康德《纯粹理性批判》句读（上） - 邓晓芒.pdf';
    const header = contentDisposition(file, 'pdf', 'inline');
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(header).toContain('filename="book.pdf"');
    const encoded = header.split("filename*=UTF-8''")[1] ?? '';
    expect(encoded).toMatch(/^[A-Za-z0-9%._~-]+$/);
    expect(decodeURIComponent(encoded)).toBe(file);
  });

  it('keeps an ASCII name in both forms', () => {
    expect(contentDisposition('scan.pdf', 'pdf', 'inline')).toBe(`inline; filename="scan.pdf"; filename*=UTF-8''scan.pdf`);
    expect(contentDisposition('scan.pdf', 'pdf', 'attachment')).toBe(
      `attachment; filename="scan.pdf"; filename*=UTF-8''scan.pdf`,
    );
  });

  it("percent-encodes RFC 5987 attr-chars such as ' ( ) * ! and spaces", () => {
    const header = contentDisposition("Ada's Index (2019)*!.epub", 'epub', 'attachment');
    expect(header).toContain(`filename*=UTF-8''Ada%27s%20Index%20%282019%29%2A%21.epub`);
  });

  it('builds the ASCII fallback by replacing non-ASCII with _', () => {
    expect(asciiFilename('Ada Lovelace - Café (2019).epub', 'epub')).toBe('Ada Lovelace - Caf_ (2019).epub');
    expect(asciiFilename('邓晓芒 - Hegel (2014).pdf', 'pdf')).toBe('_ - Hegel (2014).pdf');
    expect(asciiFilename('邓晓芒 - 精神现象学 (2014).pdf', 'pdf')).toBe('book.pdf');
    expect(asciiFilename('', 'epub')).toBe('book.epub');
  });
});

async function startApp() {
  const temp = makeTempDir();
  cleanups.push(temp.cleanup);
  const config = tempConfig(temp.dir);
  migrate({ databasePath: config.databasePath, migrationsDir: defaultMigrationsDir() });
  const app = await buildApp({ config, clientDist: null, logger: false });
  cleanups.push(() => {
    void app.close();
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username: 'ada', password, libraryName: 'Home' },
  });
  expect(setup.statusCode).toBe(201);
  const raw = setup.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '';
  return { app, config, cookie, libraryId: setup.json().library.id as number };
}

describe('file routes', () => {
  it('serves the computed name inline for readers and as an attachment for downloads and OPDS', async () => {
    const { app, config, cookie, libraryId } = await startApp();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    const blob = writeImmutableBlob(config.dataDir, pdf);
    const now = '2026-04-03T00:00:00.000Z';
    const sqlite = openDatabase(config.databasePath);
    const editionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, language, created_at, updated_at)
          VALUES (?, 'old', 'old', 'zh-Hans', ?, ?)`,
        )
        .run(libraryId, now, now).lastInsertRowid,
    );
    const insertAsset = sqlite.sqlite.prepare(
      `INSERT INTO file_assets (
        edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
      ) VALUES (?, 'pdf', ?, ?, ?, 'managed', ?, 'present', ?)`,
    );
    const first = Number(
      insertAsset.run(editionId, blob.sha256, blob.bytes, '黑格尔_精神现象学 Anna’s Archive.pdf', blob.relativePath, now)
        .lastInsertRowid,
    );
    const second = Number(
      insertAsset.run(editionId, blob.sha256, blob.bytes, 'scan copy.pdf', blob.relativePath, now).lastInsertRowid,
    );
    sqlite.sqlite.close();

    // Edits flow straight into the name; nothing is stored.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/editions/${editionId}`,
      headers: { cookie },
      payload: { title: '黑格尔《精神现象学》句读（第一卷）', authors: ['邓晓芒'], publishedDate: '2014-01' },
    });
    expect(patched.statusCode).toBe(200);
    const expected = '邓晓芒 - 黑格尔《精神现象学》句读（第一卷） (2014).pdf';
    const encoded = `UTF-8''${encodeURIComponent(expected).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

    const detail = await app.inject({ method: 'GET', url: `/api/editions/${editionId}`, headers: { cookie } });
    const assets = detail.json().edition.assets as Array<{ id: number; originalFilename: string; displayFilename: string }>;
    expect(assets.map((asset) => asset.displayFilename)).toEqual([expected, expected.replace('.pdf', ' (2).pdf')]);
    expect(assets[0]!.originalFilename).toBe('黑格尔_精神现象学 Anna’s Archive.pdf');

    const inline = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${first}/file`,
      headers: { cookie },
    });
    expect(inline.statusCode).toBe(200);
    expect(inline.rawPayload.equals(pdf)).toBe(true);
    expect(inline.headers['content-disposition']).toBe(`inline; filename="book.pdf"; filename*=${encoded}`);

    const download = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${first}/file?download=1`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(pdf)).toBe(true);
    expect(download.headers['content-disposition']).toBe(`attachment; filename="book.pdf"; filename*=${encoded}`);

    // Ranged reads (pdf.js) keep the inline header.
    const ranged = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${second}/file`,
      headers: { cookie, range: 'bytes=0-3' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(String(ranged.headers['content-disposition'])).toMatch(/^inline; /);
    expect(decodeURIComponent(String(ranged.headers['content-disposition']).split("UTF-8''")[1]!)).toBe(
      expected.replace('.pdf', ' (2).pdf'),
    );

    const token = await app.inject({ method: 'POST', url: '/api/opds-tokens', headers: { cookie }, payload: { label: 'e-reader' } });
    expect(token.statusCode).toBe(201);
    const authorization = `Basic ${Buffer.from(`ada:${token.json().secret as string}`, 'utf8').toString('base64')}`;
    const opds = await app.inject({
      method: 'GET',
      url: `/opds/editions/${editionId}/assets/${first}`,
      headers: { authorization },
    });
    expect(opds.statusCode).toBe(200);
    expect(opds.headers['content-disposition']).toBe(`attachment; filename="book.pdf"; filename*=${encoded}`);
  });

  it('uses an ASCII name directly in the plain filename parameter', async () => {
    const { app, config, cookie, libraryId } = await startApp();
    const blob = writeImmutableBlob(config.dataDir, Buffer.from('%PDF-1.4\n%%EOF\n'));
    const now = '2026-04-03T00:00:00.000Z';
    const sqlite = openDatabase(config.databasePath);
    const editionId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO editions (library_id, title, sort_title, published_date, created_at, updated_at)
          VALUES (?, 'A Quiet Index', 'Quiet Index', '2019', ?, ?)`,
        )
        .run(libraryId, now, now).lastInsertRowid,
    );
    const assetId = Number(
      sqlite.sqlite
        .prepare(
          `INSERT INTO file_assets (
            edition_id, format, sha256, bytes, original_filename, storage, relative_path, availability, created_at
          ) VALUES (?, 'pdf', ?, ?, 'x.pdf', 'managed', ?, 'present', ?)`,
        )
        .run(editionId, blob.sha256, blob.bytes, blob.relativePath, now).lastInsertRowid,
    );
    sqlite.sqlite.close();
    const download = await app.inject({
      method: 'GET',
      url: `/api/editions/${editionId}/assets/${assetId}/file?download=1`,
      headers: { cookie },
    });
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="A Quiet Index (2019).pdf"; filename*=UTF-8''A%20Quiet%20Index%20%282019%29.pdf`,
    );
  });
});
