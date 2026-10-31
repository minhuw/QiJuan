import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AssistantConfig, WebSearchMode } from './assistant/client.js';
import { defaultWebSearch, webSearchAvailable } from './assistant/web-tools.js';

const SETTINGS_FILE = 'metadata-assistant.json';
const BASE_URL_MAX = 2048;
const MODEL_MAX = 100;
const API_KEY_MAX = 500;

/** Body fields accepted by PUT /api/metadata/assistant. */
export const ASSISTANT_SETTINGS_FIELDS = [
  'baseUrl',
  'model',
  'apiKey',
  'webSearch',
  'searchApiKey',
  'googleBooksApiKey',
] as const;

export interface AssistantSettingsInput {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  /** `deepseek` or `off`. Absent keeps the saved choice, or the default for the base URL. */
  webSearch?: unknown;
  /** Absent or blank keeps the saved key; null removes it. */
  searchApiKey?: unknown;
  googleBooksApiKey?: unknown;
}

export interface PublicAssistantSettings {
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
  /** The effective web search mode. */
  webSearch: WebSearchMode;
  /** True when web_search and fetch_page are offered to the agent. */
  webSearchAvailable: boolean;
  searchApiKeyConfigured: boolean;
  searchApiKeyHint: string | null;
  googleBooksApiKeyConfigured: boolean;
  googleBooksApiKeyHint: string | null;
}

interface StoredAssistantSettings {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** Saved only once an admin chooses; otherwise the default follows the base URL. */
  webSearch?: WebSearchMode;
  searchApiKey: string | null;
  googleBooksApiKey: string | null;
  updatedAt: string;
}

/** Invalid input. The message never contains the request body or an API key. */
export class AssistantSettingsError extends Error {
  constructor() {
    super('invalid_request');
    this.name = 'AssistantSettingsError';
  }
}

export function readAssistantSettings(dataDir: string): AssistantConfig | null {
  const stored = readStored(dataDir);
  return stored ? toConfig(stored) : null;
}

function readStored(dataDir: string): Omit<StoredAssistantSettings, 'updatedAt'> | null {
  const file = path.join(dataDir, SETTINGS_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return parseStored(parsed);
}

function toConfig(stored: Omit<StoredAssistantSettings, 'updatedAt'>): AssistantConfig {
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    apiKey: stored.apiKey,
    webSearch: stored.webSearch ?? defaultWebSearch(stored.baseUrl),
    searchApiKey: stored.searchApiKey,
    googleBooksApiKey: stored.googleBooksApiKey,
  };
}

export function writeAssistantSettings(
  dataDir: string,
  input: AssistantSettingsInput,
): PublicAssistantSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new AssistantSettingsError();
  const record = input as Record<string, unknown>;
  const baseUrl = cleanBaseUrl(record.baseUrl);
  const model = cleanModel(record.model);
  if (!baseUrl || model === null) throw new AssistantSettingsError();

  const existing = readStored(dataDir);
  const apiKey = resolveApiKey(record.apiKey, existing ? toConfig(existing) : null);
  if (apiKey === undefined) throw new AssistantSettingsError();
  const webSearch = resolveWebSearch(record.webSearch, existing?.webSearch);
  if (webSearch === null) throw new AssistantSettingsError();
  const searchApiKey = resolveOptionalKey(record.searchApiKey, existing?.searchApiKey ?? null);
  const googleBooksApiKey = resolveOptionalKey(record.googleBooksApiKey, existing?.googleBooksApiKey ?? null);
  if (searchApiKey === undefined || googleBooksApiKey === undefined) throw new AssistantSettingsError();

  const stored: StoredAssistantSettings = {
    baseUrl,
    model,
    apiKey,
    ...(webSearch ? { webSearch } : {}),
    searchApiKey,
    googleBooksApiKey,
    updatedAt: new Date().toISOString(),
  };
  ensurePrivateDir(dataDir);
  writePrivate(path.join(dataDir, SETTINGS_FILE), `${JSON.stringify(stored)}\n`);
  return publicAssistantSettings(toConfig(stored));
}

/** A new explicit choice, the saved one, `undefined` for the default, or null when invalid. */
function resolveWebSearch(value: unknown, existing: WebSearchMode | undefined): WebSearchMode | undefined | null {
  if (value === undefined) return existing;
  return value === 'deepseek' || value === 'off' ? value : null;
}

/** Absent or blank keeps the saved key, null removes it, and a string replaces it. */
function resolveOptionalKey(value: unknown, existing: string | null): string | null | undefined {
  if (value === null) return null;
  return resolveKey(value, existing);
}

