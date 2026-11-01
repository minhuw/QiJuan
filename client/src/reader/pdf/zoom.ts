/** Numeric zoom limits for the reader's controls and gestures. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
const STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale)) * 100) / 100;
}

/** The next preset step in or out from any scale, including a fit mode's computed one. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  if (direction > 0) return STEPS.find((value) => value > scale + 0.01) ?? clampZoom(scale * 1.25);
  return [...STEPS].reverse().find((value) => value < scale - 0.01) ?? clampZoom(scale / 1.25);
}

/**
 * The scale factor of one Ctrl/⌘ + wheel event. Trackpad pinches arrive as small pixel deltas
 * and mouse wheels as large ones or as lines, so both feel proportional.
 */
export function wheelFactor(event: { deltaY: number; deltaMode: number }): number {
  const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
  const bounded = Math.max(-120, Math.min(120, pixels));
  return Math.exp(-bounded * 0.006);
}

/** Keeps a gesture's accumulated factor inside the zoom limits for a starting scale. */
export function boundFactor(base: number, factor: number): number {
  if (!(base > 0)) return 1;
  return Math.min(ZOOM_MAX / base, Math.max(ZOOM_MIN / base, factor));
}

/** Ctrl/⌘ + = / + / - / 0. Null for any other key. */
export function zoomKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): 'in' | 'out' | 'reset' | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.key === '=' || event.key === '+') return 'in';
  if (event.key === '-' || event.key === '_') return 'out';
  if (event.key === '0') return 'reset';
  return null;
}
