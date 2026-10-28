import {
  AssistantError,
  postChatCompletion,
  type AssistantConfig,
  type AssistantTransport,
} from './client.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import type { OpenLibraryTransport } from '../openLibrary.js';
import { buildSystemPrompt, buildUserMessage, type MetadataPromptInput } from './prompt.js';
import { validateSubmission, type AssistantProposal } from './submit.js';

export const MAX_MODEL_TURNS = 4;
export const MAX_TOOL_CALLS = 6;
export const TOTAL_BUDGET_MS = 90_000;
export const MAX_TOOL_ARGUMENT_CHARS = 120_000;
export const MAX_TOOL_RESULT_CHARS = 12_000;

/** Descriptive aliases for callers that prefer budget-oriented names. */
export const AGENT_MAX_TURNS = MAX_MODEL_TURNS;
export const AGENT_MAX_TOOL_CALLS = MAX_TOOL_CALLS;
export const AGENT_TIMEOUT_MS = TOTAL_BUDGET_MS;

export interface RunMetadataAgentOptions {
  transport: AssistantTransport;
  openLibrary: OpenLibraryTransport;
  config: AssistantConfig;
  input: MetadataPromptInput;
}

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

export async function runMetadataAgent(options: RunMetadataAgentOptions): Promise<MetadataAgentResult> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserMessage(options.input) },
  ];
  let turns = 0;
  let toolCalls = 0;

  while (turns < MAX_MODEL_TURNS) {
    if (Date.now() >= deadline) throw incomplete('time budget exhausted without submit_metadata');
    turns += 1;

    let response: unknown;
    try {
      response = await beforeDeadline(
        postChatCompletion(options.transport, options.config, {
          model: options.config.model,
          messages,
          tools: TOOL_DEFINITIONS,
          tool_choice: 'auto',
          temperature: 0.2,
          stream: false,
        }),
        deadline,
      );
    } catch (error) {
      if (error instanceof DeadlineExceeded || Date.now() >= deadline) {
        throw incomplete('time budget exhausted without submit_metadata');
      }
      throw error;
    }

    if (Date.now() >= deadline) throw incomplete('time budget exhausted without submit_metadata');
    const assistant = assistantMessage(response);
    if (!assistant) throw new AssistantError('assistant_invalid_response');

    const calls = toolCallsFrom(assistant.tool_calls, toolCalls);
    if (calls.length === 0) {
      throw incomplete(
        turns >= MAX_MODEL_TURNS
          ? 'model turn limit reached without submit_metadata'
          : 'model returned no tool calls and did not submit metadata',
      );
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
      if (toolCalls >= MAX_TOOL_CALLS) {
        throw incomplete('tool call limit reached without submit_metadata');
      }
      toolCalls += 1;

      const name = call.function.name;
      const rawArguments = call.function.arguments;
      if (rawArguments.length > MAX_TOOL_ARGUMENT_CHARS) {
        messages.push(toolMessage(call.id, errorContent('invalid_arguments', 'tool arguments are too large')));
        continue;
      }

      let parsed: unknown;
      try {
        parsed = rawArguments.length === 0 ? {} : (JSON.parse(rawArguments) as unknown);
      } catch {
        messages.push(toolMessage(call.id, errorContent('invalid_arguments', 'tool arguments must be valid JSON')));
        continue;
      }

      if (name === 'submit_metadata') {
        const submission = validateSubmission(parsed);
        if (submission.ok) {
          return {
            proposal: submission.proposal,
            model: options.config.model,
            toolCalls,
            turns,
          };
        }
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

      if (!isToolName(name)) {
        messages.push(
          toolMessage(
            call.id,
            errorContent(
              'unknown_tool',
              'the only tools are search_open_library, get_open_library_record, and submit_metadata',
            ),
          ),
        );
        continue;
      }

      let content: string;
      try {
        content = await beforeDeadline(
          executeTool(name, parsed, { openLibrary: options.openLibrary, origin: options.openLibrary.origin }),
          deadline,
        );
      } catch (error) {
        if (error instanceof DeadlineExceeded || Date.now() >= deadline) {
          throw incomplete('time budget exhausted without submit_metadata');
        }
        content = errorContent('metadata_unavailable', 'Open Library request failed');
      }
      if (Date.now() >= deadline) throw incomplete('time budget exhausted without submit_metadata');
      messages.push(toolMessage(call.id, capText(content, MAX_TOOL_RESULT_CHARS)));
    }

    // There is no way to submit after the tool budget is gone; do not ask the model for another turn.
    if (toolCalls >= MAX_TOOL_CALLS) {
      throw incomplete('tool call limit reached without submit_metadata');
    }
  }

  throw incomplete('model turn limit reached without submit_metadata');
}

function isToolName(value: string): value is 'search_open_library' | 'get_open_library_record' {
  return value === 'search_open_library' || value === 'get_open_library_record';
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

function incomplete(reason: string): AssistantError {
  // The client's exported code union predates the agent; the stable runtime code is metadata_incomplete.
  const error = new AssistantError('metadata_incomplete' as never) as AssistantError & { reason: string };
  error.message = `metadata_incomplete: ${reason}`;
  error.reason = reason;
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
