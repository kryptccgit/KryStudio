// Home ▸ AI Agents: who is connected, one-click setup for Claude Code /
// Claude Desktop / Cursor / VS Code (the same snippets and installers as
// the Agents panel's Connect tab), how to talk to an agent, and how to undo it.

import { useEffect, useState } from 'react';
import { Bot, Check, ChevronDown, ClipboardCopy, Download, History, MessageSquareText, Mic, Plug, Power, Sparkles, Undo2 } from 'lucide-react';
import type { ClientConfigSnippet } from '@shared/types';
import { refreshMcpStatus, updateSettings, useAgents, useSettings } from '../../state/status';
import { report, toast } from '../../app/notify';
import { clientLabel, copyClientSnippet, installClientSnippet, loadClientConfigs } from '../../panels/agent/connect';
import { cls } from '../../utils/format';
import { runHomeAction } from '../actions';
import { fmtAgo } from '../logic';
import { goBack, openGuides } from '../store';
import { Eyebrow, FOCUS_RING, GlassPanel, HomeButton, IconTile, ScreenFrame, ScreenHeader } from '../ui';

const BLURB: Record<string, string> = {
  'claude-code': 'Runs the setup command for you. Then start a new Claude Code session.',
  'claude-desktop': 'Adds Krypt Studio to its settings (with a backup). Fully quit and reopen Claude Desktop.',
  cursor: 'Adds Krypt Studio to ~/.cursor/mcp.json. Reload Cursor to pick it up.',
  vscode: 'Adds Krypt Studio to your user mcp.json for Copilot agent mode. Reload VS Code.',
};

