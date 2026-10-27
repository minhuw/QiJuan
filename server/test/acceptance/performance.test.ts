import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { searchLibrary } from '../../src/library.js';
import { migrate } from '../../src/migrate.js';
import { defaultMigrationsDir } from '../../src/paths.js';
import { makeTempDir } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EDITIONS = 10_000;
const TITLE_QUERY = '山海闲读';
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('catalog performance', () => {
  it('answers a warmed library page and title search from the index in under 2 seconds', () => {
    const temp = makeTempDir();
    cleanups.push(temp.cleanup);
    const databasePath = path.join(temp.dir, 'qijuan.sqlite');
    migrate({ databasePath, migrationsDir: defaultMigrationsDir() });
    const { sqlite, db } = openDatabase(databasePath);
    try {
      sqlite.pragma('synchronous = OFF');
      const seeded = seedCatalog(sqlite);
      const indexed = sqlite.prepare('SELECT count(*) AS total FROM edition_fts').get() as { total: number };
      expect(indexed.total).toBe(EDITIONS);

      const listPlan = planOf(
        sqlite,
        `SELECT e.id FROM editions e
         WHERE e.trashed_at IS NULL AND e.library_id IN (?)
         ORDER BY e.sort_title, e.id
         LIMIT 24 OFFSET 0`,
        [seeded.libraryId],
      );
      const searchPlan = planOf(
        sqlite,
        `SELECT e.id FROM editions e
         WHERE e.trashed_at IS NULL AND e.library_id IN (?)
           AND e.id IN (SELECT rowid FROM edition_fts WHERE edition_fts MATCH ?)
         ORDER BY e.sort_title, e.id
         LIMIT 24 OFFSET 0`,
        [seeded.libraryId, `"${TITLE_QUERY}"`],
      );
      expect(listPlan).toMatch(/editions_library_sort_idx/);
      expect(searchPlan).toMatch(/edition_fts/);

      const query = (q: string | null) =>
        searchLibrary(db, {
          userId: seeded.userId,
          libraryIds: [seeded.libraryId],
          q,
          language: null,
          format: null,
          status: null,
          shelfId: null,
          limit: 24,
          offset: 0,
        });

      const warmedList = query(null);
      const warmedSearch = query(TITLE_QUERY);
      expect(warmedList.total).toBe(EDITIONS);
      expect(warmedList.editions).toHaveLength(24);
      expect(warmedSearch.editions.some((edition) => edition.title === TITLE_QUERY)).toBe(true);

      const listStarted = performance.now();
      const listPage = query(null);
      const listMs = performance.now() - listStarted;
      const searchStarted = performance.now();
      const searchPage = query(TITLE_QUERY);
      const searchMs = performance.now() - searchStarted;

      expect(listPage.total).toBe(EDITIONS);
      expect(searchPage.total).toBeGreaterThan(0);
      expect(listMs).toBeLessThan(2000);
      expect(searchMs).toBeLessThan(2000);

      writePerformanceDoc({
        listMs,
        searchMs,
        listTotal: listPage.total,
        searchTotal: searchPage.total,
        listPlan,
        searchPlan,
      });
    } finally {
      sqlite.close();
    }
  }, 300_000);
});

