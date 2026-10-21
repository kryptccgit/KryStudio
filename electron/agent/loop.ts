// The built-in agent's tool-use loop (research/04 §8), free of Electron
// imports so it can be tested against a mock API. electron/agent/index.ts
// adds the safeStorage-backed API key and exposes createAgent().
//
// - A manual streaming loop over the SAME tool registry the MCP server uses.
// - Actor {kind:'agent', clientId:'krypt-panel', name:'Krypt Agent'}: every
//   edit is undoable per agent and revertible as a whole.
// - Prompt caching: deterministic tool list + frozen system prompt carry
//   explicit breakpoints; top-level automatic caching covers the growing
//   conversation. History is append-only (thinking blocks are passed back
//   unchanged), so preserved thinking stays valid.

import Anthropic from '@anthropic-ai/sdk';
import type { ActionResult, AgentChatEvent } from '@shared/types';
import { MCP_CHANNELS, type MainDeps } from '../mcp/types';
import { TOOLS, callTool, getTool, inputJsonSchema, newSession, projectOverview, resultText, type ToolCaller } from '../mcp/tools';
import { AGENT_SYSTEM_PROMPT } from './prompt';
import { modelFor } from '@shared/agent/providers';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TURNS = 30;
const MAX_TOKENS = 64000;
const MAX_RESULT_CHARS = 40_000;

/** $ per million tokens: input, output, cache write (5 min), cache read. */
const PRICING: Record<string, { in: number; out: number; write: number; read: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, write: 5, read: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, write: 2.5, read: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, write: 0.125, read: 0.01 },
  'claude-fable-5-1': { in: 10, out: 50, write: 12.5, read: 0.25 },
};

/** Models that accept the server-side `fallbacks: "default"` refusal routing. */
export function supportsFallbacks(model: string): boolean {
  return /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1|fable-5)$/.test(model);
}

interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function costOf(model: string, u: Usage): number {
  const p = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  return (u.input * p.in + u.output * p.out + u.cacheWrite * p.write + u.cacheRead * p.read) / 1_000_000;
}

/** Anthropic tool definitions from the registry (deterministic order; the last one carries the cache breakpoint). */
export function anthropicTools(): Anthropic.Beta.BetaToolUnion[] {
  return TOOLS.map((def, i) => {
    const tool: Anthropic.Beta.BetaTool = {
      name: def.name,
      description: def.description,
      input_schema: inputJsonSchema(def) as Anthropic.Beta.BetaTool.InputSchema,
      // Large KPN inputs stream as they are generated; callTool() validates every input with zod.
      eager_input_streaming: true,
    };
    if (i === TOOLS.length - 1) tool.cache_control = { type: 'ephemeral' };
    return tool;
  });
}

export interface AgentCore {
  send(message: string): Promise<ActionResult>;
  cancel(): Promise<void>;
  reset(): Promise<void>;
  /** The conversation so far (tests / diagnostics). */
  history(): readonly Anthropic.Beta.BetaMessageParam[];
  /** A request is running (the project tabs refuse a switch meanwhile). */
  busy(): boolean;
}

