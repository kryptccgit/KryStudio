// The built-in chat on an OpenAI-compatible API: OpenAI (ChatGPT) and OpenRouter (shared/agent/providers.ts).
// The same tool registry, agent identity and undo groups as the Anthropic loop (./loop.ts), over the Chat
// Completions API with streamed text and function calls. Free of Electron imports so it can be tested against a
// mock fetch; ./index.ts supplies the key.

import type { ActionResult, AgentChatEvent } from '@shared/types';
import { AGENT_PROVIDERS, type AgentProvider } from '@shared/agent/providers';
import { MCP_CHANNELS, type MainDeps } from '../mcp/types';
import { TOOLS, callTool, getTool, inputJsonSchema, newSession, projectOverview, resultText, type ToolCaller } from '../mcp/tools';
import { AGENT_SYSTEM_PROMPT } from './prompt';
import type { AgentCore } from './loop';

const MAX_TURNS = 30;
const MAX_RESULT_CHARS = 40_000;

/** One Chat Completions message (the subset this loop sends). */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CompatConfig {
  provider: AgentProvider;
  key: string;
  model: string;
  /** Extra request headers (OpenRouter's app attribution). */
  headers?: Record<string, string>;
}

/** The registry as Chat Completions function tools (deterministic order). */
export function openAiTools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return TOOLS.map((def) => ({ type: 'function' as const, function: { name: def.name, description: def.description, parameters: inputJsonSchema(def) } }));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A sentence for a failed request, per provider. */
export function compatErrorMessage(provider: AgentProvider, model: string, err: unknown): string {
  const name = AGENT_PROVIDERS[provider].label;
  if (err instanceof HttpError) {
    if (err.status === 401) return `The ${name} key was rejected. Check it in the Agents panel.`;
    if (err.status === 402) return `Your ${name} account is out of credit. Add some, then try again.`;
    if (err.status === 403) return `This ${name} key can't use ${model}.`;
    if (err.status === 404) return `Model "${model}" wasn't found on ${name}. Pick another in the Agents panel.`;
    if (err.status === 429) return `Rate limited by ${name}. Wait a moment and try again.`;
    return `${name} error ${err.status}: ${err.message}`;
  }
  if (err instanceof TypeError) return `Couldn't reach ${name}. Check your internet connection.`;
  return `Agent error: ${(err as Error)?.message ?? String(err)}`;
}

interface TurnResult {
  text: string;
  toolCalls: ChatToolCall[];
  finish: string | null;
  usage: { input: number; output: number; cost: number | null };
}

