import { normalizeIsbn } from '../openLibrary.js';
import { safeGet, validateFetchUrl } from '../safe-fetch.js';
import { PAGE_HTML_MAX_BYTES, PAGE_IMAGES_MAX, decodeHtml, extractPageImages } from './page-images.js';
import { REQUEST_TIMEOUT_MS, type AssistantConfig, type WebTransport } from './client.js';

/**
 * QiJuan's own web tools for the metadata agent: DeepSeek Search and Fetch
 * (https://api-docs.deepseek.com/guides/search/) and the Google Books volumes API.
 * Every function returns JSON text for the model and never throws.
 */

export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
export const DEEPSEEK_HOST = 'api.deepseek.com';
export const GOOGLE_BOOKS_ORIGIN = 'https://www.googleapis.com';

/** The documented query limit for DeepSeek Search. */
export const SEARCH_QUERY_MAX = 128;
/** DeepSeek allows 1–50 results; the agent gets at most this many. */
export const SEARCH_MAX_RESULTS = 8;
export const SEARCH_DEFAULT_RESULTS = 8;
export { FETCH_URL_MAX, isPrivateAddress, validateFetchUrl, type FetchUrlCheck } from '../safe-fetch.js';
/** A fetched page, as JSON for the model, is at most this long. */
export const FETCH_PAGE_RESULT_CHARS = 12_000;
export const WEB_SEARCH_RESULT_CHARS = 8_000;
export const GOOGLE_BOOKS_RESULT_CHARS = 8_000;
export const GOOGLE_BOOKS_MAX_RESULTS = 5;
const SEARCH_SUMMARY_CHARS = 500;
const GOOGLE_DESCRIPTION_CHARS = 1_000;
const ERROR_MESSAGE_CHARS = 300;
const RESPONSE_CHARS = 2_000_000;

/** Per-run caps, inside the agent's overall tool call limit. */
export const MAX_WEB_SEARCHES = 4;
export const MAX_PAGE_FETCHES = 4;
export const MAX_GOOGLE_BOOKS_CALLS = 4;
export const MAX_PAGE_IMAGES_CALLS = 4;
export const PAGE_IMAGES_RESULT_CHARS = 8_000;

export const WEB_TOOL_NAMES = ['google_books', 'web_search', 'fetch_page', 'page_images'] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];

export interface WebToolState {
  searches: number;
  fetches: number;
  googleBooks: number;
  pageImages: number;
}

export function newWebToolState(): WebToolState {
  return { searches: 0, fetches: 0, googleBooks: 0, pageImages: 0 };
}

export interface WebToolContext {
  config: AssistantConfig;
  transport: WebTransport;
  state: WebToolState;
}

export function isDeepSeekBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === DEEPSEEK_HOST;
  } catch {
    return false;
  }
}

/** The default web search mode for a base URL: DeepSeek only for a DeepSeek host. */
export function defaultWebSearch(baseUrl: string | null | undefined): 'deepseek' | 'off' {
  return isDeepSeekBaseUrl(baseUrl) ? 'deepseek' : 'off';
}

/**
 * The key for DeepSeek Search and Fetch, or null when web search is off or keyless.
 * The agent's own key is used only when its base URL is DeepSeek, so it is never sent
 * to DeepSeek on behalf of another provider; otherwise the separate search key is required.
 */
export function webSearchKey(config: AssistantConfig): string | null {
  if (config.webSearch !== 'deepseek') return null;
  if (isDeepSeekBaseUrl(config.baseUrl) && config.apiKey) return config.apiKey;
  return config.searchApiKey ? config.searchApiKey : null;
}

export function webSearchAvailable(config: AssistantConfig): boolean {
  return webSearchKey(config) !== null;
}

