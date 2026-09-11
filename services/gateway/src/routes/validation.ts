import { ProviderError, type ChatMessage, type ResponseFormat, type ToolCall, type ToolChoice, type ToolDefinition } from '../providers/types.ts';

export function invalid(message: string): never {
  throw new ProviderError(message, false, 400);
}

export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function tokenLimit(value: unknown, fallback = 16000): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 131072) invalid('Output token limit must be an integer between 1 and 131072.');
  return value;
}

export function textContent(value: unknown, allowNull = false): string {
  if (typeof value === 'string') return value;
  if (value === null && allowNull) return '';
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (!object(part) || part.type !== 'text' || typeof part.text !== 'string') invalid('This gateway endpoint currently supports text content only. Image, audio and file content must not be silently discarded.');
      return part.text;
    }).join('');
  }
  invalid('Message content must be a string or an array of text parts.');
}

export function messageContent(value: unknown, role: string): Pick<ChatMessage, 'content' | 'contentParts'> {
  if (!Array.isArray(value)) return { content: textContent(value, role === 'assistant') };
  let images = 0;
  const parts: NonNullable<ChatMessage['contentParts']> = value.map((part) => {
    if (!object(part) || part.type !== 'image_url') return { type: 'text', text: textContent([part]) };
    if (role !== 'user' || !object(part.image_url) || typeof part.image_url.url !== 'string') invalid('Image parts require a user message and image_url.url.');
    const { url, detail } = part.image_url;
    if (!/^https:\/\/[^\s]+$/i.test(url) && !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) invalid('Images must use an HTTPS URL or supported base64 image data URL.');
    if (detail !== undefined && !['auto', 'low', 'high'].includes(String(detail))) invalid('Invalid image detail.');
    images++;
    return { type: 'image', url, ...(detail !== undefined ? { detail: detail as 'auto' | 'low' | 'high' } : {}) };
  });
  if (images > 20) invalid('At most 20 images are allowed per message.');
  return { content: parts.map((part) => part.type === 'text' ? part.text : '').join(''), ...(images ? { contentParts: parts } : {}) };
}

export function responseFormat(value: unknown): ResponseFormat | undefined {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) invalid('response_format must be an object.');
  if (value.type === 'text' || value.type === 'json_object') return { type: value.type };
  if (value.type !== 'json_schema' || !object(value.json_schema)) invalid('response_format must use text, json_object or json_schema.');
  const schema = value.json_schema;
  if (typeof schema.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(schema.name) || !object(schema.schema)) invalid('json_schema requires a valid name and schema object.');
  if (schema.strict !== undefined && typeof schema.strict !== 'boolean') invalid('json_schema.strict must be boolean.');
  return { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, ...(typeof schema.strict === 'boolean' ? { strict: schema.strict } : {}), ...(typeof schema.description === 'string' ? { description: schema.description } : {}) } };
}

export function stopSequences(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const sequences = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(sequences) || sequences.length > 4 || sequences.some((sequence) => typeof sequence !== 'string' || !sequence || sequence.length > 1000)) invalid('stop must be a string or up to four non-empty strings.');
  return sequences;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

export function parseTools(raw: unknown): ToolDefinition[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 128) invalid('`tools` must be an array of at most 128 function tools.');
  const names = new Set<string>();
  const tools = raw.map((entry, index) => {
    if (!object(entry) || entry.type !== 'function' || !object(entry.function)) invalid(`tools[${index}] must be a function tool.`);
    const fn = entry.function;
    if (typeof fn.name !== 'string' || !TOOL_NAME.test(fn.name) || names.has(fn.name)) invalid(`tools[${index}] needs a unique valid function name.`);
    names.add(fn.name);
    if (fn.parameters !== undefined && !object(fn.parameters)) invalid(`tools[${index}].function.parameters must be a JSON Schema object.`);
    if (fn.strict !== undefined && typeof fn.strict !== 'boolean') invalid('Function strict must be boolean.');
    return {
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters: fn.parameters ?? { type: 'object', properties: {} },
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
    } as ToolDefinition;
  });
  return tools.length ? tools : undefined;
}

export function parseToolCalls(raw: unknown, openAI = true): ToolCall[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > 128) invalid('Tool calls must be a non-empty array of at most 128 entries.');
  return raw.map((entry) => {
    if (!object(entry)) invalid('Invalid tool call.');
    const fn = openAI ? entry.function : entry;
    if (openAI && entry.type !== 'function') invalid('Only function tool calls are supported.');
    if (typeof entry.id !== 'string' || !entry.id || !object(fn) || typeof fn.name !== 'string' || !TOOL_NAME.test(fn.name) || typeof fn.arguments !== 'string') invalid('Tool calls require id, function name and JSON arguments string.');
    try { if (!object(JSON.parse(fn.arguments))) invalid('Tool call arguments must be a JSON object.'); } catch { invalid('Tool call arguments must be a JSON object.'); }
    return { id: entry.id, name: fn.name, arguments: fn.arguments };
  });
}

/** Tool results must answer the immediately preceding assistant call set. */
export function validateConversation(messages: ChatMessage[]): void {
  if (!messages.length || messages.length > 2000) invalid('A conversation needs between 1 and 2000 messages.');
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.toolCallId || !pending.delete(message.toolCallId)) invalid('Each tool result must reference an outstanding assistant tool call exactly once.');
    } else {
      if (pending.size) invalid('All assistant tool calls must receive tool results before another message.');
      for (const call of message.toolCalls ?? []) {
        if (seen.has(call.id)) invalid('Tool call ids must be unique.');
        seen.add(call.id);
        pending.add(call.id);
      }
    }
  }
  if (pending.size) invalid('Provide results for all outstanding tool calls before requesting another completion.');
}

export function parseToolChoice(raw: unknown, tools?: ToolDefinition[]): ToolChoice | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'none') return raw;
  if (!tools?.length) invalid('tool_choice requires tools.');
  if (raw === 'auto' || raw === 'required') return raw;
  if (object(raw) && raw.type === 'function' && object(raw.function) && typeof raw.function.name === 'string') {
    const name = raw.function.name;
    if (tools.some((tool) => tool.name === name)) return { name };
  }
  invalid('tool_choice must be none, auto, required or a function tool declared in tools.');
}

export function numberOption(value: unknown, name: string, maximum: number, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid(`${name} must be a number between ${minimum} and ${maximum}.`);
  return value;
}
