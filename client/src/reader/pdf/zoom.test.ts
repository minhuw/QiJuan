import { describe, expect, it } from 'vitest';
import { boundFactor, clampZoom, stepZoom, wheelFactor, zoomKey, ZOOM_MAX, ZOOM_MIN } from './zoom';

describe('pdf zoom', () => {
  it('steps through presets from any scale, including a fit mode’s computed one', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(1.37, 1)).toBe(1.5);
    expect(stepZoom(1.37, -1)).toBe(1.25);
    expect(stepZoom(4, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(0.5, -1)).toBe(ZOOM_MIN);
  });

  it('clamps and rounds a scale, and treats nonsense as 100%', () => {
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(-2)).toBe(1);
  });

  it('turns wheel deltas into a proportional factor, in for up and out for down', () => {
    expect(wheelFactor({ deltaY: -10, deltaMode: 0 })).toBeGreaterThan(1);
    expect(wheelFactor({ deltaY: 10, deltaMode: 0 })).toBeLessThan(1);
    // A mouse notch in lines is bounded like a large pixel delta.
    expect(wheelFactor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(wheelFactor({ deltaY: -48, deltaMode: 0 }));
    expect(wheelFactor({ deltaY: -8, deltaMode: 1 })).toBeCloseTo(wheelFactor({ deltaY: -120, deltaMode: 0 }));
    expect(wheelFactor({ deltaY: -1000, deltaMode: 0 })).toBeCloseTo(wheelFactor({ deltaY: -120, deltaMode: 0 }));
  });

  it('keeps a gesture factor inside the limits for its starting scale', () => {
    expect(boundFactor(2, 5)).toBe(2);
    expect(boundFactor(2, 0.1)).toBe(0.25);
    expect(boundFactor(1, 1.3)).toBe(1.3);
  });

  it('reads Ctrl/⌘ shortcuts only', () => {
    const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
      zoomKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(key('=', { ctrlKey: true })).toBe('in');
    expect(key('+', { metaKey: true })).toBe('in');
    expect(key('-', { ctrlKey: true })).toBe('out');
    expect(key('0', { metaKey: true })).toBe('reset');
    expect(key('=')).toBeNull();
    expect(key('=', { ctrlKey: true, altKey: true })).toBeNull();
    expect(key('ArrowRight', { ctrlKey: true })).toBeNull();
  });
});