export async function executeWebTool(name: WebToolName, args: unknown, context: WebToolContext): Promise<string> {
  try {
    const record = asRecord(args);
    if (!record) return errorText('invalid_arguments', 'tool arguments must be a JSON object');
    if (name === 'google_books') return await googleBooks(record, context);
    const key = webSearchKey(context.config);
    if (!key) return errorText('unknown_tool', 'web search is not enabled');
    // page_images fetches the page directly from this server; DeepSeek is not involved.
    if (name === 'page_images') return await pageImages(record, context);
    if (name === 'web_search') return await webSearch(record, key, context);
    return await fetchPage(record, key, context);
  } catch {
    return errorText('tool_failed', `${name} failed`);
  }
}

// --- web_search ---------------------------------------------------------------

async function webSearch(args: Record<string, unknown>, key: string, context: WebToolContext): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.replace(/\s+/g, ' ').trim() : '';
  if (query.length === 0) return errorText('invalid_arguments', 'query must be a non-empty string');
  if ([...query].length > SEARCH_QUERY_MAX) {
    return errorText('invalid_arguments', `query must be at most ${SEARCH_QUERY_MAX} characters`);
  }
  if (args.count !== undefined && args.count !== null && (typeof args.count !== 'number' || !Number.isFinite(args.count))) {
    return errorText('invalid_arguments', 'count must be a number');
  }
  const count =
    typeof args.count === 'number'
      ? Math.min(SEARCH_MAX_RESULTS, Math.max(1, Math.floor(args.count)))
      : SEARCH_DEFAULT_RESULTS;
  if (context.state.searches >= MAX_WEB_SEARCHES) {
    return errorText('limit_reached', `web_search may be used at most ${MAX_WEB_SEARCHES} times per run`);
  }
  context.state.searches += 1;

  const reply = await postDeepSeek(context.transport, '/v1/tools/search', key, { query, count });
  if (!reply.ok) return reply.error;
  const root = asRecord(reply.body);
  const items = Array.isArray(root?.results) ? root.results : null;
  if (!items) return errorText('search_unavailable', 'DeepSeek Search returned an unexpected response');
  const results: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const result = compactSearchResult(asRecord(item));
    if (result) results.push(result);
    if (results.length >= count) break;
  }
  return capList({ query, results }, 'results', WEB_SEARCH_RESULT_CHARS);
}

/** Documented fields: title, url, snippet, summary, content, site_name, site_icon, date, rerank_score, authority. */
function compactSearchResult(item: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!item) return null;
  const url = httpUrl(item.url);
  if (!url) return null;
  const result: Record<string, unknown> = {
    title: cleanText(item.title, 300) ?? '',
    url: url.href,
    host: url.hostname,
  };
  const site = cleanText(item.site_name, 100);
  if (site) result.site = site;
  const date = cleanText(item.date, 40);
  if (date) result.date = date;
  const summary = cleanText(item.summary, SEARCH_SUMMARY_CHARS) ?? cleanText(item.snippet, SEARCH_SUMMARY_CHARS);
  if (summary) result.summary = summary;
  if (typeof item.authority === 'number' && Number.isFinite(item.authority)) result.authority = item.authority;
  return result;
}

// --- fetch_page ---------------------------------------------------------------

async function fetchPage(args: Record<string, unknown>, key: string, context: WebToolContext): Promise<string> {
  const checked = await validateFetchUrl(args.url, context.transport.lookup);
  if (!checked.ok) return errorText('url_rejected', checked.reason);
  if (context.state.fetches >= MAX_PAGE_FETCHES) {
    return errorText('limit_reached', `fetch_page may be used at most ${MAX_PAGE_FETCHES} times per run`);
  }
  context.state.fetches += 1;

  const url = checked.url;
  const reply = await postDeepSeek(context.transport, '/v1/tools/fetch', key, { url: url.href });
  if (!reply.ok) return reply.error;
  const root = asRecord(reply.body);
  if (!root || typeof root.content !== 'string') {
    return errorText('fetch_unavailable', 'DeepSeek Fetch returned an unexpected response');
  }
  const page = {
    url: url.href,
    host: url.hostname,
    title: cleanText(root.title, 300) ?? '',
    content: root.content,
  };
  return capPage(page, FETCH_PAGE_RESULT_CHARS);
}