/**
 * The target for listing models from unsaved form values. A blank key reuses the saved key only
 * when the base URL is the saved one, so a saved key is never sent to a different server.
 */
export function resolveModelListTarget(
  dataDir: string,
  input: unknown,
): { baseUrl: string; apiKey: string | null } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new AssistantSettingsError();
  const record = input as Record<string, unknown>;
  const baseUrl = cleanBaseUrl(record.baseUrl);
  if (!baseUrl) throw new AssistantSettingsError();
  const existing = readAssistantSettings(dataDir);
  const sameServer = existing !== null && existing.baseUrl === baseUrl ? existing : null;
  const apiKey = resolveApiKey(record.apiKey, sameServer);
  if (apiKey === undefined) throw new AssistantSettingsError();
  return { baseUrl, apiKey };
}

export function cleanAssistantModel(value: unknown): string | null {
  return cleanModel(value);
}

export function clearAssistantSettings(dataDir: string): void {
  rmSync(path.join(dataDir, SETTINGS_FILE), { force: true });
}

export function publicAssistantSettings(config: AssistantConfig | null): PublicAssistantSettings {
  if (!config) {
    return {
      configured: false,
      baseUrl: null,
      model: null,
      apiKeyConfigured: false,
      apiKeyHint: null,
      webSearch: 'off',
      webSearchAvailable: false,
      searchApiKeyConfigured: false,
      searchApiKeyHint: null,
      googleBooksApiKeyConfigured: false,
      googleBooksApiKeyHint: null,
    };
  }
  return {
    configured: true,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyConfigured: keyHint(config.apiKey) !== null,
    apiKeyHint: keyHint(config.apiKey),
    webSearch: config.webSearch ?? defaultWebSearch(config.baseUrl),
    webSearchAvailable: webSearchAvailable({ ...config, webSearch: config.webSearch ?? defaultWebSearch(config.baseUrl) }),
    searchApiKeyConfigured: keyHint(config.searchApiKey) !== null,
    searchApiKeyHint: keyHint(config.searchApiKey),
    googleBooksApiKeyConfigured: keyHint(config.googleBooksApiKey) !== null,
    googleBooksApiKeyHint: keyHint(config.googleBooksApiKey),
  };
}

/** The last four characters of a saved key; the key itself is never returned. */
function keyHint(key: string | null | undefined): string | null {
  return typeof key === 'string' && key.length > 0 ? key.slice(-4) : null;
}

function parseStored(value: unknown): Omit<StoredAssistantSettings, 'updatedAt'> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const baseUrl = cleanBaseUrl(record.baseUrl);
  const model = cleanModel(record.model);
  const apiKey = cleanStoredApiKey(record.apiKey);
  if (!baseUrl || model === null || apiKey === undefined) return null;
  // Fields added later are optional; an unreadable one is treated as absent.
  const webSearch = record.webSearch === 'deepseek' || record.webSearch === 'off' ? record.webSearch : undefined;
  const searchApiKey = cleanStoredApiKey(record.searchApiKey ?? null) ?? null;
  const googleBooksApiKey = cleanStoredApiKey(record.googleBooksApiKey ?? null) ?? null;
  return { baseUrl, model, apiKey, ...(webSearch ? { webSearch } : {}), searchApiKey, googleBooksApiKey };
}

function resolveApiKey(value: unknown, existing: AssistantConfig | null): string | null | undefined {
  return resolveKey(value, existing?.apiKey ?? null);
}

function resolveKey(value: unknown, existing: string | null): string | null | undefined {
  if (value === undefined) return existing;
  if (typeof value !== 'string') return undefined;
  const apiKey = value.trim();
  if (apiKey.length === 0) return existing;
  if (apiKey.length > API_KEY_MAX || /[\u0000-\u001f\u007f]/.test(apiKey)) return undefined;
  return apiKey;
}

function cleanStoredApiKey(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const apiKey = value.trim();
  if (apiKey.length === 0) return null;
  if (apiKey.length > API_KEY_MAX || /[\u0000-\u001f\u007f]/.test(apiKey)) return undefined;
  return apiKey;
}

function cleanBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > BASE_URL_MAX || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const normalized = url.toString().replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : null;
}

function cleanModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (model.length < 1 || model.length > MODEL_MAX || /[\u0000-\u001f\u007f]/.test(model)) return null;
  return model;
}

function ensurePrivateDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

function writePrivate(file: string, body: string): void {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}
