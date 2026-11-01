import { afterEach, describe, expect, it } from 'vitest';
import { readReaderFlow, saveReaderFlow } from '../flow';
import { MIN_SPREAD_WIDTH, renditionOptionsFor, turnsPages } from './settings';

afterEach(() => localStorage.removeItem('qijuan.reader.flow'));

describe('reader flow', () => {
  it('lays out two pages side by side in Two pages mode once the reader is wide enough', () => {
    const size = { width: 1000, height: 700 };
    expect(renditionOptionsFor('spread', size)).toMatchObject({ flow: 'paginated', manager: 'default', spread: 'auto', minSpreadWidth: MIN_SPREAD_WIDTH });
    expect(renditionOptionsFor('paginated', size)).toMatchObject({ flow: 'paginated', manager: 'default', spread: 'none' });
    expect(renditionOptionsFor('continuous', size)).toMatchObject({ flow: 'scrolled', manager: 'continuous', spread: 'none' });
    expect(renditionOptionsFor('spread', size)).toMatchObject({ allowScriptedContent: false, allowPopups: false });
  });

  it('turns pages in both page modes and keeps the chosen mode', () => {
    expect([turnsPages('paginated'), turnsPages('spread'), turnsPages('continuous')]).toEqual([true, true, false]);
    expect(readReaderFlow()).toBe('paginated');
    saveReaderFlow('spread');
    expect(readReaderFlow()).toBe('spread');
    localStorage.setItem('qijuan.reader.flow', 'sideways');
    expect(readReaderFlow()).toBe('paginated');
  });
});
