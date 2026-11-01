import { describe, expect, it } from 'vitest';
import { pinyinInitial, sortKey } from '../src/sort-key.js';

describe('sort key', () => {
  it('gives common Chinese characters their pinyin initial', () => {
    expect([...'黑艺邓陈阿中王冯'].map(pinyinInitial).join('')).toBe('hydcazwf');
    expect(pinyinInitial('A')).toBeNull();
  });

  it('files Chinese titles by pinyin and skips a leading bracket', () => {
    expect(sortKey('黑格尔')).toBe('h黑g格e尔');
    expect(sortKey('《精神现象学》')).toMatch(/^j精/);
    expect(sortKey('艺术与视知觉') < sortKey('Zola')).toBe(true);
    expect(sortKey('黑格尔') > sortKey('Hamlet')).toBe(true);
    expect(sortKey('黑格尔') < sortKey('Iliad')).toBe(true);
  });

  it('folds case and accents of Latin titles and keeps digits', () => {
    expect(sortKey('Émile')).toBe('emile');
    expect(sortKey('Quiet Index, A')).toBe('quiet index, a');
    expect(sortKey('1984')).toBe('1984');
  });
});
