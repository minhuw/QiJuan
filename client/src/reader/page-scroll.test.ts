import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageScroll } from './page-scroll';

const controllers: ReturnType<typeof createPageScroll>[] = [];

function setup(options: Partial<Parameters<typeof createPageScroll>[0]> = {}, root?: HTMLElement | Document) {
  const stage = root ?? document.body.appendChild(document.createElement('div'));
  const turn = vi.fn<Parameters<typeof createPageScroll>[0]['turn']>();
  const canTurn = vi.fn<Parameters<typeof createPageScroll>[0]['canTurn']>(() => true);
  const controller = createPageScroll({ enabled: () => true, canTurn, turn, ...options });
  controllers.push(controller);
  const detach = controller.attach(stage);
  return { stage, turn, canTurn, controller, detach };
}

function wheel(target: EventTarget, deltaY: number, options: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...options });
  target.dispatchEvent(event);
  return event;
}

function finger(x: number, y: number, identifier = 1): Touch {
  return { clientX: x, clientY: y, identifier } as Touch;
}

function touch(target: EventTarget, type: string, touches: Touch[], changedTouches = touches): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
  target.dispatchEvent(event);
  return event as TouchEvent;
}

function swipe(target: EventTarget, startY: number, endY: number, endX = 0) {
  const start = touch(target, 'touchstart', [finger(0, startY)]);
  const move = touch(target, 'touchmove', [finger(endX, endY)]);
  const end = touch(target, 'touchend', [], [finger(endX, endY)]);
  return { start, move, end };
}

