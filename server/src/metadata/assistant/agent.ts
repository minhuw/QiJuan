import {
  AssistantError,
  postChatCompletion,
  type AssistantConfig,
  type AssistantTransport,
} from './client.js';
import { agentToolDefinitions, executeTool } from './tools.js';
import {
  WEB_TOOL_NAMES,
  executeWebTool,
  newWebToolState,
  webSearchAvailable,
  type WebToolName,
} from './web-tools.js';
import type { OpenLibraryTransport } from '../openLibrary.js';
import { buildSystemPrompt, buildUserMessage, type MetadataPromptInput } from './prompt.js';
import { validateSubmission, type AssistantProposal } from './submit.js';
import type { DroppedIdentifier } from '../../identifiers.js';
import { assertNotPrivate } from '../privacy.js';

/** Model requests per run, the closing wrap-up turns included. */
export const MAX_MODEL_TURNS = 8;
/** The last turns of a run offer only submit_metadata, so a run that researched always gets to answer. */
export const WRAP_UP_TURNS = 2;
/** Research tool calls per run; submit_metadata is not counted. Each web tool also has its own cap in web-tools.ts. */
export const MAX_TOOL_CALLS = 10;
/** Rejected submissions the model may correct before the run fails. */
export const MAX_SUBMIT_ATTEMPTS = 3;
const WRAP_UP_MESSAGE =
  'The research budget is used up. Call submit_metadata now with the metadata your research supports. Omit identifiers and the cover when you are not confident; do not invent values.';
/** Wall-clock budget for one run. Each HTTP request also has its own 30 s timeout. */
export const TOTAL_BUDGET_MS = 150_000;
export const MAX_TOOL_ARGUMENT_CHARS = 120_000;
export const MAX_TOOL_RESULT_CHARS = 12_000;

/** Descriptive aliases for callers that prefer budget-oriented names. */
export const AGENT_MAX_TURNS = MAX_MODEL_TURNS;
export const AGENT_MAX_TOOL_CALLS = MAX_TOOL_CALLS;
export const AGENT_TIMEOUT_MS = TOTAL_BUDGET_MS;

/** Model text, tool arguments, and tool results are shortened to this many characters in a step. */
export const STEP_TEXT_CHARS = 12_000;

export interface RunMetadataAgentOptions {
  transport: AssistantTransport;
  openLibrary: OpenLibraryTransport;
  config: AssistantConfig;
  input: MetadataPromptInput;
  /**
   * Whether the book is kept private from the assistant. Required so every caller states it;
   * anything but an explicit `false` stops the run before a request is made.
   */
  metadataPrivate: boolean;
  /** Observes each step as it happens. Errors thrown here never affect the run. */
  onStep?: (step: AgentStep) => void;
}

export type AgentOutcome = 'accepted' | 'failed' | 'timeout' | 'limit';

export interface ToolResultSummary {
  /** Search results returned. */
  count?: number;
  /** The record key, or the first search result's key. */
  key?: string;
  /** The record title, or the first search result's title. */
  title?: string;
  /** fetch_page and page_images: the page host and URL. */
  host?: string;
  url?: string;
  /** A short explanation for an error, e.g. a quota message. */
  detail?: string;
  /** The tool error code, when the tool refused or failed. */
  error?: string;
  truncated?: boolean;
}

export type AgentStepBody =
  | {
      kind: 'input';
      /** A short name for the fixed system prompt. The prompt text itself is not repeated. */
      prompt: 'metadata-assistant';
      model: string;
      /** Exactly the user message the model received: filename, format, and whitelisted fields. */
      input: unknown;
      limits: { turns: number; toolCalls: number; ms: number };
      /** The tool names offered on this run. */
      tools?: string[];
    }
  | { kind: 'model'; turn: number; text: string | null; toolCalls: string[]; durationMs: number }
  | {
      kind: 'tool_call';
      turn: number;
      callId: string;
      name: string;
      args: unknown;
      /** The raw argument text, only when it was not valid JSON or was too long to keep parsed. */
      argsText?: string;
    }
  | {
      kind: 'tool_result';
      callId: string;
      name: string;
      summary: ToolResultSummary;
      result: string;
      truncated: boolean;
      durationMs: number;
    }
  | {
      kind: 'submit';
      turn: number;
      callId: string;
      accepted: boolean;
      proposal?: AssistantProposal;
      missing?: string[];
      error?: string;
      args?: unknown;
      argsText?: string;
    }
  | {
      /** Something the pipeline did with the run's data, e.g. an identifier dropped as invalid. */
      kind: 'note';
      message: string;
      dropped?: DroppedIdentifier[];
      researchCalls?: number;
    }
  | {
      kind: 'end';
      outcome: AgentOutcome;
      error: string | null;
      reason: string | null;
      turns: number;
      toolCalls: number;
      totalMs: number;
    };

