import '@testing-library/jest-dom/vitest';

// Node 26 ships a global Web Storage that shadows jsdom's and is unusable without
// --localstorage-file; fall back to the jsdom window's storage when it is missing.
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const current = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
  if (typeof current?.removeItem === 'function' || !jsdomWindow) continue;
  Object.defineProperty(globalThis, name, { configurable: true, value: jsdomWindow[name] });
}
