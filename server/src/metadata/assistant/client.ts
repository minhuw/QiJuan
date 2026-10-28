export interface AssistantConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

export interface AssistantTransport {
  fetch?: typeof fetch;
}

export type AssistantErrorCode =
  | 'metadata_assistant_unconfigured'
  | 'assistant_unauthorized'
  | 'assistant_invalid_response'
  | 'metadata_incomplete'
  | 'metadata_unavailable';

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
const REQUEST_TIMEOUT_MS = 30_000;

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

async function readCappedText(response: Response): Promise<string> {
  const advertised = Number(response.headers?.get('content-length'));
  if (Number.isFinite(advertised) && advertised > RESPONSE_BYTES) {
    await discardBody(response);
    throw new AssistantError('assistant_invalid_response');
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_BYTES) {
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
      if (total > RESPONSE_BYTES) {
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
