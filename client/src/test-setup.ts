import '@testing-library/jest-dom/vitest';

// Node 26 ships a global Web Storage that shadows jsdom's and is unusable without
// --localstorage-file; fall back to the jsdom window's storage when it is missing.
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const current = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
  if (typeof current?.removeItem === 'function' || !jsdomWindow) continue;
  Object.defineProperty(globalThis, name, { configurable: true, value: jsdomWindow[name] });
}

// jsdom has no modal dialogs; open and close by attribute so <dialog> components render in tests.
const dialogProto = (globalThis as { HTMLDialogElement?: { prototype: HTMLDialogElement } }).HTMLDialogElement?.prototype;
if (dialogProto && typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  dialogProto.show = dialogProto.showModal;
  dialogProto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
