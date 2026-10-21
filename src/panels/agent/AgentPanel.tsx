// ──────────────────────────────────────────────────────────────────────
// Agents: MCP status + connected clients, "Connect an agent" snippets,
// the live activity feed, the built-in chat, and the kill switch.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { Activity, Bot, Check, CircleHelp, ClipboardCopy, Download, History, Loader2, Plug, Power, RotateCcw, Send, Square, Unplug, Wrench } from 'lucide-react';
import type { ClientConfigSnippet } from '@shared/types';
import { AUDIO_FILE_RE } from '@shared/audio/formats';
import { refreshMcpStatus, useAgents, useSettings, type AgentTab } from '../../state/status';
import { report, toast } from '../../app/notify';
import { wm } from '../../workspace/WindowManager';
import { cls } from '../../utils/format';
import { cancelChat, resetChat, sendChat, useChat } from './chatStore';
import { AgentFocusBar } from '../../library/FocusChip';
import { clientLabel, copyClientSnippet, installClientSnippet, loadClientConfigs } from './connect';
import { startTour } from '../../tours/store';
import { AGENT_PROVIDERS, modelFor } from '@shared/agent/providers';
import { currentProvider, ProviderSetup, saveProviderKey } from './ProviderSetup';

type Tab = AgentTab;

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function StatusHeader() {
  const mcp = useAgents((s) => s.mcp);
  const [busy, setBusy] = useState(false);
  const enabled = !!mcp?.enabled;
  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.mcp.setEnabled(!enabled);
      if (report(r, enabled ? 'All agents disconnected. New tool calls are refused until you re-enable.' : 'Agents can connect again')) await refreshMcpStatus();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex-shrink-0 border-b border-white/[0.06] p-2.5" data-guide="agent.status">
      <div className="flex items-center gap-2">
        <span className={cls('h-2 w-2 rounded-full', enabled ? 'bg-emerald-400 shadow-[0_0_8px_rgba(34,197,94,0.8)]' : 'bg-rose-400')} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-white">{mcp ? (enabled ? 'MCP server on' : 'Agents disabled') : 'Checking…'}</div>
          <div className="truncate font-mono text-[9px] text-krypt-muted">
            {mcp?.pipeName ?? 'no pipe'}
            {mcp?.http.enabled && mcp.http.url ? ` · ${mcp.http.url}` : ''}
          </div>
        </div>
        <button
          type="button"
          disabled={busy || !mcp}
          onClick={() => void toggle()}
          className={cls(
            'flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition disabled:opacity-50',
            enabled ? 'border-rose-500/50 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25' : 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20',
          )}
          data-hint={enabled ? 'Kill switch: disconnect every agent and refuse new tool calls' : 'Allow agents to connect again'}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : enabled ? <Power className="h-3.5 w-3.5" /> : <Plug className="h-3.5 w-3.5" />}
          {enabled ? 'Kill switch' : 'Re-enable'}
        </button>
      </div>
      {!!mcp?.clients.length && (
        <div className="mt-2 space-y-1">
          {mcp.clients.map((c) => (
            <div key={c.clientId} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1 text-[11px]">
              <Bot className="h-3 w-3 text-krypt-purple" />
              <span className="font-semibold text-white/90">{c.name}</span>
              <span className="text-krypt-muted">connected {ago(c.connectedAt)} ago</span>
              <span className="ml-auto font-mono text-[9px] text-krypt-muted">{c.calls} calls</span>
            </div>
          ))}
        </div>
      )}
      {mcp && !mcp.clients.length && enabled && <div className="mt-1.5 text-[10px] text-krypt-muted">No agent connected. Use “Connect” below to add Krypt Studio to Claude, Cursor and others.</div>}
    </div>
  );
}

