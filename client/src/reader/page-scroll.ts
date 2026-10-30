import { isTypingTarget, type PageTurn, type ReadingDirection } from './epub/keys';

export type ScrollAxis = 'vertical' | 'horizontal';

interface PageScrollOptions {
  enabled: () => boolean;
  horizontal?: boolean;
  direction?: ReadingDirection;
  canTurn: (turn: PageTurn, target: EventTarget | null, axis: ScrollAxis) => boolean;
  turn: (turn: PageTurn) => void | Promise<unknown>;
  onError?: (error: unknown) => void;
}

type ScrollTarget = HTMLElement | Document;

const WHEEL_THRESHOLD = 60;
const WHEEL_IDLE_MS = 180;
const SWIPE_THRESHOLD = 50;
const CONTROL_SELECTOR = [
  'button', 'a[href]', 'label', 'summary', 'audio', 'video',
  '[role="button"]', '[role="link"]', '[role="slider"]', '[role="textbox"]',
  '[role="combobox"]', '[role="spinbutton"]', '[role="listbox"]', '[role="menuitem"]',
].join(',');

// Event targets can belong to an iframe realm, or be text nodes.
function targetElement(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  return node?.nodeType === 1 ? node as Element : node?.parentElement ?? null;
}

function targetDocument(root: ScrollTarget): Document {
  return root.nodeType === 9 ? root as Document : root.ownerDocument!;
}

function hasSelection(root: ScrollTarget): boolean {
  const selection = targetDocument(root).getSelection();
  return selection !== null && !selection.isCollapsed;
}

function guardedTarget(root: ScrollTarget, target: EventTarget | null, turn: PageTurn, axis: ScrollAxis): boolean {
  const doc = targetDocument(root);
  for (let node = targetElement(target); node; node = node.parentElement) {
    const editable = node.getAttribute('contenteditable');
    if (isTypingTarget(node) || (editable !== null && editable !== 'false') || node.matches(CONTROL_SELECTOR)) {
      return true;
    }

    // The reader decides whether its own scroller is at a page boundary.
    const boundary = root.nodeType === 9
      ? node === doc.scrollingElement || node === doc.body || node === doc.documentElement
      : node === root;
    if (boundary) break;

    const style = doc.defaultView?.getComputedStyle(node);
    const overflow = axis === 'horizontal' ? style?.overflowX : style?.overflowY;
    if (style && /^(auto|scroll|overlay)$/.test(overflow || style.overflow)) {
      const extent = axis === 'horizontal' ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
      const position = axis === 'horizontal'
        ? node.scrollLeft + (style.direction === 'rtl' ? extent : 0)
        : node.scrollTop;
      if (extent > 1 && (turn === 'next' ? extent - position : position) > 1) return true;
    }
  }
  return false;
}