/** One streamed Chat Completions request: emits text deltas, assembles the tool calls. */
export async function streamTurn(
  fetchFn: typeof fetch,
  cfg: CompatConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onText: (delta: string) => void,
): Promise<TurnResult> {
  const res = await fetchFn(`${AGENT_PROVIDERS[cfg.provider].baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', ...(cfg.headers ?? {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = res.statusText || 'request failed';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j?.error?.message) msg = j.error.message;
    } catch {
      /* not JSON */
    }
    throw new HttpError(res.status, msg.slice(0, 300));
  }
  const out: TurnResult = { text: '', toolCalls: [], finish: null, usage: { input: 0, output: 0, cost: null } };
  const calls: ChatToolCall[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const onLine = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j: {
      choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string };
    };
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.error?.message) throw new HttpError(500, j.error.message);
    const ch = j.choices?.[0];
    if (ch?.delta?.content) {
      out.text += ch.delta.content;
      onText(ch.delta.content);
    }
    for (const t of ch?.delta?.tool_calls ?? []) {
      const i = t.index ?? calls.length;
      const c = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (t.id) c.id = t.id;
      if (t.function?.name) c.function.name += t.function.name;
      if (t.function?.arguments) c.function.arguments += t.function.arguments;
    }
    if (ch?.finish_reason) out.finish = ch.finish_reason;
    if (j.usage) {
      out.usage.input = j.usage.prompt_tokens ?? out.usage.input;
      out.usage.output = j.usage.completion_tokens ?? out.usage.output;
      if (typeof j.usage.cost === 'number') out.usage.cost = j.usage.cost;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) onLine(buf.trim());
  out.toolCalls = calls.filter((c) => c && c.function.name).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return out;
}

export function createCompatCore(deps: MainDeps, getConfig: () => CompatConfig | null, fetchFn: typeof fetch = fetch): AgentCore {
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'krypt-panel', name: 'Krypt Agent' }, session: newSession(), via: 'panel' };
  let messages: ChatMessage[] = [];
  let lastVersionShown = -1;
  let lastFocusShown = '';
  let running: AbortController | null = null;
  const tools = openAiTools();

  const emit = (e: AgentChatEvent) => {
    try {
      deps.broadcast(MCP_CHANNELS.agentEvent, e);
    } catch {
      /* the panel may be closed */
    }
  };

  async function run(cfg: CompatConfig, userText: string, signal: AbortSignal): Promise<ActionResult> {
    const usage = { input: 0, output: 0, cost: 0, costKnown: true };
    const usageEvent = () => ({ inputTokens: usage.input, outputTokens: usage.output, costUsd: usage.costKnown ? Math.round(usage.cost * 10000) / 10000 : 0 });

    const parts: string[] = [];
    const focus = deps.library ? await deps.library.focusContext() : null;
    if (focus && focus.key !== lastFocusShown) {
      parts.push(`<style_focus>\nThe user set a style focus: compose ORIGINAL music from this profile of their own reference songs (vary the examples, never copy a reference; run check_originality before you finish).\n${focus.text}\n</style_focus>`);
      lastFocusShown = focus.key;
    } else if (!focus && lastFocusShown) {
      parts.push('<style_focus>The user cleared the style focus: stop leaning on the earlier profile unless they ask.</style_focus>');
      lastFocusShown = '';
    }
    if (deps.doc.version !== lastVersionShown) {
      parts.push(`<project_overview doc_version="${deps.doc.version}">\n${projectOverview(deps).text}\n</project_overview>`);
      lastVersionShown = deps.doc.version;
    }
    parts.push(userText);
    if (!messages.length) messages.push({ role: 'system', content: AGENT_SYSTEM_PROMPT });
    messages.push({ role: 'user', content: parts.join('\n\n') });

    let finalText = '';
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages,
        tools,
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
        ...(cfg.provider === 'openrouter' ? { usage: { include: true } } : {}),
      };
      const r = await streamTurn(fetchFn, cfg, body, signal, (d) => {
        finalText += d;
        emit({ type: 'text', text: d });
      });
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      if (r.usage.cost === null) usage.costKnown = false;
      else usage.cost += r.usage.cost;
      messages.push({ role: 'assistant', content: r.text || null, ...(r.toolCalls.length ? { tool_calls: r.toolCalls } : {}) });
      if (!r.toolCalls.length) {
        emit({ type: 'done', usage: usageEvent() });
        if (r.finish === 'length') return { ok: false, message: 'The reply hit the output limit and was cut off.' };
        if (r.finish === 'content_filter') return { ok: false, message: 'The model declined this request. Try rephrasing it.' };
        return { ok: true, message: finalText.trim().slice(0, 500) || 'Done.' };
      }
      for (const call of r.toolCalls) {
        if (signal.aborted) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Cancelled by the user before this tool ran.' });
          continue;
        }
        let input: unknown;
        try {
          input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
        } catch {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: the arguments were not valid JSON. Send the call again.' });
          continue;
        }
        if (r.finish === 'length') {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: the tool input was cut off by the output limit. Send a smaller call.' });
          continue;
        }
        emit({ type: 'tool_use', tool: call.function.name, input });
        const res = await callTool(deps, caller, call.function.name, input);
        let text = resultText(res, getTool(call.function.name)?.kind);
        if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`;
        emit({ type: 'tool_result', tool: call.function.name, ok: res.ok, text: res.message.slice(0, 400) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: res.ok ? text : `Error: ${text}` });
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    emit({ type: 'error', text: `Stopped after ${MAX_TURNS} steps. Ask me to continue if there is more to do.` });
    emit({ type: 'done', usage: usageEvent() });
    return { ok: false, message: `Stopped after ${MAX_TURNS} model steps.` };
  }

  /** Every tool call in the history has an answer (so a cancelled turn never breaks the next request). */
  const closeDangling = (note: string) => {
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant' || !last.tool_calls?.length) return;
    for (const c of last.tool_calls) messages.push({ role: 'tool', tool_call_id: c.id, content: note });
  };

  return {
    history: () => messages as unknown as ReturnType<AgentCore['history']>,
    busy: () => running !== null,

    async send(message: string): Promise<ActionResult> {
      const text = String(message ?? '').trim();
      if (!text) return { ok: false, message: 'Type a message first.' };
      if (running) return { ok: false, message: 'The agent is still working: wait for it or press Stop.' };
      const cfg = getConfig();
      if (!cfg) return { ok: false, message: 'Add an API key in the Agents panel to use the built-in chat.' };
      const ctrl = new AbortController();
      running = ctrl;
      try {
        return await run(cfg, text, ctrl.signal);
      } catch (err) {
        closeDangling('Cancelled.');
        if (ctrl.signal.aborted || (err as Error)?.name === 'AbortError') {
          emit({ type: 'done' });
          return { ok: false, message: 'Stopped.' };
        }
        const msg = compatErrorMessage(cfg.provider, cfg.model, err);
        deps.log('warn', `Agent: ${msg}`);
        emit({ type: 'error', text: msg });
        emit({ type: 'done' });
        return { ok: false, message: msg };
      } finally {
        running = null;
        if (caller.session.group) {
          deps.doc.endGroup(caller.session.group.id);
          caller.session.group = null;
        }
      }
    },

    async cancel(): Promise<void> {
      running?.abort();
    },

    async reset(): Promise<void> {
      running?.abort();
      messages = [];
      lastVersionShown = -1;
      lastFocusShown = '';
    },
  };
}