export function createAgentCore(deps: MainDeps, getClient: () => Anthropic | null): AgentCore {
  const caller: ToolCaller = { actor: { kind: 'agent', clientId: 'krypt-panel', name: 'Krypt Agent' }, session: newSession(), via: 'panel' };
  let messages: Anthropic.Beta.BetaMessageParam[] = [];
  let lastVersionShown = -1;
  /** Style focus last attached to a user turn ('' = none shown yet / cleared). */
  let lastFocusShown = '';
  let running: AbortController | null = null;
  const tools = anthropicTools();

  const emit = (e: AgentChatEvent) => {
    try {
      deps.broadcast(MCP_CHANNELS.agentEvent, e);
    } catch {
      /* the panel may be closed */
    }
  };

  /** Close a dangling tool_use turn so the history stays valid (append-only). */
  const closeDanglingToolUse = (note: string) => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;
    const uses = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => (b as { type?: string }).type === 'tool_use');
    if (!uses.length) return;
    messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, is_error: true, content: note })) });
  };

  async function run(client: Anthropic, model: string, userText: string, signal: AbortSignal): Promise<ActionResult> {
    const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const usageEvent = () => ({ inputTokens: usage.input + usage.cacheWrite + usage.cacheRead, outputTokens: usage.output, costUsd: Math.round(costOf(model, usage) * 10000) / 10000 });

    // Project state goes in the user turn (never the cached system prompt).
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    // The user's style focus (reference library): attached when it is set or changes, like the overview.
    const focus = deps.library ? await deps.library.focusContext() : null;
    if (focus && focus.key !== lastFocusShown) {
      content.push({ type: 'text', text: `<style_focus>
The user set a style focus: compose ORIGINAL music from this profile of their own reference songs (vary the examples, never copy a reference; run check_originality before you finish).
${focus.text}
</style_focus>` });
      lastFocusShown = focus.key;
    } else if (!focus && lastFocusShown) {
      content.push({ type: 'text', text: '<style_focus>The user cleared the style focus: stop leaning on the earlier profile unless they ask.</style_focus>' });
      lastFocusShown = '';
    }
    if (deps.doc.version !== lastVersionShown) {
      content.push({ type: 'text', text: `<project_overview doc_version="${deps.doc.version}">\n${projectOverview(deps).text}\n</project_overview>` });
      lastVersionShown = deps.doc.version;
    }
    content.push({ type: 'text', text: userText });
    messages.push({ role: 'user', content });

    const fallbacks = supportsFallbacks(model);
    let jsonRetries = 0;
    let finalText = '';

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const params: Anthropic.Beta.MessageCreateParamsStreaming = {
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: AGENT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        stream: true,
        // Refusals are re-run server-side on Anthropic's recommended fallback model.
        ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      };
      const stream = client.beta.messages.stream(params, { signal });
      stream.on('text', (delta) => {
        finalText += delta;
        emit({ type: 'text', text: delta });
      });
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // Only an unparseable streamed tool input is retried; API / abort errors propagate.
        if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIUserAbortError || signal.aborted || jsonRetries++ >= 2) throw err;
        deps.log('warn', 'Agent: a streamed tool input was not valid JSON; re-issuing the turn');
        continue;
      }
      usage.input += message.usage.input_tokens ?? 0;
      usage.output += message.usage.output_tokens ?? 0;
      usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
      usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;

      if (message.stop_reason === 'refusal') {
        const cat = message.stop_details?.category ? ` (${message.stop_details.category})` : '';
        emit({ type: 'error', text: `The model declined this request${cat}. Try rephrasing it.` });
        emit({ type: 'done', usage: usageEvent() });
        return { ok: false, message: `The model declined this request${cat}.` };
      }
      // Append the full assistant turn unchanged (thinking blocks included).
      messages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
      if (message.stop_reason === 'pause_turn') continue;
      const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (!uses.length) {
        emit({ type: 'done', usage: usageEvent() });
        if (message.stop_reason === 'max_tokens') return { ok: false, message: 'The reply hit the output limit and was cut off.' };
        return { ok: true, message: finalText.trim().slice(0, 500) || 'Done.' };
      }
      if (message.stop_reason === 'max_tokens') {
        // Never run a tool on input that was cut off mid-generation.
        closeDanglingToolUse('Not run: the tool input was cut off by the output limit. Send a smaller call.');
        continue;
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        if (signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Cancelled by the user before this tool ran.' });
          continue;
        }
        emit({ type: 'tool_use', tool: use.name, input: use.input });
        const r = await callTool(deps, caller, use.name, use.input);
        let text = resultText(r, getTool(use.name)?.kind);
        if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`;
        emit({ type: 'tool_result', tool: use.name, ok: r.ok, text: r.message.slice(0, 400) });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: text, ...(r.ok ? {} : { is_error: true }) });
      }
      messages.push({ role: 'user', content: results });
      if (signal.aborted) throw new Anthropic.APIUserAbortError();
    }
    closeDanglingToolUse('Stopped: too many steps in one request.');
    emit({ type: 'error', text: `Stopped after ${MAX_TURNS} steps. Ask me to continue if there is more to do.` });
    emit({ type: 'done', usage: usageEvent() });
    return { ok: false, message: `Stopped after ${MAX_TURNS} model steps.` };
  }

  return {
    history: () => messages,
    busy: () => running !== null,

    async send(message: string): Promise<ActionResult> {
      const text = String(message ?? '').trim();
      if (!text) return { ok: false, message: 'Type a message first.' };
      if (running) return { ok: false, message: 'The agent is still working: wait for it or press Stop.' };
      const client = getClient();
      if (!client) return { ok: false, message: 'Add your Anthropic API key in Settings → Agents to use the built-in agent.' };
      const model = modelFor(deps.getSettings().agent, 'anthropic');
      const ctrl = new AbortController();
      running = ctrl;
      try {
        return await run(client, model, text, ctrl.signal);
      } catch (err) {
        closeDanglingToolUse('Cancelled.');
        if (err instanceof Anthropic.APIUserAbortError || ctrl.signal.aborted) {
          emit({ type: 'done' });
          return { ok: false, message: 'Stopped.' };
        }
        let msg: string;
        if (err instanceof Anthropic.AuthenticationError) msg = 'The API key was rejected. Check it in Settings → Agents.';
        else if (err instanceof Anthropic.PermissionDeniedError) msg = `This API key can't use ${model}.`;
        else if (err instanceof Anthropic.NotFoundError) msg = `Model "${model}" wasn't found. Pick another in Settings → Agents.`;
        else if (err instanceof Anthropic.RateLimitError) msg = 'Rate limited by the Anthropic API. Wait a moment and try again.';
        else if (err instanceof Anthropic.BadRequestError) msg = `The request was rejected: ${err.message}`;
        else if (err instanceof Anthropic.APIConnectionError) msg = "Couldn't reach the Anthropic API. Check your internet connection.";
        else if (err instanceof Anthropic.APIError) msg = `Anthropic API error ${err.status ?? ''}: ${err.message}`;
        else msg = `Agent error: ${(err as Error)?.message ?? String(err)}`;
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