export type AgentStepKind = AgentStepBody['kind'];
export type AgentStep = AgentStepBody & { seq: number; at: string };

export interface MetadataAgentResult {
  proposal: AssistantProposal;
  model: string;
  toolCalls: number;
  turns: number;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

class DeadlineExceeded extends Error {
  constructor() {
    super('deadline');
    this.name = 'DeadlineExceeded';
  }
}

interface LoopState {
  turns: number;
  toolCalls: number;
}

export async function runMetadataAgent(options: RunMetadataAgentOptions): Promise<MetadataAgentResult> {
  // The last guard before the model, its web tools and page images: nothing about a private book is sent.
  assertNotPrivate(options.metadataPrivate);
  const started = Date.now();
  const state: LoopState = { turns: 0, toolCalls: 0 };
  let seq = 0;
  const emit = (body: AgentStepBody): void => {
    if (!options.onStep) return;
    seq += 1;
    try {
      options.onStep({ ...body, seq, at: new Date().toISOString() } as AgentStep);
    } catch {
      // Recording is best effort. The run continues without it.
    }
  };
  try {
    const result = await runLoop(options, state, emit);
    emit(endStep('accepted', null, null, state, started));
    return result;
  } catch (error) {
    const outcome = error instanceof AssistantError ? outcomeOf(error) : 'failed';
    const code = error instanceof AssistantError ? error.code : 'internal';
    const reason = error instanceof AssistantError ? reasonOf(error) : null;
    emit(endStep(outcome, code, reason, state, started));
    throw error;
  }
}

async function runLoop(
  options: RunMetadataAgentOptions,
  state: LoopState,
  emit: (body: AgentStepBody) => void,
): Promise<MetadataAgentResult> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const tools = agentToolDefinitions({ webSearch: webSearchAvailable(options.config) });
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  const submitOnly = tools.filter((tool) => tool.function.name === 'submit_metadata');
  const webState = newWebToolState();
  // Research calls are budgeted; submit_metadata is not, so the model can always answer with what it found.
  let research = 0;
  let submits = 0;
  let forceWrapUp = false;
  let wrapUpSent = false;
  const userMessage = buildUserMessage(options.input);
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userMessage },
  ];
  emit({
    kind: 'input',
    prompt: 'metadata-assistant',
    model: options.config.model,
    input: JSON.parse(userMessage) as unknown,
    limits: { turns: MAX_MODEL_TURNS, toolCalls: MAX_TOOL_CALLS, ms: TOTAL_BUDGET_MS },
    tools: [...toolNames],
  });
  while (state.turns < MAX_MODEL_TURNS) {
    if (Date.now() >= deadline) throw incomplete('time budget exhausted without submit_metadata', 'timeout');
    state.turns += 1;
    const turn = state.turns;
    const wrapUp = forceWrapUp || turn >= MAX_MODEL_TURNS - WRAP_UP_TURNS + 1 || research >= MAX_TOOL_CALLS;
    if (wrapUp && !wrapUpSent) {
      wrapUpSent = true;
      messages.push({ role: 'user', content: WRAP_UP_MESSAGE });
      emit({ kind: 'note', message: 'wrap_up', researchCalls: research });
    }

    let response: unknown;
    const requested = Date.now();
    try {
      response = await beforeDeadline(
        postChatCompletion(options.transport, options.config, {
          model: options.config.model,
          messages,
          tools: wrapUp ? submitOnly : tools,
          // Reasoning models (e.g. DeepSeek thinking mode) reject a forced tool_choice, so wrap-up offers only submit_metadata.
          tool_choice: 'auto',
          temperature: 0.2,
          stream: false,
        }),
        deadline,
      );
    } catch (error) {
      if (error instanceof DeadlineExceeded || Date.now() >= deadline) {
        throw incomplete('time budget exhausted without submit_metadata', 'timeout');
      }
      throw error;
    }
    const modelMs = Date.now() - requested;

    if (Date.now() >= deadline) throw incomplete('time budget exhausted without submit_metadata', 'timeout');
    const assistant = assistantMessage(response);
    if (!assistant) throw new AssistantError('assistant_invalid_response');

    const calls = toolCallsFrom(assistant.tool_calls, state.toolCalls);
    const text = typeof assistant.content === 'string' ? assistant.content.trim() : '';
    emit({
      kind: 'model',
      turn,
      text: text.length > 0 ? capText(text, STEP_TEXT_CHARS) : null,
      toolCalls: calls.map((call) => call.function.name),
      durationMs: modelMs,
    });
    if (calls.length === 0) {
      if (turn >= MAX_MODEL_TURNS) throw incomplete('model turn limit reached without submit_metadata', 'limit');
      // A reply without tool calls ends the research; ask for the submission next.
      if (text.length > 0) messages.push({ role: 'assistant', content: assistant.content });
      if (wrapUp) messages.push({ role: 'user', content: WRAP_UP_MESSAGE });
      forceWrapUp = true;
      continue;
    }

    messages.push({
      role: 'assistant',
      content: typeof assistant.content === 'string' ? assistant.content : null,
      tool_calls: calls.map((call) => ({
        ...call,
        function: {
          ...call.function,
          arguments: capText(call.function.arguments, MAX_TOOL_ARGUMENT_CHARS),
        },
      })),
    });

    for (const call of calls) {
      state.toolCalls += 1;

      const name = call.function.name;
      if (name === 'submit_metadata') {
        submits += 1;
        if (submits > MAX_SUBMIT_ATTEMPTS) throw incomplete('submit_metadata was rejected too many times', 'limit');
      } else {
        research += 1;
      }
      const rawArguments = call.function.arguments;
      let parsed: unknown;
      let argumentError: string | null = null;
      if (rawArguments.length > MAX_TOOL_ARGUMENT_CHARS) {
        argumentError = 'tool arguments are too large';
      } else {
        try {
          parsed = rawArguments.length === 0 ? {} : (JSON.parse(rawArguments) as unknown);
        } catch {
          argumentError = 'tool arguments must be valid JSON';
        }
      }
      const recordedArgs = recordArguments(parsed, rawArguments, argumentError !== null);

      if (name === 'submit_metadata') {
        if (argumentError !== null) {
          emit({ kind: 'submit', turn, callId: call.id, accepted: false, error: 'invalid_arguments', ...recordedArgs });
          messages.push(toolMessage(call.id, errorContent('invalid_arguments', argumentError)));
          continue;
        }
        const submission = validateSubmission(parsed);
        if (submission.ok) {
          emit({ kind: 'submit', turn, callId: call.id, accepted: true, proposal: submission.proposal });
          if (submission.dropped.length > 0) {
            emit({ kind: 'note', message: 'identifiers_dropped', dropped: submission.dropped });
          }
          return {
            proposal: submission.proposal,
            model: options.config.model,
            toolCalls: state.toolCalls,
            turns: state.turns,
          };
        }
        emit({
          kind: 'submit',
          turn,
          callId: call.id,
          accepted: false,
          error: 'metadata_incomplete',
          missing: submission.missing,
          ...recordedArgs,
        });
        messages.push(
          toolMessage(
            call.id,
            errorContent(
              'metadata_incomplete',
              `missing or invalid fields: ${submission.missing.join(', ')}`,
            ),
          ),
        );
        continue;
      }

      emit({ kind: 'tool_call', turn, callId: call.id, name, args: recordedArgs.args ?? null, ...recordedArgs });
      const toolStarted = Date.now();
      const reply = (content: string): void => {
        emit(toolResultStep(call.id, name, content, Date.now() - toolStarted));
        messages.push(toolMessage(call.id, content));
      };

      if (research > MAX_TOOL_CALLS) {
        reply(errorContent('budget_exhausted', 'the research budget is used up; call submit_metadata now'));
        continue;
      }

      if (argumentError !== null) {
        reply(errorContent('invalid_arguments', argumentError));
        continue;
      }

      if (!toolNames.has(name)) {
        reply(errorContent('unknown_tool', `the only tools are ${[...toolNames].join(', ')}`));
        continue;
      }

      let content: string;
      try {
        content = await beforeDeadline(
          isWebToolName(name)
            ? executeWebTool(name, parsed, {
                config: options.config,
                transport: options.transport.web ?? {},
                state: webState,
              })
            : executeTool(name, parsed, { openLibrary: options.openLibrary, origin: options.openLibrary.origin }),
          deadline,
        );
      } catch (error) {
        if (error instanceof DeadlineExceeded || Date.now() >= deadline) {
          throw incomplete('time budget exhausted without submit_metadata', 'timeout');
        }
        content = errorContent('metadata_unavailable', `${name} request failed`);
      }
      if (Date.now() >= deadline) {
        emit(toolResultStep(call.id, name, content, Date.now() - toolStarted));
        throw incomplete('time budget exhausted without submit_metadata', 'timeout');
      }
      reply(content);
    }

  }

  throw incomplete('model turn limit reached without submit_metadata', 'limit');
}

