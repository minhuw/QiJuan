import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface BookTab {
  id: string;
  label: string;
  content: ReactNode;
}

function hashTab(): string {
  return typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1));
}

/**
 * The active tab, mirrored in the URL hash (#details). The hash picks the tab on load and when it
 * changes; a choice replaces the hash in place, so tabs do not pile up in the history. An unknown
 * or hidden tab falls back to the first one.
 */
export function useTabHash(ids: string[]): [string, (id: string) => void] {
  const [wanted, setWanted] = useState(hashTab);
  const key = ids.join(' ');

  useEffect(() => {
    const onHash = () => setWanted(hashTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = useCallback((id: string) => {
    setWanted(id);
    if (hashTab() !== id) window.history.replaceState(window.history.state, '', `#${encodeURIComponent(id)}`);
  }, []);

  const active = key.split(' ').includes(wanted) ? wanted : (ids[0] ?? '');
  return [active, select];
}

/**
 * Whether the shown panel's content is taller than the panel, so it scrolls (on desktop, where the
 * card is capped at the viewport). Checked again whenever the panel or one of its parts resizes,
 * and when parts come or go; only then does the panel get its hairline foot.
 */
function usePanelOverflow(panels: { current: Record<string, HTMLDivElement | null> }, active: string, key: string): boolean {
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const panel = panels.current[active];
    if (!panel) {
      setOverflowing(false);
      return;
    }
    const check = () => setOverflowing(panel.scrollHeight > panel.clientHeight);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const resizes = new ResizeObserver(check);
    const watch = () => {
      resizes.disconnect();
      resizes.observe(panel);
      for (const child of panel.children) resizes.observe(child);
    };
    watch();
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      watch();
      check();
    });
    mutations?.observe(panel, { childList: true });
    return () => {
      resizes.disconnect();
      mutations?.disconnect();
    };
  }, [panels, active, key]);

  return overflowing;
}

/**
 * WAI-ARIA tabs with automatic activation: the arrow keys, Home and End move between the tabs and
 * select as they go, and only the selected tab is in the tab order. Every panel stays mounted (the
 * inactive ones hidden), so forms and disclosures keep their state across switches, and each
 * panel's scroll position is kept for when it comes back.
 */
export function BookTabs({
  idBase,
  label,
  tabs,
  active,
  onSelect,
}: {
  idBase: string;
  label: string;
  tabs: BookTab[];
  active: string;
  onSelect: (id: string) => void;
}) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollTops = useRef<Record<string, number>>({});
  const overflowing = usePanelOverflow(panelRefs, active, tabs.map((tab) => tab.id).join(' '));

  // A shown panel starts where it was left; display: none drops the scroll position otherwise.
  useLayoutEffect(() => {
    const panel = panelRefs.current[active];
    if (panel) panel.scrollTop = scrollTops.current[active] ?? 0;
  }, [active]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === active);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const id = tabs[next]!.id;
    onSelect(id);
    tabRefs.current[id]?.focus();
  }

  return (
    <>
      <div className="book-tablist" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[tab.id] = element;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${tab.id}`}
            className="book-tab"
            aria-selected={tab.id === active}
            aria-controls={`${idBase}-panel-${tab.id}`}
            tabIndex={tab.id === active ? 0 : -1}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          ref={(element) => {
            panelRefs.current[tab.id] = element;
          }}
          role="tabpanel"
          id={`${idBase}-panel-${tab.id}`}
          className={tab.id === active && overflowing ? 'book-tabpanel book-tabpanel-overflow' : 'book-tabpanel'}
          data-tab={tab.id}
          aria-labelledby={`${idBase}-tab-${tab.id}`}
          tabIndex={0}
          hidden={tab.id !== active}
          onScroll={(event) => {
            scrollTops.current[tab.id] = event.currentTarget.scrollTop;
          }}
        >
          {tab.content}
        </div>
      ))}
    </>
  );
}
