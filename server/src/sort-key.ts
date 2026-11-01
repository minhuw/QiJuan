import { eq } from 'drizzle-orm';
import type { AppDatabase } from './db.js';
import { editions } from './schema.js';

/**
 * The catalogue's sort key: a sort title that orders Chinese and Latin titles together by
 * letter. A Han character becomes its pinyin initial followed by the character itself, so
 * 黑格尔 sorts and files under H, next to Latin titles starting with H. Latin letters lose
 * case and accents. Within one initial, Han characters fall back to code point order.
 *
 * Pinyin initials come from the runtime's ICU pinyin collation (no dictionary is shipped):
 * a character's initial is the last syllable boundary it does not sort before. A character
 * with several readings gets the collation's one (长 → Z, 重 → Z); a hand-set sort title
 * corrects it.
 */

const pinyin = new Intl.Collator('zh-Hans-u-co-pinyin');
/** The first character of each initial in pinyin order. No syllable starts with I, U or V. */
const BOUNDARIES: ReadonlyArray<readonly [string, string]> = [
  ['a', '阿'], ['b', '八'], ['c', '嚓'], ['d', '哒'], ['e', '妸'], ['f', '发'], ['g', '旮'], ['h', '哈'],
  ['j', '丌'], ['k', '咔'], ['l', '垃'], ['m', '妈'], ['n', '拏'], ['o', '噢'], ['p', '妑'], ['q', '七'],
  ['r', '呥'], ['s', '仨'], ['t', '他'], ['w', '屲'], ['x', '夕'], ['y', '丫'], ['z', '帀'],
];
const HAN = /\p{Script=Han}/u;
const cache = new Map<string, string | null>();

/** The lowercase pinyin initial of one Han character, or null when the collation cannot place it. */
export function pinyinInitial(char: string): string | null {
  if (!HAN.test(char)) return null;
  const known = cache.get(char);
  if (known !== undefined) return known;
  let initial: string | null = null;
  for (const [letter, first] of BOUNDARIES) {
    if (pinyin.compare(char, first) >= 0) initial = letter;
    else break;
  }
  if (cache.size > 20_000) cache.clear();
  cache.set(char, initial);
  return initial;
}

/** Leading quotes and brackets (《, “, ") do not decide where a title files. */
export function sortKey(sortTitle: string): string {
  let key = '';
  const body = sortTitle.normalize('NFKD').replace(/^[\p{P}\p{S}\s]+(?=[\p{L}\p{N}])/u, '');
  for (const char of body) {
    if (/\p{Mn}/u.test(char)) continue;
    const initial = pinyinInitial(char);
    key += initial ? `${initial}${char}` : char.toLowerCase();
  }
  return key.trim();
}

/**
 * Fills the sort key of editions stored before it existed (migration 0024 leaves ''). Runs at
 * start; a no-op once done. Returns how many editions changed.
 */
export function backfillSortKeys(db: AppDatabase): number {
  const rows = db.select({ id: editions.id, sortTitle: editions.sortTitle }).from(editions).where(eq(editions.sortKey, '')).all();
  let changed = 0;
  db.transaction((tx) => {
    for (const row of rows) {
      const key = sortKey(row.sortTitle);
      if (!key) continue;
      tx.update(editions).set({ sortKey: key }).where(eq(editions.id, row.id)).run();
      changed += 1;
    }
  });
  return changed;
}
