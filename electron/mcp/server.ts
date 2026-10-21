import { z } from 'zod';
import {
  CLIENT_CAPABILITIES_META_KEY,
  InMemoryTransport,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ResourceTemplate,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { MainDeps } from './types';
import { TOOLS, annotationsFor, callTool, patternKpn, projectOverview, resultText, type ToolCaller } from './tools';
import { KPN_REFERENCE } from '@shared/kpn';
import { arrangePrompt, beatPrompt, focusPrompt, likePrompt, mashupPrompt, mixcheckPrompt, SERVER_INSTRUCTIONS } from './prompts';
import { safeName } from './tools/util';
import { choiceFromElicitResult, CONSENT_TIMEOUT_MS, consentElicitation, consentKey, ConsentPending, type ConsentAsker } from './consent';

export const SERVER_NAME = 'krypt-studio';

export interface ServerHooks {
  caller(): ToolCaller;
  gate(): string | null;
  counted?(): void;
  client?(): string | null;
  pendingConsent?: Map<string, number>;
}

interface ToolExtra {
  mcpReq?: {
    id?: string | number;
    _meta?: { progressToken?: string | number } & Record<string, unknown>;
    signal?: AbortSignal;
    notify?: (n: { method: string; params?: Record<string, unknown> }) => Promise<void>;
    envelope?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
  };
}

export function isClaudeCode(client: string | null | undefined): boolean {
  return (client ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === 'claude-code';
}

export const BEAT_EXTRA_SLOTS = 34;
export const LIKE_EXTRA_SLOTS = 28;
const moreNames = (n: number): string[] => Array.from({ length: n }, (_, i) => `more${i + 1}`);
const moreSchema = (names: string[]) => Object.fromEntries(names.map((k) => [k, z.string().optional().describe('More words of the request (Claude Code passes one word per argument).')]));

const PENDING_CONSENT_MS = 30 * 60_000;

function clientAsker(server: McpServer, deps: MainDeps, hooks: ServerHooks, extra: ToolExtra | undefined): ConsentAsker | undefined {
  const req = extra?.mcpReq;
  const env = req?.envelope;
  const modern = !!env && env[PROTOCOL_VERSION_META_KEY] !== undefined;
  let caps: { elicitation?: Record<string, unknown> } | undefined;
  try {
    caps = (modern ? env?.[CLIENT_CAPABILITIES_META_KEY] : server.server.getClientCapabilities()) as typeof caps;
  } catch {
    caps = undefined;
  }
  const el = caps?.elicitation;
  if (!el || typeof el !== 'object' || (!('form' in el) && 'url' in el)) return undefined;
  const where = hooks.caller().actor.name;
  if (modern) {
    const pending = hooks.pendingConsent;
    if (!pending) return undefined;
    return {
      where,
      async ask(r) {
        const key = consentKey(r);
        const view = inputResponse(req?.inputResponses, key);
        const issued = pending.get(key);
        if (view.kind === 'elicit' && issued !== undefined && issued > Date.now()) {
          pending.delete(key);
          return choiceFromElicitResult({ action: view.action, content: view.content });
        }
        throw new ConsentPending(r, key);
      },
    };
  }
  return {
    where,
    async ask(r, signal) {
      const res = await server.server.request({ method: 'elicitation/create', params: consentElicitation(r) } as never, {
        timeout: (deps.consent?.timeoutMs ?? CONSENT_TIMEOUT_MS) + 5_000,
        signal,
        relatedRequestId: req?.id,
      } as never);
      return choiceFromElicitResult(res);
    },
  };
}

function progressSender(extra: ToolExtra | undefined): ((fraction: number, message: string) => void) | undefined {
  const token = extra?.mcpReq?._meta?.progressToken;
  const notify = extra?.mcpReq?.notify;
  if ((typeof token !== 'string' && typeof token !== 'number') || !notify) return undefined;
  let last = 0;
  let count = 0;
  return (fraction, message) => {
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    const text = fraction >= 0 ? `${message} ${Math.round(fraction * 100)}%` : message;
    void notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++count, message: text } }).catch(() => {});
  };
}