// --- page_images --------------------------------------------------------------

/**
 * Fetches one page's HTML directly and lists likely cover images: og:image and similar meta
 * tags first, then <img> tags that look like a cover. Costs no DeepSeek call.
 */
async function pageImages(args: Record<string, unknown>, context: WebToolContext): Promise<string> {
  const checked = await validateFetchUrl(args.url, context.transport.lookup);
  if (!checked.ok) return errorText('url_rejected', checked.reason);
  if (context.state.pageImages >= MAX_PAGE_IMAGES_CALLS) {
    return errorText('limit_reached', `page_images may be used at most ${MAX_PAGE_IMAGES_CALLS} times per run`);
  }
  context.state.pageImages += 1;

  const reply = await safeGet(checked.url.href, {
    transport: context.transport,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    maxBytes: PAGE_HTML_MAX_BYTES,
    overflow: 'truncate',
  });
  if (!reply.ok) {
    const code = reply.code === 'url_rejected' || reply.code === 'redirect_rejected' ? 'url_rejected' : `page_${reply.code}`;
    return JSON.stringify(
      reply.status === undefined ? { error: code, detail: reply.detail } : { error: code, status: reply.status, detail: reply.detail },
    );
  }
  const type = (reply.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type && type !== 'text/html' && type !== 'application/xhtml+xml') {
    return errorText('not_html', `the page is ${type}, not HTML`);
  }
  const html = decodeHtml(reply.bytes, reply.contentType);
  const { title, images } = extractPageImages(html, reply.url);
  const output: Record<string, unknown> = { url: reply.url.href, host: reply.url.hostname };
  if (title) output.title = title;
  output.images = images.slice(0, PAGE_IMAGES_MAX);
  if (reply.truncated) output.pageTruncated = true;
  return capList(output, 'images', PAGE_IMAGES_RESULT_CHARS);
}

/** Shortens the page content so the whole JSON result fits within `max` characters. */
export function capPage(
  page: { url: string; host: string; title: string; content: string },
  max: number,
): string {
  const full = JSON.stringify(page);
  if (full.length <= max) return full;
  const candidate = { ...page, content: '', truncated: true };
  const original = page.content;
  let low = 0;
  let high = original.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    candidate.content = original.slice(0, middle);
    if (JSON.stringify(candidate).length <= max) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  candidate.content = original.slice(0, best);
  return JSON.stringify(candidate);
}

// --- DeepSeek transport -------------------------------------------------------

type DeepSeekReply = { ok: true; body: unknown } | { ok: false; error: string };

async function postDeepSeek(
  transport: WebTransport,
  path: '/v1/tools/search' | '/v1/tools/fetch',
  key: string,
  body: Record<string, unknown>,
): Promise<DeepSeekReply> {
  const url = new URL(path, transport.deepseekOrigin ?? DEEPSEEK_ORIGIN);
  const service = path.endsWith('search') ? 'Search' : 'Fetch';
  if (refuseUnstubbed(transport)) return { ok: false, error: errorText('tool_failed', 'network disabled in tests') };
  let response: Response;
  try {
    response = await (transport.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      error: errorText(timeout ? 'timeout' : `${service.toLowerCase()}_unavailable`, `DeepSeek ${service} request failed`),
    };
  }
  const text = await readText(response);
  if (!response.ok) return { ok: false, error: deepSeekError(service, response.status, text) };
  try {
    return { ok: true, body: JSON.parse(text ?? '') as unknown };
  } catch {
    return { ok: false, error: errorText(`${service.toLowerCase()}_unavailable`, `DeepSeek ${service} returned invalid JSON`) };
  }
}

