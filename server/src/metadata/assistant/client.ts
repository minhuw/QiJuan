import { cleanAssistantModel } from '../assistant-settings.js';

export type WebSearchMode = 'deepseek' | 'off';

export interface AssistantConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** The effective web search mode. Absent means `off`. */
  webSearch?: WebSearchMode;
  /** A separate DeepSeek key for Search and Fetch, used when the base URL is not DeepSeek. */
  searchApiKey?: string | null;
  /** An optional Google Books API key; without it the anonymous quota applies. */
  googleBooksApiKey?: string | null;
}

/** Network access for the web tools. Tests stub both. */
export interface WebTransport {
  fetch?: typeof fetch;
  /** Resolves a host name to its addresses, for the fetch_page private-address check. */
  lookup?: (host: string) => Promise<string[]>;
  /** The DeepSeek Search and Fetch origin. Defaults to https://api.deepseek.com. */
  deepseekOrigin?: string;
  /** The Google Books API origin. Defaults to https://www.googleapis.com. */
  googleBooksOrigin?: string;
}

export interface AssistantTransport {
  fetch?: typeof fetch;
  /** Transport for web_search, fetch_page, and google_books. */
  web?: WebTransport;
}

export type AssistantErrorCode =
  | 'metadata_assistant_unconfigured'
  | 'assistant_unauthorized'
  | 'assistant_invalid_response'
  | 'assistant_models_unsupported'
  | 'assistant_timeout'
  | 'metadata_incomplete'
  | 'metadata_unavailable'
  /** The edition is kept private from the assistant. Nothing was sent. */
  | 'metadata_private';

/** The message is the stable code. It never contains the API key or a request body. */
export class AssistantError extends Error {
  readonly code: AssistantErrorCode;

  constructor(code: AssistantErrorCode) {
    super(code);
    this.name = 'AssistantError';
    this.code = code;
  }
}

const RESPONSE_BYTES = 2 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
const MODELS_RESPONSE_BYTES = 1024 * 1024;
const MODELS_LIMIT = 500;

export function buildChatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

export async function postChatCompletion(
  transport: AssistantTransport,
  config: AssistantConfig,
  body: unknown,
): Promise<unknown> {
  const fetchImpl = transport.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (config.apiKey && config.apiKey.length > 0) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(buildChatUrl(config.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AssistantError('metadata_unavailable');
  }

  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    throw new AssistantError('assistant_unauthorized');
  }
  if (!response.ok) {
    await discardBody(response);
    throw new AssistantError('metadata_unavailable');
  }

  let text: string;
  try {
    text = await readCappedText(response);
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError('metadata_unavailable');
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AssistantError('assistant_invalid_response');
  }
}

export async function testAssistant(
  transport: AssistantTransport,
  config: AssistantConfig,
): Promise<{ model: string }> {
  await postChatCompletion(transport, config, {
    model: config.model,
    messages: [{ role: 'system', content: 'Reply with OK.' }],
    max_tokens: 8,
  });
  return { model: config.model };
}

export function buildModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

/**
 * Lists model ids from `GET <baseUrl>/models`. Accepts the OpenAI shape `{ data: [{ id }] }`
 * and a bare array of `{ id }` objects or strings. Returns sorted, unique ids.
 */
export async function listAssistantModels(
  transport: AssistantTransport,
  target: { baseUrl: string; apiKey: string | null },
): Promise<string[]> {
  const fetchImpl = transport.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (target.apiKey && target.apiKey.length > 0) {
    headers.authorization = `Bearer ${target.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(buildModelsUrl(target.baseUrl), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AssistantError(isTimeout(error) ? 'assistant_timeout' : 'metadata_unavailable');
  }

  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    throw new AssistantError('assistant_unauthorized');
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    await discardBody(response);
    throw new AssistantError('assistant_models_unsupported');
  }
  if (!response.ok) {
    await discardBody(response);
    throw new AssistantError('metadata_unavailable');
  }

  let text: string;
  try {
    text = await readCappedText(response, MODELS_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError(isTimeout(error) ? 'assistant_timeout' : 'metadata_unavailable');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AssistantError('assistant_models_unsupported');
  }
  const ids = modelIds(parsed);
  if (!ids) throw new AssistantError('assistant_models_unsupported');
  return ids;
}

function modelIds(value: unknown): string[] | null {
  let entries: unknown;
  if (Array.isArray(value)) {
    entries = value;
  } else if (typeof value === 'object' && value !== null) {
    entries = (value as Record<string, unknown>).data;
  }
  if (!Array.isArray(entries)) return null;
  const ids = new Set<string>();
  for (const entry of entries) {
    const raw =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>).id
          : null;
    const id = cleanAssistantModel(raw);
    if (id !== null) ids.add(id);
  }
  return [...ids].sort().slice(0, MODELS_LIMIT);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

async function readCappedText(response: Response, limit = RESPONSE_BYTES): Promise<string> {
  const advertised = Number(response.headers?.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) {
    await discardBody(response);
    throw new AssistantError('assistant_invalid_response');
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) {
      throw new AssistantError('assistant_invalid_response');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new AssistantError('assistant_invalid_response');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError('metadata_unavailable');
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status already decided the failure.
  }
}