/** A controller shares its burst and in-flight turn across all reader frames. */
export function createPageScroll(options: PageScrollOptions): {
  attach: (target: ScrollTarget) => (() => void);
  destroy: () => void;
} {
  let destroyed = false;
  let busy = false;
  let wheel: { time: number; direction: PageTurn; axis: ScrollAxis; distance: number; turned: boolean } | null = null;
  const attachments = new Map<ScrollTarget, () => void>();
  const seen = new WeakSet<Event>();

  function eligible(root: ScrollTarget, target: EventTarget | null, turn: PageTurn, axis: ScrollAxis): boolean {
    const nativeTurn = axis === 'horizontal' && options.direction === 'rtl' ? (turn === 'next' ? 'prev' : 'next') : turn;
    return !destroyed && options.enabled() && !guardedTarget(root, target, nativeTurn, axis)
      && options.canTurn(turn, target, axis);
  }

  function report(error: unknown): void {
    if (destroyed) return;
    try {
      options.onError?.(error);
    } catch {
      // An error reporter must not introduce an unhandled rejection either.
    }
  }

  function turnPage(turn: PageTurn): void {
    if (destroyed || busy) return;
    busy = true;
    try {
      const result = options.turn(turn);
      void Promise.resolve(result).then(
        () => { if (!destroyed) busy = false; },
        (error: unknown) => {
          if (!destroyed) busy = false;
          report(error);
        },
      );
    } catch (error) {
      busy = false;
      report(error);
    }
  }

  function attach(root: ScrollTarget): () => void {
    if (destroyed) return () => {};
    const existing = attachments.get(root);
    if (existing) return existing;
    let touch: {
      identifier: number;
      x: number;
      y: number;
      target: EventTarget | null;
      allowed: Record<ScrollAxis, { next: boolean; prev: boolean }>;
      axis: ScrollAxis | null;
    } | null = null;

    function first(event: Event): boolean {
      if (destroyed || event.defaultPrevented || seen.has(event)) return false;
      seen.add(event);
      return true;
    }

    function onWheel(event: WheelEvent): void {
      if (!first(event)) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || !Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX)
        || Math.abs(event.deltaY) === Math.abs(event.deltaX)) return;
      const axis: ScrollAxis = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'horizontal' : 'vertical';
      if (axis === 'horizontal' && !options.horizontal) return;
      const delta = axis === 'horizontal' ? event.deltaX : event.deltaY;
      const forward = (delta > 0) !== (axis === 'horizontal' && options.direction === 'rtl');
      const direction = forward ? 'next' : 'prev';
      const now = Date.now();
      if (!wheel || now - wheel.time >= WHEEL_IDLE_MS) {
        wheel = { time: now, direction, axis, distance: 0, turned: false };
      } else if (wheel.direction !== direction || wheel.axis !== axis) {
        wheel.direction = direction;
        wheel.axis = axis;
        wheel.distance = 0;
      }
      wheel.time = now;
      if (!eligible(root, event.target, direction, axis)) {
        wheel.distance = 0;
        return;
      }
      if (event.cancelable) event.preventDefault();
      if (wheel.turned) return;
      const doc = targetDocument(root);
      const dimension = axis === 'horizontal' ? doc.documentElement.clientWidth || doc.defaultView?.innerWidth : doc.documentElement.clientHeight || doc.defaultView?.innerHeight;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? dimension || 800 : 1;
      wheel.distance += Math.abs(delta) * scale;
      if (wheel.distance >= WHEEL_THRESHOLD) {
        // Keep consuming the burst tail even if the turn is still pending.
        wheel.turned = true;
        turnPage(direction);
      }
    }

    function onTouchStart(event: TouchEvent): void {
      if (!first(event)) return;
      touch = null;
      if (event.touches.length !== 1 || hasSelection(root)) return;
      const finger = event.touches[0];
      const allowed = {
        vertical: { next: eligible(root, event.target, 'next', 'vertical'), prev: eligible(root, event.target, 'prev', 'vertical') },
        horizontal: {
          next: Boolean(options.horizontal) && eligible(root, event.target, 'next', 'horizontal'),
          prev: Boolean(options.horizontal) && eligible(root, event.target, 'prev', 'horizontal'),
        },
      };
      if (!allowed.vertical.next && !allowed.vertical.prev && !allowed.horizontal.next && !allowed.horizontal.prev) return;
      touch = {
        identifier: finger.identifier, x: finger.clientX, y: finger.clientY,
        target: event.target, allowed, axis: null,
      };
    }

    function swipe(finger: Touch): { axis: ScrollAxis; turn: PageTurn } | null {
      if (!touch) return null;
      const dx = finger.clientX - touch.x;
      const dy = finger.clientY - touch.y;
      if (Math.abs(dx) === Math.abs(dy)) return null;
      const axis: ScrollAxis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      const delta = axis === 'horizontal' ? dx : dy;
      if (Math.abs(delta) < SWIPE_THRESHOLD || (touch.axis !== null && touch.axis !== axis)
        || (axis === 'horizontal' && !options.horizontal)) return null;
      const forward = (delta < 0) !== (axis === 'horizontal' && options.direction === 'rtl');
      return { axis, turn: forward ? 'next' : 'prev' };
    }

    function onTouchMove(event: TouchEvent): void {
      if (!first(event) || !touch) return;
      const finger = event.touches[0];
      if (event.touches.length !== 1 || finger.identifier !== touch.identifier || hasSelection(root)) {
        touch = null;
        return;
      }
      const dx = finger.clientX - touch.x;
      const dy = finger.clientY - touch.y;
      // Once a gesture chooses horizontal movement, leave it to the browser.
      if (!options.horizontal && Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) >= Math.abs(dy)) {
        touch = null;
        return;
      }
      const gesture = swipe(finger);
      if (!gesture) return;
      touch.axis ??= gesture.axis;
      if (touch.allowed[gesture.axis][gesture.turn] && eligible(root, touch.target, gesture.turn, gesture.axis)) {
        if (event.cancelable) event.preventDefault();
      }
    }

    function onTouchEnd(event: TouchEvent): void {
      if (!first(event) || !touch) return;
      const start = touch;
      const finger = Array.from(event.changedTouches).find((item) => item.identifier === start.identifier);
      const gesture = finger ? swipe(finger) : null;
      touch = null;
      if (event.touches.length || !gesture || !start.allowed[gesture.axis][gesture.turn] || hasSelection(root)
        || !eligible(root, start.target, gesture.turn, gesture.axis)) return;
      if (event.cancelable) event.preventDefault();
      turnPage(gesture.turn);
    }

    function onTouchCancel(): void {
      touch = null;
    }

    // Use local listeners: iframe gestures do not bubble to the parent window.
    const listeners = {
      wheel: onWheel, touchstart: onTouchStart, touchmove: onTouchMove,
      touchend: onTouchEnd, touchcancel: onTouchCancel,
    };
    for (const [name, listener] of Object.entries(listeners)) {
      root.addEventListener(name, listener as EventListener, { passive: false });
    }
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      for (const [name, listener] of Object.entries(listeners)) {
        root.removeEventListener(name, listener as EventListener);
      }
      touch = null;
      attachments.delete(root);
      if (attachments.size === 0) wheel = null;
    };
    attachments.set(root, detach);
    return detach;
  }

  return {
    attach,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const detach of attachments.values()) detach();
      wheel = null;
    },
  };
}
