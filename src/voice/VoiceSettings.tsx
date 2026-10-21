import { useEffect, useState } from 'react';
import { BrainCircuit, Check, Cloud, Cpu, ExternalLink, KeyRound, Loader2, Mic, ShieldAlert, Trash2, TriangleAlert, UserRound } from 'lucide-react';
import { cls } from '../utils/format';
import { FISH_PRIVACY, fishKeyError, groupVoices } from './logic';
import { useVoice } from './store';
import { ensureVoiceState, openFishSite, openModelManager, removeMyVoice, saveFishKey } from './actions';
import { CloudBadge, LocalBadge, small } from './parts';
import { openRecordVoice } from './RecordVoiceDialog';

const card = 'rounded-xl border border-white/10 bg-black/20 px-3 py-2.5';

export function VoiceSettings() {
  const state = useVoice((s) => s.state);
  const status = useVoice((s) => s.status);
  const stateError = useVoice((s) => s.stateError);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    void ensureVoiceState();
  }, []);

  const keySet = !!state?.fish.keySet;
  const mine = groupVoices(state?.voices ?? []).mine;
  const shapeErr = key ? fishKeyError(key) : null;

  const save = async (value: string | null): Promise<void> => {
    setBusy(value === null ? 'remove' : 'save');
    setResult(null);
    try {
      const r = await saveFishKey(value);
      setResult(r);
      if (r.ok) setKey('');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      {status === 'failed' && stateError && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-100">
          <TriangleAlert size={13} className="text-rose-300" /> {stateError}
        </div>
      )}

      <div className={card}>
        <div className="flex items-center gap-2">
          <Cpu size={13} className="text-emerald-300" />
          <span className="text-[12px] font-semibold text-white">Local voices (Kokoro)</span>
          <LocalBadge />
          <span className={cls('ml-auto text-[11px]', state?.local.installed ? 'text-emerald-300' : 'text-amber-300')}>
            {!state ? 'Checking…' : state.local.installed ? 'Installed' : 'Not installed'}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-krypt-muted">
          <span className="min-w-0 flex-1">{state?.local.message || 'Free, offline, and nothing leaves this PC. English voices first.'}</span>
          {state && !state.local.installed && (
            <button type="button" className={small} onClick={openModelManager}>
              <BrainCircuit size={12} /> Install in Model Manager
            </button>
          )}
        </div>
      </div>

      <div className={card}>
        <div className="flex items-center gap-2">
          <Cloud size={13} className="text-sky-300" />
          <span className="text-[12px] font-semibold text-white">Fish Audio key</span>
          <CloudBadge />
          <span className={cls('ml-auto flex items-center gap-1 text-[11px]', keySet ? 'text-emerald-300' : 'text-krypt-muted')}>
            {keySet ? (
              <>
                <Check size={12} /> Key saved
              </>
            ) : (
              'No key'
            )}
          </span>
        </div>
        <div className="mt-1 text-[10.5px] text-krypt-muted">Cloud voices and My voice use your own key. Stored encrypted on this PC and only sent to Fish Audio. Agents never see it.</div>
        <div className="mt-2 flex gap-1.5">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && !busy && void save(key)}
            placeholder={keySet ? 'Paste a new key to replace it' : 'Paste your Fish Audio API key'}
            autoComplete="off"
            spellCheck={false}
            aria-label="Fish Audio API key"
            className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2 font-mono text-[11px] text-white outline-none focus:border-krypt-purple/60"
          />
          <button type="button" disabled={!key.trim() || !!busy} onClick={() => void save(key)} className="inline-flex h-7 items-center gap-1 rounded-md bg-krypt-gradient px-3 text-[11px] font-semibold text-white disabled:opacity-40">
            {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
            {busy === 'save' ? 'Checking…' : 'Save'}
          </button>
          {keySet && (
            <button type="button" disabled={!!busy} onClick={() => void save(null)} className={cls(small, 'h-7')}>
              {busy === 'remove' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Remove
            </button>
          )}
        </div>
        {shapeErr && <div className="mt-1 text-[10.5px] text-amber-200/90">{shapeErr}</div>}
        {result && (
          <div className={cls('mt-1.5 flex items-center gap-1.5 text-[11px]', result.ok ? 'text-emerald-300' : 'text-rose-300')} role="status">
            {result.ok ? <Check size={12} /> : <TriangleAlert size={12} />} {result.message}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className={small} onClick={() => void openFishSite()}>
            <ExternalLink size={12} /> Get a free key at fish.audio
          </button>
        </div>
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-sky-400/20 bg-sky-500/[0.06] px-2 py-1.5 text-[10.5px] leading-snug text-sky-100/85">
          <ShieldAlert size={12} className="mt-px flex-shrink-0 text-sky-300" />
          <span>{FISH_PRIVACY}</span>
        </div>
      </div>

      <div className={card}>
        <div className="flex items-center gap-2">
          <UserRound size={13} className="text-krypt-purple" />
          <span className="text-[12px] font-semibold text-white">My voices</span>
          <span className="ml-auto">
            <button type="button" className={small} disabled={!keySet} onClick={() => openRecordVoice()} title={keySet ? 'Record 30 seconds of your own voice' : 'Add your Fish Audio key first'}>
              <Mic size={12} /> Record my voice…
            </button>
          </span>
        </div>
        <div className="mt-1 text-[10.5px] text-krypt-muted">Only your own voice, recorded live in Krypt Studio. Stored as a private voice on your Fish Audio account.</div>
        {mine.length > 0 && (
          <ul className="mt-2 space-y-1">
            {mine.map((v) => (
              <li key={v.id} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1 text-[11px]">
                <UserRound size={12} className="text-krypt-pink" />
                <span className="font-semibold text-white/90">{v.name}</span>
                <span className="truncate text-krypt-muted">{v.description}</span>
                <button
                  type="button"
                  className={cls(small, 'ml-auto h-6')}
                  disabled={removing === v.id}
                  onClick={async () => {
                    setRemoving(v.id);
                    try {
                      await removeMyVoice(v);
                    } finally {
                      setRemoving(null);
                    }
                  }}
                >
                  {removing === v.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />} Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
