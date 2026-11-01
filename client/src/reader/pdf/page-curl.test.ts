import { describe, expect, it, vi } from 'vitest';
import { clipHalfPlane, curlFold, drawCurl, easeTurn, foldReflection, type CurlScene, type Point } from './page-curl';

const page = { x: 300, y: 20, width: 200, height: 300 };

function area(polygon: readonly Point[]): number {
  let sum = 0;
  polygon.forEach((point, index) => {
    const next = polygon[(index + 1) % polygon.length]!;
    sum += point.x * next.y - next.x * point.y;
  });
  return Math.abs(sum) / 2;
}

function reflect(point: Point, matrix: ReturnType<typeof foldReflection>): Point {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

/** A 2D context that records the calls made on it. */
function recorder() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const context = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, name) {
      if (name in target) return target[name];
      const fn = (...args: unknown[]) => {
        calls.push({ name: String(name), args });
        return name === 'createLinearGradient' ? { addColorStop: vi.fn() } : undefined;
      };
      target[name] = fn;
      return fn;
    },
    set(target, name, value) {
      target[name] = value;
      return true;
    },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

describe('page curl geometry', () => {
  it('has no fold before the turn starts, and folds the whole page at the spine when it ends', () => {
    expect(curlFold(page, 0)).toBeNull();
    const done = curlFold(page, 1)!;
    expect(done.corner.x).toBeCloseTo(100);
    expect(done.corner.y).toBeCloseTo(320);
    expect(done.midpoint.x).toBeCloseTo(300);
    expect(done.normal.x).toBeCloseTo(1);
    expect(area(done.flap)).toBeCloseTo(200 * 300);
    expect(area(done.rest)).toBeCloseTo(0);
    // Folded over the spine, the page's free edge lands on the facing side.
    const landed = reflect({ x: 500, y: 20 }, foldReflection(done));
    expect(landed.x).toBeCloseTo(100);
    expect(landed.y).toBeCloseTo(20);
  });

  it('splits the page along the fold, and the lifted corner stays bound to the spine', () => {
    for (const progress of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const fold = curlFold(page, progress)!;
      expect(area(fold.flap) + area(fold.rest)).toBeCloseTo(200 * 300, 3);
      expect(Math.hypot(fold.corner.x - 300, fold.corner.y - 320)).toBeLessThanOrEqual(200 + 1e-9);
      // The corner is the bottom free corner folded across the line.
      const corner = reflect({ x: 500, y: 320 }, foldReflection(fold));
      expect(corner.x).toBeCloseTo(fold.corner.x);
      expect(corner.y).toBeCloseTo(fold.corner.y);
    }
    // Halfway, the corner has lifted off the bottom edge.
    expect(curlFold(page, 0.5)!.corner.y).toBeLessThan(320);
  });

  it('clips a polygon to either side of a line', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const right = clipHalfPlane(square, { x: 4, y: 0 }, { x: 1, y: 0 }, 1);
    const left = clipHalfPlane(square, { x: 4, y: 0 }, { x: 1, y: 0 }, -1);
    expect(area(right)).toBeCloseTo(60);
    expect(area(left)).toBeCloseTo(40);
    expect(clipHalfPlane(square, { x: 20, y: 0 }, { x: 1, y: 0 }, 1)).toEqual([]);
  });

  it('eases in and out', () => {
    expect(easeTurn(0)).toBe(0);
    expect(easeTurn(0.5)).toBeCloseTo(0.5);
    expect(easeTurn(1)).toBe(1);
    expect(easeTurn(0.1)).toBeLessThan(0.1);
    expect(easeTurn(2)).toBe(1);
  });
});

describe('page curl drawing', () => {
  const old = { image: { id: 'old-right' } as unknown as CanvasImageSource, rect: { x: 320, y: 0, width: 192, height: 480 } };
  const facing = { image: { id: 'old-left' } as unknown as CanvasImageSource, rect: { x: 128, y: 0, width: 192, height: 480 } };
  const back = { id: 'new-left' } as unknown as CanvasImageSource;
  const scene = (direction: CurlScene['direction']): CurlScene => ({
    width: 640,
    height: 480,
    direction,
    turning: direction === 'next' ? old : facing,
    still: direction === 'next' ? facing : old,
    back,
    background: 'rgb(240, 236, 228)',
    paper: '#fff',
  });
  const images = (calls: ReturnType<typeof recorder>['calls']) =>
    calls.filter((call) => call.name === 'drawImage').map((call) => (call.args[0] as { id: string }).id);

  it('shows the old spread as it was before the turn moves', () => {
    const { context, calls } = recorder();
    drawCurl(context, scene('next'), 0);
    expect(images(calls)).toEqual(['old-left', 'old-right']);
    // The facing side is covered first, so the new page beneath stays hidden.
    expect(calls.find((call) => call.name === 'fillRect')?.args).toEqual([128, 0, 192, 480]);
  });

  it('draws the flat rest of the turning page, then the next page on the back of the flap', () => {
    const { context, calls } = recorder();
    drawCurl(context, scene('next'), 0.5);
    expect(images(calls)).toEqual(['old-left', 'old-right', 'new-left']);
    expect(calls.some((call) => call.name === 'clip')).toBe(true);
    // Forward turns draw in the page's own frame: no mirror of the whole canvas.
    expect(calls.find((call) => call.name === 'transform')?.args).not.toEqual([-1, 0, 0, 1, 640, 0]);
  });

  it('turns back by mirroring the canvas, with the old left page as the turning sheet', () => {
    const { context, calls } = recorder();
    drawCurl(context, scene('prev'), 0.5);
    expect(calls.find((call) => call.name === 'transform')?.args).toEqual([-1, 0, 0, 1, 640, 0]);
    expect(images(calls)).toEqual(['old-right', 'old-left', 'new-left']);
    // In the mirrored frame the old left page lies right of the spine; its facing slot is at 128.
    expect(calls.find((call) => call.name === 'fillRect')?.args).toEqual([128, 0, 192, 480]);
  });
});
