/** Long enough that a burst of page turns is one write, short enough that the last place still arrives. */
export const POSITION_SAVE_DELAY_MS = 300;

export function createDebouncedSave(delayMs: number, save: (locator: string) => void | Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | null = null;

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return {
    push(locator: string) {
      pending = locator;
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        const next = pending;
        pending = null;
        if (next) void save(next);
      }, delayMs);
    },
    flush() {
      clearTimer();
      const next = pending;
      pending = null;
      if (next) void save(next);
    },
  };
}
