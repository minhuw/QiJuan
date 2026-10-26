import type en from './locales/en.json';

export type Catalog = typeof en;

const CHINESE_REGION: Record<string, string> = {
  CN: 'zh-Hans',
  SG: 'zh-Hans',
  MY: 'zh-Hans',
  TW: 'zh-Hant',
  HK: 'zh-Hant',
  MO: 'zh-Hant',
};

const modules = import.meta.glob('./locales/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Catalog>;

export const catalogs: Record<string, Catalog> = {};

for (const [file, catalog] of Object.entries(modules)) {
  const id = file.match(/([^/]+)\.json$/)?.[1];
  if (!id) continue;
  catalogs[id] = catalog;
}

if (!catalogs.en) {
  throw new Error('Missing English catalog: locales/en.json');
}

const englishKeys = leafPaths(catalogs.en).sort();
for (const [id, catalog] of Object.entries(catalogs)) {
  const keys = leafPaths(catalog).sort();
  if (keys.join('\n') !== englishKeys.join('\n')) {
    throw new Error(`Locale ${id} does not match the en catalog keys`);
  }
}

export function localeIds(): string[] {
  return Object.keys(catalogs).sort((a, b) => {
    if (a === 'en') return -1;
    if (b === 'en') return 1;
    return a.localeCompare(b);
  });
}

export function resolveLocale(requested?: string, available: Record<string, Catalog> = catalogs): string {
  const keys = Object.keys(available);
  const fallback = keys.includes('en') ? 'en' : keys[0];
  if (!requested) return fallback ?? 'en';

  const normalized = requested.replace(/_/g, '-');
  if (keys.includes(normalized)) return normalized;

  const parts = normalized.split('-').filter(Boolean);
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join('-');
    if (keys.includes(candidate)) return candidate;
  }

  if (parts[0] === 'zh') {
    const script = parts.find((part) => part === 'Hans' || part === 'Hant');
    const region = parts.find((part) => /^[A-Za-z]{2}$/.test(part) && part !== 'zh');
    const scriptTag = script ? `zh-${script}` : region ? CHINESE_REGION[region.toUpperCase()] : undefined;
    if (scriptTag && keys.includes(scriptTag)) return scriptTag;
    if (keys.includes('zh-Hans')) return 'zh-Hans';
  }

  const primary = parts[0];
  const primaryHits = keys.filter((key) => key === primary || key.startsWith(`${primary}-`));
  if (primaryHits.length === 1) return primaryHits[0] ?? fallback ?? 'en';
  return fallback ?? 'en';
}

export function translate(locale: string, key: string, available: Record<string, Catalog> = catalogs): string {
  const catalog = available[resolveLocale(locale, available)];
  const value = key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in acc) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
  if (typeof value !== 'string') {
    throw new Error(`Missing translation ${locale}:${key}`);
  }
  return value;
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}