/** Keeps parsed arguments when they are small; otherwise only a shortened copy of the text. */
function recordArguments(
  parsed: unknown,
  raw: string,
  invalid: boolean,
): { args?: unknown; argsText?: string } {
  if (invalid || raw.length > STEP_TEXT_CHARS) return { argsText: capText(raw, STEP_TEXT_CHARS) };
  return { args: parsed };
}

function toolResultStep(callId: string, name: string, content: string, durationMs: number): AgentStepBody {
  return {
    kind: 'tool_result',
    callId,
    name,
    summary: summarizeToolResult(name, content),
    result: capText(content, STEP_TEXT_CHARS),
    truncated: content.length > STEP_TEXT_CHARS,
    durationMs,
  };
}

/** A one-line description of a tool result: a count, a record key and title, or an error code. */
export function summarizeToolResult(name: string, content: string): ToolResultSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return {};
  }
  const record = asRecord(parsed);
  if (!record) return {};
  const summary: ToolResultSummary = {};
  if (typeof record.error === 'string') {
    return typeof record.detail === 'string'
      ? { error: record.error, detail: capText(record.detail, 300) }
      : { error: record.error };
  }
  if (record.truncated === true) summary.truncated = true;
  if (name === 'web_search' || name === 'google_books') {
    const items = name === 'web_search' ? record.results : record.volumes;
    const list = Array.isArray(items) ? items : [];
    summary.count = list.length;
    const first = asRecord(list[0]);
    if (name === 'google_books' && typeof first?.id === 'string') summary.key = first.id;
    if (typeof first?.title === 'string') summary.title = capText(first.title, 200);
    return summary;
  }
  if (name === 'page_images') {
    summary.count = Array.isArray(record.images) ? record.images.length : 0;
    if (typeof record.title === 'string' && record.title.length > 0) summary.title = capText(record.title, 200);
    if (typeof record.host === 'string') summary.host = record.host;
    if (typeof record.url === 'string') summary.url = capText(record.url, 2000);
    return summary;
  }
  if (name === 'fetch_page') {
    if (typeof record.title === 'string' && record.title.length > 0) summary.title = capText(record.title, 200);
    if (typeof record.host === 'string') summary.host = record.host;
    if (typeof record.url === 'string') summary.url = capText(record.url, 2000);
    return summary;
  }
  if (name === 'search_open_library') {
    const results = Array.isArray(record.results) ? record.results : [];
    summary.count = results.length;
    const first = asRecord(results[0]);
    if (typeof first?.key === 'string') summary.key = first.key;
    if (typeof first?.title === 'string') summary.title = capText(first.title, 200);
    return summary;
  }
  if (typeof record.key === 'string') summary.key = record.key;
  if (typeof record.title === 'string') summary.title = capText(record.title, 200);
  return summary;
}

