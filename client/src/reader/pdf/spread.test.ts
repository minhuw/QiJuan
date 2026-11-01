import { describe, expect, it } from 'vitest';
import { spreadIndex, spreadOf, spreadPages, spreadTurn, spreadTurnTarget } from './spread';

describe('two-page spreads', () => {
  it('sets the cover alone on the right, then pairs pages left and right', () => {
    expect(spreadOf(1, 10)).toEqual({ left: null, right: 1 });
    expect(spreadOf(2, 10)).toEqual({ left: 2, right: 3 });
    expect(spreadOf(3, 10)).toEqual({ left: 2, right: 3 });
    expect(spreadOf(9, 10)).toEqual({ left: 8, right: 9 });
    // An even last page stands alone on the left; an odd one completes its pair.
    expect(spreadOf(10, 10)).toEqual({ left: 10, right: null });
    expect(spreadOf(9, 9)).toEqual({ left: 8, right: 9 });
    expect(spreadOf(1, 1)).toEqual({ left: null, right: 1 });
    expect(spreadOf(1, 0)).toEqual({ left: null, right: null });
    // Out-of-range pages clamp into the book.
    expect(spreadOf(99, 10)).toEqual({ left: 10, right: null });
    expect(spreadOf(-3, 10)).toEqual({ left: null, right: 1 });
    expect(spreadPages(5, 10)).toEqual([4, 5]);
    expect(spreadPages(1, 10)).toEqual([1]);
  });

  it('turns a whole spread at a time and stops at either end', () => {
    expect(spreadTurnTarget(1, 10, 'next')).toBe(2);
    expect(spreadTurnTarget(2, 10, 'next')).toBe(4);
    expect(spreadTurnTarget(3, 10, 'next')).toBe(4);
    expect(spreadTurnTarget(9, 10, 'next')).toBe(10);
    expect(spreadTurnTarget(10, 10, 'next')).toBeNull();
    expect(spreadTurnTarget(9, 9, 'next')).toBeNull();
    expect(spreadTurnTarget(4, 10, 'prev')).toBe(3);
    expect(spreadTurnTarget(2, 10, 'prev')).toBe(1);
    expect(spreadTurnTarget(1, 10, 'prev')).toBeNull();
    expect(spreadTurnTarget(1, 0, 'next')).toBeNull();
  });

  it('tells a turn to the next or previous spread from a jump', () => {
    expect([1, 2, 3, 4, 5].map(spreadIndex)).toEqual([0, 1, 1, 2, 2]);
    expect(spreadTurn(1, 2)).toBe('next');
    expect(spreadTurn(3, 4)).toBe('next');
    expect(spreadTurn(4, 3)).toBe('prev');
    expect(spreadTurn(2, 1)).toBe('prev');
    expect(spreadTurn(2, 3)).toBeNull();
    expect(spreadTurn(2, 10)).toBeNull();
  });
});