/** Maps the documented status codes; the OpenAI-style `error.message` is added when present. */
function deepSeekError(service: 'Search' | 'Fetch', status: number, text: string | null): string {
  const lower = service.toLowerCase();
  let code: string;
  let detail: string;
  if (status === 400) {
    code = 'invalid_request';
    detail = `DeepSeek ${service} rejected the request`;
  } else if (status === 401) {
    code = 'unauthorized';
    detail = `the DeepSeek API key was rejected; ${lower} is unavailable for this run`;
  } else if (status === 402) {
    code = 'insufficient_balance';
    detail = `the DeepSeek account has insufficient balance; ${lower} is unavailable for this run`;
  } else if (status === 403) {
    code = 'blocked';
    detail = 'DeepSeek Fetch refused this URL by its security policy; try another source';
  } else if (status === 404) {
    code = 'not_found';
    detail = 'DeepSeek Fetch could not retrieve usable content from this URL; try another source';
  } else if (status === 429) {
    code = 'rate_limited';
    detail = `DeepSeek ${service} rate limit exceeded (HTTP 429); try again later or use another tool`;
  } else {
    code = `${lower}_unavailable`;
    detail = `DeepSeek ${service} failed with HTTP ${status}`;
  }
  const message = apiErrorMessage(text);
  return JSON.stringify({ error: code, status, detail: message ? `${detail}: ${message}` : detail });
}

function apiErrorMessage(text: string | null): string | null {
  if (!text) return null;
  try {
    const root = asRecord(JSON.parse(text) as unknown);
    const error = asRecord(root?.error);
    return cleanText(error?.message ?? root?.message, ERROR_MESSAGE_CHARS);
  } catch {
    return null;
  }
}

// --- google_books -------------------------------------------------------------

