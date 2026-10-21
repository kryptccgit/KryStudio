import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound } from 'lucide-react';
import { AGENT_PROVIDERS, AGENT_PROVIDER_IDS, keyProblem, modelFor, type AgentProvider } from '@shared/agent/providers';
import { updateSettings, useSettings } from '../../state/status';
import { report, toast } from '../../app/notify';
import { cls } from '../../utils/format';
import { resetChat } from './chatStore';

export function currentProvider(agent: { provider?: AgentProvider } | undefined): AgentProvider {
  return agent?.provider ?? 'anthropic';
}

export async function saveProviderKey(value: string | null, p: AgentProvider): Promise<boolean> {
  try {
    const r = await window.krypt.agent.setApiKey(value, p);
    if (!report(r, value ? `${AGENT_PROVIDERS[p].label} key saved (stored encrypted on this PC)` : `${AGENT_PROVIDERS[p].label} key removed`)) return false;
    useSettings.setState({ settings: await window.krypt.settings.get() });
    return true;
  } catch (err) {
    toast.error((err as Error).message);
    return false;
  }
}

export function ProviderSetup() {
  const settings = useSettings((s) => s.settings);
  const agent = settings?.agent;
  const p = currentProvider(agent);
  const info = AGENT_PROVIDERS[p];
  const hasKey = !!agent?.keys?.[p] || (agent?.hasApiKey ?? false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(agent ? modelFor(agent, p) : info.defaultModel);
  useEffect(() => setModel(agent ? modelFor(agent, p) : info.defaultModel), [p, agent, info.defaultModel]);
  if (!settings || !agent) return null;

  const pick = async (next: AgentProvider): Promise<void> => {
    if (next === p) return;
    if (await updateSettings({ agent: { ...agent, provider: next } }, `Built-in chat: ${AGENT_PROVIDERS[next].label}`)) await resetChat();
  };
  const saveModel = (): void => {
    const m = model.trim();
    if (!m || m === modelFor(agent, p)) return;
    void updateSettings({ agent: { ...agent, models: { ...(agent.models ?? {}), [p]: m } } }, `Model: ${m}`);
  };
  const saveKey = async (): Promise<void> => {
    const k = key.trim();
    const problem = keyProblem(p, k);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    if (await saveProviderKey(k, p)) setKey('');
    setSaving(false);
  };

  return (
    <div className="m-2.5 space-y-2 rounded-xl border border-white/10 bg-krypt-panel/80 p-3">
      <div className="flex items-center gap-1" role="radiogroup" aria-label="AI provider for the built-in chat">
        {AGENT_PROVIDER_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === p}
            onClick={() => void pick(id)}
            className={cls('h-7 flex-1 rounded-md border px-1.5 text-[10.5px] font-semibold transition', id === p ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-black/30 text-krypt-muted hover:text-white')}
            data-hint={`Chat with ${AGENT_PROVIDERS[id].label} using your own key${agent.keys?.[id] ? ' (key saved)' : ''}`}
          >
            {AGENT_PROVIDERS[id].label}
            {agent.keys?.[id] && <span className="ml-1 text-emerald-300">•</span>}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-[10.5px] text-krypt-muted">
        Model
        <input
          value={model}
          list={`agent-models-${p}`}
          onChange={(e) => setModel(e.target.value)}
          onBlur={saveModel}
          onKeyDown={(e) => e.key === 'Enter' && saveModel()}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2 font-mono text-[10.5px] text-white outline-none focus:border-krypt-purple/60"
        />
        <datalist id={`agent-models-${p}`}>
          {info.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {!hasKey && (
        <div data-guide="agent.apiKey">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-white">
            <KeyRound className="h-3.5 w-3.5 text-krypt-purple" /> Add your {info.label} API key
            <button type="button" onClick={() => void window.krypt.app.openExternal(info.keyUrl).then((r) => report(r))} className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-semibold text-krypt-muted hover:text-white">
              Get a key <ExternalLink className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-1 text-[11px] text-krypt-muted">The built-in chat uses your own key. It's stored encrypted on this PC and only sent to {info.label.replace(/ \(.*\)$/, '')}. External agents over MCP don't need it.</div>
          <div className="mt-2 flex gap-1.5">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key.trim() && void saveKey()}
              placeholder={info.keyHint}
              className="h-7 flex-1 rounded-md border border-white/10 bg-black/40 px-2 font-mono text-[11px] text-white outline-none focus:border-krypt-purple/60"
            />
            <button type="button" disabled={!key.trim() || saving} onClick={() => void saveKey()} className="h-7 rounded-md bg-krypt-gradient px-3 text-[11px] font-semibold text-white disabled:opacity-40">
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