function ChatTab() {
  const items = useChat((s) => s.items);
  const streaming = useChat((s) => s.streaming);
  const cost = useChat((s) => s.cost);
  const tokensIn = useChat((s) => s.tokensIn);
  const tokensOut = useChat((s) => s.tokensOut);
  const settings = useSettings((s) => s.settings);
  const [text, setText] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items]);

  const hasKey = !!settings?.agent.hasApiKey;
  const provider = currentProvider(settings?.agent);

  // A song dropped from Explorer: its path goes into the message ("make something like it" → study_reference).
  const [dropping, setDropping] = useState(false);
  const dropFiles = (files: FileList): void => {
    const paths = [...files].map((f) => ({ name: f.name, path: window.krypt.app.pathForFile(f) }));
    const audio = paths.filter((f) => f.path && AUDIO_FILE_RE.test(f.name));
    if (!audio.length) {
      toast.error(paths.length ? 'Drop an audio file (wav, mp3, flac, m4a, ogg, aiff …) to make something like it.' : 'Nothing to drop.');
      return;
    }
    const quoted = audio.map((f) => `"${f.path}"`).join(' ');
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')} ${quoted}` : `Make a song like ${quoted}`));
    toast.success(audio.length === 1 ? `Added "${audio[0].name}": say what you want, then send` : `Added ${audio.length} songs`);
  };

  const send = async (): Promise<void> => {
    if (!text.trim() || streaming) return;
    const t = text;
    setText('');
    const ok = await sendChat(t);
    if (!ok) setText(t);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-guide="agent.chat">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-white/[0.05] px-2.5 py-1.5 text-[10px] text-krypt-muted">
        <button type="button" onClick={() => setShowSetup((v) => !v)} className="flex min-w-0 items-center gap-1.5 hover:text-white" data-hint="Change the AI provider, model or key">
          <Bot className="h-3 w-3 flex-shrink-0 text-krypt-purple" />
          <span className="truncate font-mono">
            {AGENT_PROVIDERS[provider].label.replace(/ (.*)$/, '')} · {settings ? modelFor(settings.agent) : '—'}
          </span>
        </button>
        <span className="ml-auto font-mono" data-hint={`${tokensIn.toLocaleString()} input · ${tokensOut.toLocaleString()} output tokens this session`}>
          {provider === 'openai' ? `${Math.round((tokensIn + tokensOut) / 100) / 10}k tokens` : `$${cost.toFixed(cost < 1 ? 4 : 2)}`}
        </span>
        <button onClick={() => void resetChat()} className="flex items-center gap-1 hover:text-white" data-hint="Start a new conversation">
          <RotateCcw className="h-3 w-3" /> New
        </button>
      </div>

      {(!hasKey || showSetup) && <ProviderSetup />}

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {!items.length && hasKey && (
          <div className="pt-6 text-center text-[11px] text-krypt-muted">
            Ask for a beat, a bassline, a mix fix… Every edit lands in History and can be reverted in one click.
          </div>
        )}
        {items.map((it) => {
          if (it.role === 'user')
            return (
              <div key={it.id} className="ml-8 whitespace-pre-wrap rounded-xl rounded-br-sm border border-krypt-purple/30 bg-krypt-purple/10 px-2.5 py-1.5 text-[12px] text-white">
                {it.text}
              </div>
            );
          if (it.role === 'assistant')
            return (
              <div key={it.id} className="mr-6 whitespace-pre-wrap text-[12px] leading-relaxed text-white/90">
                {it.text}
                {it.pending && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-krypt-purple align-middle" />}
              </div>
            );
          if (it.role === 'tool')
            return (
              <div key={it.id} className="flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-black/30 px-2 py-1 font-mono text-[10px]">
                {it.pending ? <Loader2 className="h-3 w-3 animate-spin text-krypt-muted" /> : it.ok === false ? <Square className="h-3 w-3 text-rose-300" /> : <Check className="h-3 w-3 text-emerald-300" />}
                <Wrench className="h-3 w-3 text-krypt-muted" />
                <span className="text-white/80">{it.tool}</span>
                {it.text && <span className="truncate text-krypt-muted">{it.text}</span>}
              </div>
            );
          return (
            <div key={it.id} className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
              {it.text}
            </div>
          );
        })}
      </div>

      <div className="flex-shrink-0 border-t border-white/[0.06] p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            value={text}
            disabled={!hasKey}
            onChange={(e) => setText(e.target.value)}
            onDragOver={(e) => {
              if (!hasKey || ![...e.dataTransfer.types].includes('Files')) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
              setDropping(true);
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => {
              setDropping(false);
              if (!hasKey || !e.dataTransfer.files.length) return;
              e.preventDefault();
              e.stopPropagation();
              dropFiles(e.dataTransfer.files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={hasKey ? 'Message the studio agent, or drop a song to make something like it (Enter to send)' : 'Add an API key to chat'}
            className={cls(
              'min-h-[44px] flex-1 resize-none rounded-lg border bg-black/40 px-2 py-1.5 text-[12px] text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60 disabled:opacity-50',
              dropping ? 'border-krypt-purple/70 bg-krypt-purple/10' : 'border-white/10',
            )}
          />
          {streaming ? (
            <button
              type="button"
              onClick={() => void cancelChat()}
              className="flex h-[44px] w-10 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25"
              data-hint="Stop the agent"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              disabled={!hasKey || !text.trim()}
              onClick={() => void send()}
              className="flex h-[44px] w-10 items-center justify-center rounded-lg bg-krypt-gradient text-white shadow-krypt-glow disabled:opacity-40 disabled:shadow-none"
              data-hint="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
        {hasKey && (
          <button onClick={() => void saveProviderKey(null, provider)} className="mt-1 text-[9px] text-krypt-muted/70 hover:text-rose-200">
            Remove {AGENT_PROVIDERS[provider].label} key
          </button>
        )}
      </div>
    </div>
  );
}

function ActivityTab() {
  const activity = useAgents((s) => s.activity);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Live tool calls</span>
        <button onClick={() => wm.open('history')} className="flex items-center gap-1 text-[10px] text-krypt-muted hover:text-white" data-hint="Review and revert agent edits">
          <History className="h-3 w-3" /> AI History
        </button>
      </div>
      {!activity.length && <div className="px-1 pt-4 text-center text-[11px] text-krypt-muted">Nothing yet. Tool calls from connected agents stream in here.</div>}
      <div className="space-y-1">
        {activity.map((a, i) => (
          <div key={`${a.time}-${i}`} className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className={cls('h-1.5 w-1.5 rounded-full', a.ok ? 'bg-emerald-400' : 'bg-rose-400')} />
              <span className="font-semibold text-purple-200">{a.clientName}</span>
              <span className="font-mono text-white/70">{a.tool}</span>
              <span className="ml-auto font-mono text-[9px] text-krypt-muted">{ago(a.time)}</span>
            </div>
            <div className={cls('mt-0.5 text-[11px]', a.ok ? 'text-white/80' : 'text-rose-200')}>{a.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectTab() {
  const [configs, setConfigs] = useState<ClientConfigSnippet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadClientConfigs().then((c) => alive && setConfigs(c));
    return () => {
      alive = false;
    };
  }, []);
  const copy = (c: ClientConfigSnippet): Promise<boolean> => copyClientSnippet(c);
  const install = async (c: ClientConfigSnippet): Promise<void> => {
    setBusy(c.client);
    await installClientSnippet(c);
    setBusy(null);
  };
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
      <div className="text-[11px] text-krypt-muted">
        Any MCP client can drive Krypt Studio: write patterns, build mixes, render and listen back. Every edit is tagged with the agent and can be reverted.
      </div>
      {configs === null && (
        <div className="flex items-center gap-2 text-[11px] text-krypt-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      )}
      {configs?.length === 0 && <div className="text-[11px] text-krypt-muted">No connection snippets available (the MCP server isn't running in this build).</div>}
      {configs?.map((c) => (
        <div key={c.client} className="rounded-xl border border-white/10 bg-krypt-panel/80 p-2.5" data-tour-client={c.client}>
          <div className="flex items-center gap-2">
            <Plug className="h-3.5 w-3.5 text-krypt-purple" />
            <span className="text-[12px] font-semibold text-white">{clientLabel(c.client)}</span>
            <div className="ml-auto flex gap-1">
              <button onClick={() => void copy(c)} className="flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/85 hover:border-white/20">
                <ClipboardCopy className="h-3 w-3" /> Copy
              </button>
              {c.installable && (
                <button
                  disabled={busy === c.client}
                  onClick={() => void install(c)}
                  className="flex h-6 items-center gap-1 rounded-md bg-krypt-gradient px-2 text-[10px] font-semibold text-white disabled:opacity-50"
                >
                  {busy === c.client ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Install
                </button>
              )}
            </div>
          </div>
          <div className="mt-1 text-[10px] text-krypt-muted">{c.description}</div>
          <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-white/[0.06] bg-black/50 p-2 font-mono text-[10px] leading-relaxed text-white/80">{c.snippet}</pre>
        </div>
      ))}
    </div>
  );
}

export function AgentPanel() {
  const tab = useAgents((s) => s.agentTab);
  const setTab = (agentTab: Tab) => useAgents.setState({ agentTab });
  const count = useAgents((s) => s.activity.length);
  const tabs: Array<{ id: Tab; label: string; icon: typeof Bot }> = [
    { id: 'chat', label: 'Chat', icon: Bot },
    { id: 'activity', label: `Activity${count ? ` (${count})` : ''}`, icon: Activity },
    { id: 'connect', label: 'Connect', icon: Unplug },
  ];
  return (
    <div className="flex h-full flex-col bg-[#0b0b11]">
      <StatusHeader />
      <AgentFocusBar />
      <div className="flex flex-shrink-0 gap-0.5 border-b border-white/[0.06] px-1.5 pt-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              data-guide={t.id === 'connect' ? 'agent.connect' : undefined}
              onClick={() => setTab(t.id)}
              className={cls(
                'relative flex items-center gap-1.5 px-2.5 pb-1.5 pt-1 text-[11px] font-semibold transition',
                tab === t.id ? 'text-white' : 'text-krypt-muted hover:text-white',
              )}
            >
              <Icon className={cls('h-3 w-3', tab === t.id && 'text-krypt-purple')} />
              {t.label}
              {tab === t.id && <span className="absolute inset-x-1 bottom-0 h-[2px] rounded-t bg-krypt-gradient" />}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => startTour('ai')}
          className="ml-auto mb-1 flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold text-krypt-muted transition hover:bg-white/5 hover:text-white"
          data-hint="Guide me: set up Claude Code, Claude Desktop, Cursor, VS Code or the built-in chat, step by step"
          aria-label="Guide me: set up AI step by step"
        >
          <CircleHelp className="h-3.5 w-3.5 text-krypt-purple" /> Guide me
        </button>
      </div>
      {tab === 'chat' && <ChatTab />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'connect' && <ConnectTab />}
    </div>
  );
}