async function googleBooks(args: Record<string, unknown>, context: WebToolContext): Promise<string> {
  const rawIsbn = typeof args.isbn === 'string' ? args.isbn.trim() : '';
  const rawQuery = typeof args.query === 'string' ? args.query.replace(/\s+/g, ' ').trim() : '';
  let q: string;
  if (rawIsbn) {
    const isbn = normalizeIsbn(rawIsbn);
    if (!isbn) return errorText('invalid_arguments', 'isbn must be an ISBN-10 or ISBN-13');
    q = `isbn:${isbn}`;
  } else if (rawQuery) {
    if (rawQuery.length > 300 || /[\u0000-\u001f\u007f]/.test(rawQuery)) {
      return errorText('invalid_arguments', 'query must be at most 300 characters');
    }
    q = rawQuery;
  } else {
    return errorText('invalid_arguments', 'supply an isbn or a query');
  }
  if (context.state.googleBooks >= MAX_GOOGLE_BOOKS_CALLS) {
    return errorText('limit_reached', `google_books may be used at most ${MAX_GOOGLE_BOOKS_CALLS} times per run`);
  }
  context.state.googleBooks += 1;

  const url = new URL('/books/v1/volumes', context.transport.googleBooksOrigin ?? GOOGLE_BOOKS_ORIGIN);
  url.searchParams.set('q', q);
  url.searchParams.set('maxResults', String(GOOGLE_BOOKS_MAX_RESULTS));
  const apiKey = context.config.googleBooksApiKey;
  if (apiKey) url.searchParams.set('key', apiKey);
  if (refuseUnstubbed(context.transport)) return errorText('tool_failed', 'network disabled in tests');

  let response: Response;
  try {
    response = await (context.transport.fetch ?? globalThis.fetch)(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    return errorText(timeout ? 'timeout' : 'google_books_unavailable', 'Google Books request failed');
  }
  const text = await readText(response);
  if (response.status === 429) {
    return JSON.stringify({
      error: 'rate_limited',
      status: 429,
      detail: apiKey
        ? 'Google Books quota for the configured API key is exhausted (HTTP 429). Do not retry; use other tools.'
        : 'Google Books anonymous shared quota is exhausted (HTTP 429). An admin can add a Google Books API key in Settings. Do not retry; use other tools.',
    });
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return JSON.stringify({
      error: apiKey ? 'unauthorized' : 'google_books_unavailable',
      status: response.status,
      detail: apiKey
        ? `Google Books rejected the request with HTTP ${response.status}; the API key may be invalid or restricted`
        : `Google Books rejected the request with HTTP ${response.status}`,
    });
  }
  if (!response.ok) {
    return JSON.stringify({
      error: 'google_books_unavailable',
      status: response.status,
      detail: `Google Books failed with HTTP ${response.status}`,
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(text ?? '') as unknown;
  } catch {
    return errorText('google_books_unavailable', 'Google Books returned invalid JSON');
  }
  const root = asRecord(body);
  const items = Array.isArray(root?.items) ? root.items : [];
  const volumes = items
    .map((item) => compactVolume(asRecord(item)))
    .filter((volume): volume is Record<string, unknown> => volume !== null)
    .slice(0, GOOGLE_BOOKS_MAX_RESULTS);
  return capList({ volumes }, 'volumes', GOOGLE_BOOKS_RESULT_CHARS);
}

function compactVolume(item: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!item) return null;
  const id = cleanText(item.id, 100);
  const info = asRecord(item.volumeInfo);
  if (!id || !info) return null;
  const volume: Record<string, unknown> = { id };
  const title = cleanText(info.title, 500);
  if (title) volume.title = title;
  const subtitle = cleanText(info.subtitle, 500);
  if (subtitle) volume.subtitle = subtitle;
  const authors = stringList(info.authors, 10, 200);
  if (authors.length > 0) volume.authors = authors;
  const publisher = cleanText(info.publisher, 300);
  if (publisher) volume.publisher = publisher;
  const publishedDate = cleanText(info.publishedDate, 40);
  if (publishedDate) volume.publishedDate = publishedDate;
  const language = cleanText(info.language, 20);
  if (language) volume.language = language;
  const identifiers = Array.isArray(info.industryIdentifiers)
    ? info.industryIdentifiers
        .map(asRecord)
        .flatMap((entry) => {
          const type = cleanText(entry?.type, 40);
          const identifier = cleanText(entry?.identifier, 100);
          return type && identifier ? [{ type, identifier }] : [];
        })
        .slice(0, 5)
    : [];
  if (identifiers.length > 0) volume.industryIdentifiers = identifiers;
  const description = cleanText(info.description, GOOGLE_DESCRIPTION_CHARS);
  if (description) volume.description = description;
  const link = httpUrl(info.canonicalVolumeLink) ?? httpUrl(info.infoLink);
  if (link) volume.link = link.href;
  const image = largestImageLink(info.imageLinks);
  if (image) volume.imageLinks = image;
  return volume;
}

/** Google's sizes, largest first. */
const GOOGLE_IMAGE_SIZES = ['extraLarge', 'large', 'medium', 'small', 'thumbnail', 'smallThumbnail'] as const;

/** The largest image Google lists, as https and without the page-curl effect. */
export function largestImageLink(value: unknown): { size: string; url: string } | null {
  const links = asRecord(value);
  if (!links) return null;
  for (const size of GOOGLE_IMAGE_SIZES) {
    const url = httpUrl(links[size]);
    if (!url) continue;
    if (url.protocol === 'http:') url.protocol = 'https:';
    url.searchParams.delete('edge');
    return { size, url: url.href };
  }
  return null;
}

// --- shared -------------------------------------------------------------------

/** Under Vitest, an unstubbed transport never reaches the network. */
function refuseUnstubbed(transport: WebTransport): boolean {
  return !transport.fetch && Boolean(process.env.VITEST);
}

async function readText(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.length > RESPONSE_CHARS ? null : text;
  } catch {
    return null;
  }
}

/** Drops list entries from the end until the JSON fits; marks the result truncated. */
function capList(output: Record<string, unknown>, key: string, max: number): string {
  if (JSON.stringify(output).length <= max) return JSON.stringify(output);
  const list = [...(output[key] as unknown[])];
  const capped: Record<string, unknown> = { ...output, [key]: list, truncated: true };
  while (list.length > 0 && JSON.stringify(capped).length > max) list.pop();
  return JSON.stringify(capped);
}

function httpUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stringList(value: unknown, count: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, max)).filter((item): item is string => item !== null).slice(0, count);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errorText(error: string, detail: string): string {
  return JSON.stringify({ error, detail });
}