function scrollable(element: Element, top = 0) {
  (element as HTMLElement).style.overflowY = 'auto';
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, writable: true, value: top },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.destroy();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  document.body.removeAttribute('style');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('page scroll wheel gestures', () => {
  it('turns down/up once per deliberate gesture and reads the current callbacks', async () => {
    let enabled = true;
    let allowed = true;
    const { stage, turn, canTurn } = setup({ enabled: () => enabled, canTurn: (direction, target, axis) => {
      canTurn(direction, target, axis);
      return allowed;
    } });
    expect(wheel(stage, 90).defaultPrevented).toBe(true);
    expect(turn).toHaveBeenLastCalledWith('next');
    await Promise.resolve();
    vi.advanceTimersByTime(181);
    wheel(stage, -90);
    expect(turn).toHaveBeenLastCalledWith('prev');
    expect(canTurn).toHaveBeenLastCalledWith('prev', stage, 'vertical');
    await Promise.resolve();
    vi.advanceTimersByTime(181);
    enabled = false;
    expect(wheel(stage, 90).defaultPrevented).toBe(false);
    enabled = true;
    allowed = false;
    expect(wheel(stage, 90).defaultPrevented).toBe(false);
    expect(turn).toHaveBeenCalledTimes(2);
  });

  it('accumulates trackpad deltas, consumes the tail, and requires idle before another turn', async () => {
    const { stage, turn } = setup();
    for (let i = 0; i < 5; i++) expect(wheel(stage, 10).defaultPrevented).toBe(true);
    expect(turn).not.toHaveBeenCalled();
    wheel(stage, 10);
    await Promise.resolve();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(40);
      expect(wheel(stage, 12).defaultPrevented).toBe(true);
    }
    expect(turn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(181);
    wheel(stage, 60);
    expect(turn).toHaveBeenCalledTimes(2);
  });

  it('resets small deltas on reversal and idle without unlocking an already turned burst', async () => {
    const { stage, turn } = setup();
    wheel(stage, 40);
    wheel(stage, -30);
    expect(turn).not.toHaveBeenCalled();
    wheel(stage, -30);
    expect(turn).toHaveBeenLastCalledWith('prev');
    await Promise.resolve();
    wheel(stage, 100);
    expect(turn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(181);
    wheel(stage, 40);
    vi.advanceTimersByTime(181);
    wheel(stage, 40);
    expect(turn).toHaveBeenCalledTimes(1);
    wheel(stage, 20);
    expect(turn).toHaveBeenCalledTimes(2);
  });

  it('keeps its burst lock when eligibility changes during the tail', async () => {
    let allowed = true;
    const { stage, turn } = setup({ canTurn: () => allowed });
    wheel(stage, 100);
    await Promise.resolve();
    allowed = false;
    expect(wheel(stage, 80).defaultPrevented).toBe(false);
    allowed = true;
    expect(wheel(stage, 80).defaultPrevented).toBe(true);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { deltaX: 100 }, { deltaX: -90 },
  ])('preserves zoom and horizontal wheels: %j', (options) => {
    const { stage, turn } = setup();
    expect(wheel(stage, 90, options).defaultPrevented).toBe(false);
    expect(turn).not.toHaveBeenCalled();
  });

  it('does not consume zero deltas', () => {
    const { stage, turn } = setup();
    expect(wheel(stage, 0).defaultPrevented).toBe(false);
    expect(turn).not.toHaveBeenCalled();
  });

  it('normalizes line and page deltas', async () => {
    const { stage, turn } = setup();
    wheel(stage, 3, { deltaMode: 1 });
    expect(turn).not.toHaveBeenCalled();
    wheel(stage, 1, { deltaMode: 1 });
    expect(turn).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    vi.advanceTimersByTime(181);
    wheel(stage, -1, { deltaMode: 2 });
    expect(turn).toHaveBeenLastCalledWith('prev');
  });

  it('shares the wheel burst between a stage and multiple iframe documents', async () => {
    const { stage, turn, controller } = setup();
    const frames = [document.createElement('iframe'), document.createElement('iframe')];
    for (const frame of frames) {
      document.body.append(frame);
      controller.attach(frame.contentDocument!);
    }
    wheel(stage, 25);
    wheel(frames[0].contentDocument!.body, 25);
    wheel(frames[1].contentDocument!.body, 25);
    expect(turn).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    wheel(stage, 100);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it('never turns concurrently and recovers after a pending turn and a new idle gesture', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const action = vi.fn().mockReturnValueOnce(pending);
    const { stage } = setup({ turn: action });
    wheel(stage, 90);
    vi.advanceTimersByTime(200);
    expect(wheel(stage, 90).defaultPrevented).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    wheel(stage, 90);
    expect(action).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    wheel(stage, 90);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('reports synchronous and asynchronous failures and unlocks for later gestures', async () => {
    const syncError = new Error('sync');
    const asyncError = new Error('async');
    const action = vi.fn().mockImplementationOnce(() => { throw syncError; })
      .mockImplementationOnce(() => Promise.reject(asyncError));
    const onError = vi.fn();
    const { stage } = setup({ turn: action, onError });
    wheel(stage, 90);
    expect(onError).toHaveBeenLastCalledWith(syncError);
    vi.advanceTimersByTime(200);
    wheel(stage, 90);
    await Promise.resolve();
    expect(onError).toHaveBeenLastCalledWith(asyncError);
    vi.advanceTimersByTime(200);
    wheel(stage, 90);
    expect(action).toHaveBeenCalledTimes(3);
  });

  it('handles rejections without an error callback, and errors thrown by that callback', async () => {
    const { stage, controller } = setup({ turn: () => Promise.reject(new Error('turn')) });
    wheel(stage, 100);
    await Promise.resolve();
    controller.destroy();
    const next = setup({ turn: () => Promise.reject(new Error('turn')), onError: () => { throw new Error('report'); } });
    wheel(next.stage, 100);
    await Promise.resolve();
  });
});

describe('native interactions and scroll boundaries', () => {
  it.each(['input', 'textarea', 'select', 'button', 'a', 'label', 'summary', 'editable', 'role'])(
    'leaves a nested %s control alone', (kind) => {
      const { stage, turn } = setup();
      const control = document.createElement(kind === 'editable' || kind === 'role' ? 'div' : kind);
      if (kind === 'a') control.setAttribute('href', '#');
      if (kind === 'editable') control.setAttribute('contenteditable', 'true');
      if (kind === 'role') control.setAttribute('role', 'slider');
      const child = control.appendChild(document.createElement('span'));
      stage.appendChild(control);
      expect(wheel(child, 100).defaultPrevented).toBe(false);
      const gesture = swipe(child, 100, 0);
      expect(gesture.move.defaultPrevented).toBe(false);
      expect(turn).not.toHaveBeenCalled();
    },
  );

  it('preserves nested scrolling until the relevant edge, excluding the attached root', async () => {
    const { stage, turn } = setup();
    scrollable(stage as Element, 100);
    const inner = stage.appendChild(document.createElement('div'));
    const child = inner.appendChild(document.createElement('span'));
    scrollable(inner, 100);
    expect(wheel(child, 90).defaultPrevented).toBe(false);
    expect(wheel(child, -90).defaultPrevented).toBe(false);
    inner.scrollTop = 800;
    expect(wheel(child, 90).defaultPrevented).toBe(true);
    expect(turn).toHaveBeenLastCalledWith('next');
    await Promise.resolve();
    vi.advanceTimersByTime(200);
    inner.scrollTop = 0;
    wheel(child, -90);
    expect(turn).toHaveBeenLastCalledWith('prev');
  });

  it('excludes body and the document scroller when attached to a document', () => {
    const { turn } = setup({}, document);
    scrollable(document.body, 200);
    scrollable(document.documentElement, 200);
    wheel(document.body, 90);
    expect(turn).toHaveBeenCalledWith('next');
  });

  it('recognizes controls and scrollable blocks from another window realm', () => {
    const { controller, turn } = setup();
    const frame = document.body.appendChild(document.createElement('iframe'));
    const doc = frame.contentDocument!;
    controller.attach(doc);
    const input = doc.body.appendChild(doc.createElement('input'));
    expect(input instanceof HTMLElement).toBe(false);
    expect(wheel(input, 100).defaultPrevented).toBe(false);
    const inner = doc.body.appendChild(doc.createElement('div'));
    scrollable(inner, 100);
    expect(wheel(inner, 100).defaultPrevented).toBe(false);
    inner.scrollTop = 800;
    expect(wheel(inner, 100).defaultPrevented).toBe(true);
    expect(turn).toHaveBeenCalledTimes(1);
  });
});

describe('page scroll touch gestures', () => {
  it('recognizes upward/downward swipes, prevents only recognized moves, and turns once', async () => {
    const { stage, turn } = setup();
    const up = swipe(stage, 120, 50);
    expect(up.start.defaultPrevented).toBe(false);
    expect(up.move.defaultPrevented).toBe(true);
    expect(up.end.defaultPrevented).toBe(true);
    expect(turn).toHaveBeenCalledWith('next');
    touch(stage, 'touchend', [], [finger(0, 50)]);
    expect(turn).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    swipe(stage, 0, 70);
    expect(turn).toHaveBeenLastCalledWith('prev');
  });

  it('leaves taps, short swipes, and horizontal gestures alone', () => {
    const { stage, turn } = setup();
    for (const [y, x] of [[0, 0], [30, 0], [60, 100]]) {
      const gesture = swipe(stage, 0, y, x);
      expect(gesture.start.defaultPrevented).toBe(false);
      expect(gesture.move.defaultPrevented).toBe(false);
      expect(gesture.end.defaultPrevented).toBe(false);
    }
    expect(turn).not.toHaveBeenCalled();
  });

  it('does not reclaim a swipe that first chose horizontal movement', () => {
    const { stage, turn } = setup();
    touch(stage, 'touchstart', [finger(0, 100)]);
    touch(stage, 'touchmove', [finger(90, 100)]);
    expect(touch(stage, 'touchmove', [finger(90, -100)]).defaultPrevented).toBe(false);
    touch(stage, 'touchend', [], [finger(90, -100)]);
    expect(turn).not.toHaveBeenCalled();
  });

  it('requires the requested direction at both touchstart and touchend', () => {
    let allowed = false;
    const { stage, turn } = setup({ canTurn: (direction) => direction === 'prev' || allowed });
    touch(stage, 'touchstart', [finger(0, 100)]);
    allowed = true;
    expect(touch(stage, 'touchmove', [finger(0, 0)]).defaultPrevented).toBe(false);
    touch(stage, 'touchend', [], [finger(0, 0)]);
    expect(turn).not.toHaveBeenCalled();
    touch(stage, 'touchstart', [finger(0, 100)]);
    allowed = false;
    expect(touch(stage, 'touchmove', [finger(0, 0)]).defaultPrevented).toBe(false);
    touch(stage, 'touchend', [], [finger(0, 0)]);
    expect(turn).not.toHaveBeenCalled();
  });

  it('preserves a tall PDF swipe that only reaches its boundary during the gesture', () => {
    const { stage, turn } = setup({ canTurn: () => (stage as HTMLElement).scrollTop >= 800 });
    scrollable(stage as Element, 700);
    touch(stage, 'touchstart', [finger(0, 100)]);
    (stage as HTMLElement).scrollTop = 800;
    expect(touch(stage, 'touchmove', [finger(0, 0)]).defaultPrevented).toBe(false);
    touch(stage, 'touchend', [], [finger(0, 0)]);
    expect(turn).not.toHaveBeenCalled();
    swipe(stage, 100, 0);
    expect(turn).toHaveBeenCalledWith('next');
  });

  it('preserves nested scrolling when that direction was unavailable at the start', () => {
    const { stage, turn } = setup();
    const inner = stage.appendChild(document.createElement('div'));
    scrollable(inner, 700);
    touch(inner, 'touchstart', [finger(0, 100)]);
    inner.scrollTop = 800;
    expect(touch(inner, 'touchmove', [finger(0, 0)]).defaultPrevented).toBe(false);
    touch(inner, 'touchend', [], [finger(0, 0)]);
    expect(turn).not.toHaveBeenCalled();
  });

  it('abandons multitouch, a second finger, changed identifiers, and canceled gestures', () => {
    const { stage, turn } = setup();
    touch(stage, 'touchstart', [finger(0, 100), finger(10, 100, 2)]);
    touch(stage, 'touchend', [], [finger(0, 0)]);
    touch(stage, 'touchstart', [finger(0, 100)]);
    touch(stage, 'touchstart', [finger(0, 100), finger(10, 100, 2)]);
    touch(stage, 'touchmove', [finger(0, 0)]);
    touch(stage, 'touchend', [], [finger(0, 0)]);
    touch(stage, 'touchstart', [finger(0, 100)]);
    touch(stage, 'touchmove', [finger(0, 0, 2)]);
    touch(stage, 'touchend', [], [finger(0, 0, 2)]);
    touch(stage, 'touchstart', [finger(0, 100)]);
    touch(stage, 'touchcancel', []);
    touch(stage, 'touchend', [], [finger(0, 0)]);
    expect(turn).not.toHaveBeenCalled();
  });

  it('preserves text selections present at the start or created during a swipe', () => {
    const { stage, turn } = setup();
    const text = stage.appendChild(document.createTextNode('select these words'));
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection()!;
    selection.addRange(range);
    expect(swipe(stage, 100, 0).move.defaultPrevented).toBe(false);
    selection.removeAllRanges();
    touch(stage, 'touchstart', [finger(0, 100)]);
    selection.addRange(range);
    expect(touch(stage, 'touchmove', [finger(0, 0)]).defaultPrevented).toBe(false);
    selection.removeAllRanges();
    touch(stage, 'touchend', [], [finger(0, 0)]);
    expect(turn).not.toHaveBeenCalled();
  });

  it('checks for selection at touchend even without touchmove', () => {
    const { stage, turn } = setup();
    stage.appendChild(document.createTextNode('selected'));
    touch(stage, 'touchstart', [finger(0, 100)]);
    const range = document.createRange();
    range.selectNodeContents(stage);
    document.getSelection()!.addRange(range);
    expect(touch(stage, 'touchend', [], [finger(0, 0)]).defaultPrevented).toBe(false);
    expect(turn).not.toHaveBeenCalled();
  });

  it('honors enabled changes during a swipe', () => {
    let enabled = true;
    const { stage, turn } = setup({ enabled: () => enabled });
    touch(stage, 'touchstart', [finger(0, 100)]);
    enabled = false;
    expect(touch(stage, 'touchmove', [finger(0, 0)]).defaultPrevented).toBe(false);
    touch(stage, 'touchend', [], [finger(0, 0)]);
    expect(turn).not.toHaveBeenCalled();
  });

  it('shares the asynchronous turn lock with wheel gestures', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const action = vi.fn().mockReturnValueOnce(pending);
    const { stage } = setup({ turn: action });
    wheel(stage, 100);
    swipe(stage, 100, 0);
    expect(action).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    swipe(stage, 100, 0);
    expect(action).toHaveBeenCalledTimes(2);
  });
});

describe('horizontal page turns', () => {
  it.each(['ltr', 'rtl'] as const)('maps horizontal wheels to the %s reading direction', async (direction) => {
    const { stage, turn, canTurn } = setup({ horizontal: true, direction });
    expect(wheel(stage, 0, { deltaX: 90 }).defaultPrevented).toBe(true);
    expect(turn).toHaveBeenLastCalledWith(direction === 'ltr' ? 'next' : 'prev');
    expect(canTurn).toHaveBeenLastCalledWith(direction === 'ltr' ? 'next' : 'prev', stage, 'horizontal');
    await Promise.resolve();
    vi.advanceTimersByTime(200);
    wheel(stage, 0, { deltaX: -90 });
    expect(turn).toHaveBeenLastCalledWith(direction === 'ltr' ? 'prev' : 'next');
  });

  it.each(['ltr', 'rtl'] as const)('maps left and right swipes to the %s reading direction', async (direction) => {
    const { stage, turn } = setup({ horizontal: true, direction });
    swipe(stage, 0, 5, -100);
    expect(turn).toHaveBeenLastCalledWith(direction === 'ltr' ? 'next' : 'prev');
    await Promise.resolve();
    swipe(stage, 0, -5, 100);
    expect(turn).toHaveBeenLastCalledWith(direction === 'ltr' ? 'prev' : 'next');
  });

  it('keeps horizontal panning inside a nested scroller until its edge', () => {
    const { stage, turn } = setup({ horizontal: true });
    const inner = stage.appendChild(document.createElement('div'));
    inner.style.overflowX = 'auto';
    Object.defineProperties(inner, { scrollWidth: { value: 800 }, clientWidth: { value: 200 }, scrollLeft: { writable: true, value: 100 } });
    expect(wheel(inner, 0, { deltaX: 90 }).defaultPrevented).toBe(false);
    expect(turn).not.toHaveBeenCalled();
    inner.scrollLeft = 600;
    expect(wheel(inner, 0, { deltaX: 90 }).defaultPrevented).toBe(true);
    expect(turn).toHaveBeenCalledWith('next');
  });

  it('shares the burst lock between axes and leaves horizontal input native when disabled', async () => {
    const { stage, turn } = setup({ horizontal: true });
    wheel(stage, 90);
    await Promise.resolve();
    wheel(stage, 0, { deltaX: 90 });
    expect(turn).toHaveBeenCalledTimes(1);
    const native = setup();
    expect(wheel(native.stage, 0, { deltaX: 90 }).defaultPrevented).toBe(false);
    expect(native.turn).not.toHaveBeenCalled();
  });
});

describe('page scroll cleanup', () => {
  it('detaches idempotently, clears gesture state, and can reattach', () => {
    const { stage, turn, controller, detach } = setup();
    wheel(stage, 40);
    touch(stage, 'touchstart', [finger(0, 100)]);
    detach();
    detach();
    expect(wheel(stage, 100).defaultPrevented).toBe(false);
    controller.attach(stage);
    touch(stage, 'touchend', [], [finger(0, 0)]);
    wheel(stage, 30);
    expect(turn).not.toHaveBeenCalled();
    wheel(stage, 30);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it('removes every attachment and ignores late failures and later attaches after destroy', async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const onError = vi.fn();
    const { stage, controller, detach } = setup({ turn: () => pending, onError });
    const frame = document.body.appendChild(document.createElement('iframe'));
    controller.attach(frame.contentDocument!);
    wheel(stage, 100);
    controller.destroy();
    controller.destroy();
    detach();
    controller.attach(stage)();
    expect(wheel(stage, 100).defaultPrevented).toBe(false);
    expect(wheel(frame.contentDocument!.body, 100).defaultPrevented).toBe(false);
    reject(new Error('late failure'));
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });
});