export function buildServer(deps: MainDeps, version: string, hooks: ServerHooks): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Krypt Studio', version },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  for (const def of TOOLS) {
    const meta = def.kind === 'destructive' && deps.getSettings().mcp.requireConsentForDestructive ? { 'anthropic/requiresUserInteraction': true } : undefined;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input as z.ZodObject,
        annotations: annotationsFor(def),
        ...(meta ? { _meta: meta } : {}),
      },
      (async (args: unknown, extra?: ToolExtra): Promise<CallToolResult | ReturnType<typeof inputRequired>> => {
        hooks.counted?.();
        const caller = hooks.caller();
        const consent = def.paths ? clientAsker(server, deps, hooks, extra) : undefined;
        const r = await callTool(deps, caller, def.name, args, { gate: hooks.gate, onProgress: progressSender(extra), signal: extra?.mcpReq?.signal, consent });
        if (r.pending && hooks.pendingConsent) {
          hooks.pendingConsent.set(r.pending.key, Date.now() + PENDING_CONSENT_MS);
          deps.log('info', `[agent] ${caller.actor.name} ${def.name}: asking the user in ${caller.actor.name} about ${r.pending.request.path}`);
          return inputRequired({ inputRequests: { [r.pending.key]: inputRequired.elicit(consentElicitation(r.pending.request) as never) } });
        }
        return { content: [{ type: 'text', text: resultText(r, def.kind) }], isError: !r.ok };
      }) as never,
    );
  }

  const refuse = () => {
    const g = hooks.gate();
    if (g) throw new Error(g);
  };

  server.registerResource(
    'project-overview',
    'krypt://project/overview',
    { title: 'Project overview', description: 'Compact map of the open project (same as get_project).', mimeType: 'text/plain' },
    async (uri) => {
      refuse();
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: projectOverview(deps).text }] };
    },
  );

  server.registerResource(
    'kpn-reference',
    'krypt://docs/kpn',
    { title: 'KPN reference', description: 'Krypt Pattern Notation: the syntax write_pattern accepts and read_pattern returns.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: KPN_REFERENCE }] }),
  );

  server.registerResource(
    'pattern-kpn',
    new ResourceTemplate('krypt://pattern/{id}.kpn', {
      list: async () => {
        if (hooks.gate()) return { resources: [] };
        const p = deps.doc.project;
        return { resources: p.patternOrder.map((id) => ({ uri: `krypt://pattern/${id}.kpn`, name: safeName(p.patterns[id].name), mimeType: 'text/plain' })) };
      },
    }),
    { title: 'Pattern (KPN)', description: 'A pattern as canonical KPN.', mimeType: 'text/plain' },
    async (uri, vars) => {
      refuse();
      const id = String(Array.isArray(vars.id) ? vars.id[0] : vars.id);
      if (!deps.doc.project.patterns[id]) throw new Error(`No pattern ${safeName(id, 40)}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: patternKpn(deps, id).text }] };
    },
  );

  server.registerResource(
    'style-profile',
    new ResourceTemplate('krypt://styles/{collectionId}', {
      list: async () => {
        if (hooks.gate() || !deps.library) return { resources: [] };
        return { resources: deps.library.collections().map((c) => ({ uri: `krypt://styles/${c.id}`, name: safeName(c.name), mimeType: 'text/plain' })) };
      },
    }),
    { title: 'Style profile', description: "A reference-library collection's style profile (same as get_style_profile).", mimeType: 'text/plain' },
    async (uri, vars) => {
      refuse();
      if (!deps.library) throw new Error('The reference library is not available in this session');
      const id = String(Array.isArray(vars.collectionId) ? vars.collectionId[0] : vars.collectionId);
      const r = await deps.library.profileText(id);
      if (!r.ok || !r.data) throw new Error(r.message ?? `No collection ${safeName(id, 40)}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: r.data.text }] };
    },
  );

  const cc = isClaudeCode(hooks.client?.());
  const beatMore = cc ? moreNames(BEAT_EXTRA_SLOTS) : [];
  const likeMore = cc ? moreNames(LIKE_EXTRA_SLOTS) : [];
  server.registerPrompt(
    'beat',
    {
      title: 'Make a beat',
      description:
        'One prompt → a finished song: a plain-language idea becomes a complete, arranged and mixed track (genre playbook with resolved sounds → patterns per section → groove → arrangement → transitions → mix → review_song and fixes), with no questions along the way; your next prompt edits it. Every argument is optional (leave them empty and Claude picks). Positional (trap 140 F#m 4 dark …) or plain words; a song file path anywhere in the words becomes a reference to make something like (originally).',
      argsSchema: z.object({
        genre: z.string().optional().describe('e.g. trap, house, lofi, drill, dnb, boom-bap, edm'),
        bpm: z.string().optional(),
        key: z.string().optional().describe('e.g. F#m'),
        bars: z.string().optional(),
        mood: z.string().optional(),
        idea: z.string().optional().describe('Describe it in your own words, e.g. "dark bouncy trap, like driving at night", or "an edm song like C:\\Users\\me\\Downloads\\song.mp3"'),
        ...moreSchema(beatMore),
      }),
    },
    (args) => {
      const a = args as Record<string, string | undefined>;
      const text = beatPrompt(a, beatMore.map((k) => a[k]), { slots: cc ? 6 + beatMore.length : undefined });
      return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    },
  );

  server.registerPrompt(
    'like',
    {
      title: 'Make a song like this one',
      description:
        'Make a finished, ORIGINAL song in the style of a reference track you own, in one go: Krypt Studio imports it muted, analyses its tempo, key, structure and energy, studies its groove, builds something new in the genre you ask for from its playbook, reviews and fixes the mix, checks originality and compares with the reference. Example: /krypt-studio:like C:\\Users\\me\\Downloads\\song.mp3 make it edm',
      argsSchema: z.object({
        song: z.string().optional().describe('The reference song: the full path of an audio file (mp3, wav, flac …), or a clip already on the Playlist'),
        request: z.string().optional().describe('What to make, e.g. "an edm song with a big drop"'),
        ...moreSchema(likeMore),
      }),
    },
    (args) => {
      const a = args as Record<string, string | undefined>;
      const text = likePrompt(a, likeMore.map((k) => a[k]), { slots: cc ? 2 + likeMore.length : undefined });
      return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    },
  );

  server.registerPrompt(
    'focus',
    {
      title: 'Compose in a reference style',
      description: "Make a finished, original song from a collection of the user's own reference songs: its style profile (tempo, drums, bass, harmony, structure, mix) plus the playbook → compose → vary → review_song → check_originality workflow. Defaults to the active focus.",
      argsSchema: z.object({
        collection: z.string().optional().describe('Collection name (default: the active focus)'),
        idea: z.string().optional().describe('What to make, in your own words'),
      }),
    },
    async (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: await focusPromptText(deps, args) } }] }),
  );

  server.registerPrompt(
    'mixcheck',
    {
      title: 'Mix check',
      description: 'Gain staging, low end, masking and loudness pass driven by review_song (levels and effects only).',
      argsSchema: z.object({ focus: z.string().optional(), target_lufs: z.string().optional() }),
    },
    (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: mixcheckPrompt(args) } }] }),
  );

  server.registerPrompt(
    'mashup',
    {
      title: 'Make a mashup',
      description:
        "Put one song's vocal on another song's instrumental in one go: auto_mashup builds it in one call (stems with the user's stem model, key and tempo matched, Krypt Tune, intro / verses / hooks / break / outro with transitions, mix), then refine by hand, review_song and fix. Every argument is optional.",
      argsSchema: z.object({
        a: z.string().optional().describe('The song (clip or track name) whose vocal to use'),
        b: z.string().optional().describe('The song (clip or track name) whose instrumental to use'),
        tune: z.string().optional().describe('Krypt Tune style: natural, pop or hard'),
      }),
    },
    (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: mashupPrompt(args) } }] }),
  );

  server.registerPrompt(
    'arrange',
    {
      title: 'Arrange a song',
      description: 'Turn the existing patterns into a full arrangement with sections, markers, transitions at every boundary and a review_song check.',
      argsSchema: z.object({ structure: z.string().optional().describe('e.g. intro-verse-hook-verse-hook-outro'), length_bars: z.string().optional() }),
    },
    (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: arrangePrompt(args) } }] }),
  );

  return server;
}

async function focusPromptText(deps: MainDeps, args: { collection?: string; idea?: string }): Promise<string> {
  const lib = deps.library;
  if (!lib) return 'I wanted to compose in the style of my reference library, but it is not available in this Krypt Studio session. Tell me so, then offer to make something with the beat prompt instead.';
  const focus = lib.focus();
  const ref = args.collection?.trim() || undefined;
  if (!ref && !focus) {
    return 'I want to compose in the style of my own reference songs, but no style focus is set. Call library_status, show me my collections, and ask which one to use (or call get_style_profile with the one I name).';
  }
  const r = await lib.profileText(ref);
  if (!r.ok || !r.data) return `I asked for the style of "${safeName(ref ?? focus?.name ?? '', 60)}", but: ${r.message ?? 'no profile'}. Call library_status and ask me which collection I meant.`;
  const isFocus = focus?.collectionId === r.data.collection.id;
  return focusPrompt({ name: safeName(r.data.collection.name, 60), profile: r.data.text, brief: isFocus ? focus?.brief : undefined, idea: args.idea, isFocus });
}

export const MODERN_VERSION = '2026-07-28';

export async function captureManifest(deps: MainDeps, version: string): Promise<Record<string, unknown>> {
  const hooks: ServerHooks = { caller: () => ({ actor: { kind: 'agent', clientId: 'manifest', name: 'manifest' }, session: { group: null }, via: 'mcp' }), gate: () => 'offline' };
  const ask = async (msgs: JSONRPCMessage[]): Promise<Map<number, unknown>> => {
    const [client, srv] = InMemoryTransport.createLinkedPair();
    const answers = new Map<number, unknown>();
    const want = msgs.filter((m) => 'id' in m).length;
    const done = new Promise<void>((resolve) => {
      client.onmessage = (m) => {
        const mm = m as { id?: number; result?: unknown; error?: unknown };
        if (typeof mm.id === 'number') answers.set(mm.id, mm.result ?? { error: mm.error });
        if (answers.size >= want) resolve();
      };
    });
    await client.start();
    const handle = serveStdio(() => buildServer(deps, version, hooks), { transport: srv });
    for (const m of msgs) await client.send(m);
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    await handle.close();
    return answers;
  };
  const clientInfo = { name: 'krypt-manifest', version };
  const legacy = await ask([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 5, method: 'resources/templates/list', params: {} },
  ] as JSONRPCMessage[]);
  const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': clientInfo };
  const modern = await ask([
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 3, method: 'prompts/list', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 4, method: 'resources/list', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 5, method: 'resources/templates/list', params: { _meta: meta } },
  ] as JSONRPCMessage[]);
  const pick = (m: Map<number, unknown>, names: string[]) => Object.fromEntries(names.map((n, i) => [n, m.get(i + 1) ?? null]));
  const legacyAnswers = pick(legacy, ['initialize', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']);
  const modernAnswers = pick(modern, ['server/discover', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']);
  for (const k of ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']) {
    const v = modernAnswers[k] as { error?: unknown } | null;
    if (!v || v.error) modernAnswers[k] = legacyAnswers[k];
  }
  return {
    server: SERVER_NAME,
    version,
    generatedAt: new Date().toISOString(),
    legacyVersions: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
    modernVersion: MODERN_VERSION,
    legacy: legacyAnswers,
    modern: modernAnswers,
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, kind: t.kind })),
  };
}