function seedCatalog(sqlite: ReturnType<typeof openDatabase>['sqlite']): { userId: number; libraryId: number } {
  const now = '2024-06-01T00:00:00.000Z';
  const insert = sqlite.transaction(() => {
    const user = sqlite
      .prepare(
        `INSERT INTO users (username, password_hash, role, created_at)
         VALUES ('perf', 'not-used', 'admin', ?)
         RETURNING id`,
      )
      .get(now) as { id: number };
    const library = sqlite
      .prepare(
        `INSERT INTO libraries (name, mode, root_path, created_at)
         VALUES ('Synthetic', 'managed', ?, ?)
         RETURNING id`,
      )
      .get('libraries/synthetic', now) as { id: number };
    sqlite.prepare('INSERT INTO library_grants (user_id, library_id) VALUES (?, ?)').run(user.id, library.id);

    const insertPerson = sqlite.prepare('INSERT INTO persons (name, sort_name, created_at) VALUES (?, ?, ?)');
    const personIds: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const name = `作者${String(index).padStart(3, '0')}`;
      const person = insertPerson.run(name, name, now);
      personIds.push(Number(person.lastInsertRowid));
    }

    const insertEdition = sqlite.prepare(
      `INSERT INTO editions (
         library_id, title, sort_title, language, publisher, published_date, description,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'zh', '栖卷', '2024', ?, ?, ?)`,
    );
    const insertAuthor = sqlite.prepare(
      `INSERT INTO edition_contributors (edition_id, person_id, role, position, display_name)
       VALUES (?, ?, 'author', 0, ?)`,
    );
    const insertTag = sqlite.prepare('INSERT INTO tags (edition_id, name, created_at) VALUES (?, ?, ?)');
    const tags = ['笔记', '小说', '诗', '史', '札记'];

    for (let n = 1; n <= EDITIONS; n += 1) {
      const title = n === 4242 ? TITLE_QUERY : `性能测试第${String(n).padStart(5, '0')}卷`;
      const authorId = personIds[n % personIds.length] as number;
      const authorName = `作者${String(n % personIds.length).padStart(3, '0')}`;
      const edition = insertEdition.run(library.id, title, title, `合成条目 ${n}`, now, now);
      const editionId = Number(edition.lastInsertRowid);
      insertAuthor.run(editionId, authorId, authorName);
      insertTag.run(editionId, tags[n % tags.length], now);
      insertTag.run(editionId, tags[(n + 2) % tags.length], now);
    }
    return { userId: user.id, libraryId: library.id };
  });
  return insert();
}

function planOf(
  sqlite: ReturnType<typeof openDatabase>['sqlite'],
  sql: string,
  params: Array<string | number>,
): string {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join('\n');
}

function writePerformanceDoc(input: {
  listMs: number;
  searchMs: number;
  listTotal: number;
  searchTotal: number;
  listPlan: string;
  searchPlan: string;
}): void {
  const doc = `# Performance

Measured by \`server/test/acceptance/performance.test.ts\`. That test is not part of \`npm test\`. It inserts the dataset below, warms one call, then times the next call. Both warmed calls must finish in under 2 seconds.

## Dataset

${EDITIONS.toLocaleString('en-US')} synthetic editions in one managed library. Each edition has one author, chosen from 200 author names, and two tags. Titles, authors, and tags are stored in the catalog tables (\`editions\`, \`persons\`, \`edition_contributors\`, and \`tags\`). The inserts use that schema, including the triggers from \`server/migrations/0007_search.sql\` that maintain the FTS5 trigram index \`edition_fts\`. No book file bytes are stored. One title is \`${TITLE_QUERY}\`. The other titles are \`性能测试第NNNNN卷\`.

## Environment

- Node.js: ${process.version}
- CPU architecture (\`process.arch\`): ${process.arch}

## Timings

| Call | Answer | Time |
| --- | --- | --- |
| Warmed first library page (\`searchLibrary\`, no query, limit 24, offset 0) | ${input.listTotal.toLocaleString('en-US')} editions, first page of 24 | ${input.listMs.toFixed(1)} ms |
| Warmed title search for \`${TITLE_QUERY}\` | ${input.searchTotal.toLocaleString('en-US')} hit(s) | ${input.searchMs.toFixed(1)} ms |

Both warmed calls were under 2 seconds.

## Indexed queries

The first page reads the covering index \`editions_library_sort_idx\` (library, trash flag, sort title, id):

\`\`\`
${input.listPlan}
\`\`\`

The title search matches the FTS5 index \`edition_fts\` (trigram), which is the same predicate \`searchLibrary\` uses for a query of three characters or more:

\`\`\`
${input.searchPlan}
\`\`\`
`;
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs/performance.md'), doc);
}
