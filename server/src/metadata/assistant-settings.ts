import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AssistantConfig } from './assistant/client.js';

const SETTINGS_FILE = 'metadata-assistant.json';
const BASE_URL_MAX = 2048;
const MODEL_MAX = 100;
const API_KEY_MAX = 500;

export interface AssistantSettingsInput {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
}

export interface PublicAssistantSettings {
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
}

interface StoredAssistantSettings {
  baseUrl: string;
  model: string;
  apiKey: string | null;
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

export function writeAssistantSettings(
  dataDir: string,
  input: AssistantSettingsInput,
): PublicAssistantSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new AssistantSettingsError();
  const record = input as Record<string, unknown>;
  const baseUrl = cleanBaseUrl(record.baseUrl);
  const model = cleanModel(record.model);
  if (!baseUrl || model === null) throw new AssistantSettingsError();

  const existing = readAssistantSettings(dataDir);
  const apiKey = resolveApiKey(record.apiKey, existing);
  if (apiKey === undefined) throw new AssistantSettingsError();

  const stored: StoredAssistantSettings = {
    baseUrl,
    model,
    apiKey,
    updatedAt: new Date().toISOString(),
  };
  ensurePrivateDir(dataDir);
  writePrivate(path.join(dataDir, SETTINGS_FILE), `${JSON.stringify(stored)}\n`);
  return publicAssistantSettings({ baseUrl, model, apiKey });
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
    };
  }
  const apiKeyConfigured = typeof config.apiKey === 'string' && config.apiKey.length > 0;
  return {
    configured: true,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyConfigured,
    apiKeyHint: apiKeyConfigured ? config.apiKey!.slice(-4) : null,
  };
}

function parseStored(value: unknown): AssistantConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const baseUrl = cleanBaseUrl(record.baseUrl);
  const model = cleanModel(record.model);
  const apiKey = cleanStoredApiKey(record.apiKey);
  if (!baseUrl || model === null || apiKey === undefined) return null;
  return { baseUrl, model, apiKey };
}

function resolveApiKey(value: unknown, existing: AssistantConfig | null): string | null | undefined {
  if (value === undefined) return existing?.apiKey ?? null;
  if (typeof value !== 'string') return undefined;
  const apiKey = value.trim();
  if (apiKey.length === 0) return existing?.apiKey ?? null;
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