function endStep(
  outcome: AgentOutcome,
  error: string | null,
  reason: string | null,
  state: LoopState,
  started: number,
): AgentStepBody {
  return {
    kind: 'end',
    outcome,
    error,
    reason,
    turns: state.turns,
    toolCalls: state.toolCalls,
    totalMs: Math.max(0, Date.now() - started),
  };
}

function outcomeOf(error: AssistantError): AgentOutcome {
  const outcome = (error as AssistantError & { outcome?: AgentOutcome }).outcome;
  return outcome ?? 'failed';
}

function reasonOf(error: AssistantError): string | null {
  const reason = (error as AssistantError & { reason?: string }).reason;
  return typeof reason === 'string' ? reason : null;
}

function isWebToolName(value: string): value is WebToolName {
  return (WEB_TOOL_NAMES as readonly string[]).includes(value);
}

function assistantMessage(response: unknown): { content?: unknown; tool_calls?: unknown } | null {
  const root = asRecord(response);
  const choices = root?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  return message ? { content: message.content, tool_calls: message.tool_calls } : null;
}

function toolCallsFrom(value: unknown, offset: number): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    const fn = asRecord(record.function);
    const name = typeof fn?.name === 'string' ? fn.name : '';
    const raw = fn?.arguments;
    const rawArguments =
      typeof raw === 'string'
        ? raw
        : raw === undefined || raw === null
          ? ''
          : safeStringify(raw);
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : `call_${offset + index + 1}`;
    calls.push({
      id,
      type: 'function',
      function: {
        name,
        arguments: rawArguments,
      },
    });
  });
  return calls;
}

function toolMessage(toolCallId: string, content: string): Record<string, unknown> {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content,
  };
}

function errorContent(error: string, detail: string): string {
  return JSON.stringify({ error, detail });
}

function incomplete(reason: string, outcome: AgentOutcome): AssistantError {
  const error = new AssistantError('metadata_incomplete') as AssistantError & {
    reason: string;
    outcome: AgentOutcome;
  };
  error.message = `metadata_incomplete: ${reason}`;
  error.reason = reason;
  error.outcome = outcome;
  return error;
}

function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new DeadlineExceeded());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceeded()), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function capText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type { AssistantProposal };