function StatusPanel() {
  const mcp = useAgents((s) => s.mcp);
  const settings = useSettings((s) => s.settings);
  const [busy, setBusy] = useState(false);
  const enabled = !!mcp?.enabled;
  const clients = mcp?.clients ?? [];
  const allow = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.mcp.setEnabled(true);
      if (report(r, 'Agents can connect again')) {
        if (settings) await updateSettings({ mcp: { ...settings.mcp, enabled: true } });
        await refreshMcpStatus();
      }
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <GlassPanel className="mt-7 p-5" label="Agent status">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cls(
            'h-2.5 w-2.5 flex-shrink-0 rounded-full',
            !mcp ? 'bg-white/25' : !enabled ? 'bg-amber-400' : clients.length ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]' : 'bg-white/35',
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-white">
            {!mcp ? 'Checking…' : !enabled ? 'Agents are switched off' : clients.length ? `${clients.length === 1 ? 'An agent is' : `${clients.length} agents are`} connected` : 'Ready for an agent'}
          </div>
          <div className="text-[12px] text-krypt-muted">
            {!mcp
              ? 'Asking the app…'
              : !enabled
                ? 'The kill switch is on: no agent can connect or make changes until you allow them again.'
                : clients.length
                  ? 'They can see and edit the open project. You will see every change as it happens.'
                  : 'Nothing is connected right now. Set up an app below, then ask it to use krypt-studio.'}
          </div>
        </div>
        {mcp && !enabled ? (
          <HomeButton kind="primary" icon={Plug} onClick={() => void allow()} busy={busy}>
            Allow agents
          </HomeButton>
        ) : (
          <HomeButton kind="ghost" icon={Power} onClick={() => runHomeAction('agentPanel')} title="The Agents panel: activity, the built-in chat and the kill switch">
            Agents panel
          </HomeButton>
        )}
      </div>
      {clients.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-label="Connected agents">
          {clients.map((c) => (
            <li key={c.clientId} className="flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-500/[0.05] px-3 py-2 text-[12.5px]">
              <Bot className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
              <span className="font-semibold text-white">{c.name}</span>
              <span className="text-krypt-muted">connected {fmtAgo(c.connectedAt)}</span>
              <span className="ml-auto font-mono text-[10.5px] text-krypt-muted">
                {c.calls} call{c.calls === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}

function ClientCard({ c }: { c: ClientConfigSnippet }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [show, setShow] = useState(false);
  const label = clientLabel(c.client);
  const install = async (): Promise<void> => {
    setBusy(true);
    const ok = await installClientSnippet(c);
    setBusy(false);
    if (ok) setDone(true);
  };
  return (
    <div className="flex flex-col rounded-2xl border border-white/10 bg-[#0e0e17]/90 p-4 shadow-krypt-card">
      <div className="flex items-start gap-3">
        <IconTile icon={c.client === 'claude-code' ? Sparkles : Plug} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-white">{label}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-krypt-muted">{BLURB[c.client] ?? c.description}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {c.installable && (
          <HomeButton kind={!done && c.client === 'claude-code' ? 'primary' : 'ghost'} icon={done ? Check : Download} onClick={() => void install()} busy={busy} ariaLabel={`Set up ${label}`}>
            {done ? 'Set up again' : 'Set up'}
          </HomeButton>
        )}
        <HomeButton kind="ghost" icon={ClipboardCopy} onClick={() => void copyClientSnippet(c)} ariaLabel={`Copy the ${label} ${c.client === 'claude-code' ? 'command' : 'config'}`}>
          Copy
        </HomeButton>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-expanded={show}
          className={cls('ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-semibold text-krypt-muted hover:text-white', FOCUS_RING)}
        >
          {show ? 'Hide' : c.client === 'claude-code' ? 'Show command' : 'Show config'}
          <ChevronDown className={cls('h-3 w-3 transition', show && 'rotate-180')} />
        </button>
      </div>
      {show && (
        <>
          <p className="mt-2 text-[11px] leading-relaxed text-krypt-muted">{c.description}</p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-white/[0.07] bg-black/50 p-2.5 font-mono text-[10.5px] leading-relaxed text-white/80">{c.snippet}</pre>
        </>
      )}
    </div>
  );
}

function ConnectPanel() {
  const [configs, setConfigs] = useState<ClientConfigSnippet[] | null>(null);
  useEffect(() => {
    let alive = true;
    void loadClientConfigs().then((c) => alive && setConfigs(c));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <section className="mt-6" aria-label="Connect an app">
      <Eyebrow>Connect an app</Eyebrow>
      {configs === null && <p className="mt-3 text-[12.5px] text-krypt-muted">Loading…</p>}
      {configs?.length === 0 && (
        <p className="mt-3 text-[12.5px] text-krypt-muted">Connection snippets aren't available in this build (the agent server isn't running). See the AI agents guide for the manual steps.</p>
      )}
      {!!configs?.length && (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {configs.map((c) => (
            <ClientCard key={c.client} c={c} />
          ))}
        </div>
      )}
    </section>
  );
}

const EXAMPLES = ['“Make a 2-bar trap beat in F#m at 140.”', '“Make the hats bouncier.”', '“The low end sounds muddy. Can you fix it?”', '“Add a breakdown after bar 16.”'];

function TalkPanel() {
  return (
    <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
      <GlassPanel className="p-5 lg:col-span-2" label="Just talk to it">
        <div className="flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-krypt-purple" aria-hidden="true" />
          <h2 className="text-[14px] font-semibold text-white">Just talk to it</h2>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-krypt-muted">
          No special words needed. Ask the way you would ask a producer friend. The agent edits your project live, then can render it and listen back to check its own work.
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {EXAMPLES.map((e) => (
            <li key={e} className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-[12.5px] text-white/85">
              {e}
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-krypt-muted">
          <p className="flex items-start gap-2">
            <Mic className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" aria-hidden="true" />
            <span>
              In Claude Code, type <code className="rounded bg-black/40 px-1 font-mono text-[11.5px] text-white/85">/voice</code> and hold Space to say it out loud.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" aria-hidden="true" />
            <span>
              Or start from a recipe: <code className="rounded bg-black/40 px-1 font-mono text-[11.5px] text-white/85">/krypt-studio:beat</code> asks for a genre, a tempo and a key.
            </span>
          </p>
        </div>
      </GlassPanel>
      <div className="flex flex-col gap-3">
        <GlassPanel className="flex-1 p-5" label="Undo anything">
          <div className="flex items-center gap-2">
            <Undo2 className="h-4 w-4 text-krypt-purple" aria-hidden="true" />
            <h2 className="text-[14px] font-semibold text-white">Undo anything</h2>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-krypt-muted">Every agent change is in History with its name. One click reverts all of it and keeps your own edits.</p>
          <HomeButton kind="ghost" icon={History} className="mt-3" onClick={() => runHomeAction('history')}>
            Open History
          </HomeButton>
        </GlassPanel>
        <GlassPanel className="flex-1 p-5" label="Built-in chat">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-krypt-purple" aria-hidden="true" />
            <h2 className="text-[14px] font-semibold text-white">Built-in chat</h2>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-krypt-muted">Chat inside Krypt Studio with your own key from Anthropic (Claude), OpenAI (ChatGPT) or OpenRouter, stored encrypted on this PC.</p>
          <HomeButton kind="ghost" icon={MessageSquareText} className="mt-3" onClick={() => runHomeAction('agentPanel')}>
            Open the chat
          </HomeButton>
        </GlassPanel>
      </div>
    </div>
  );
}

export function AgentsScreen() {
  return (
    <ScreenFrame label="AI Agents">
      <ScreenHeader
        icon={Bot}
        title="AI Agents"
        subtitle="Let Claude Code, Claude Desktop, Cursor or VS Code work in your project with you."
        onBack={goBack}
        right={
          <HomeButton kind="quiet" onClick={() => openGuides('ai-agents')} className="mt-1">
            Read the guide
          </HomeButton>
        }
      />
      <StatusPanel />
      <ConnectPanel />
      <TalkPanel />
      <p className="mt-5 text-center text-[11.5px] leading-relaxed text-krypt-muted">
        Agents reach Krypt Studio only on this PC. What an agent reads from your project goes to the AI service of the app you use, under that app's terms. Krypt Studio itself sends nothing.
      </p>
    </ScreenFrame>
  );
}
