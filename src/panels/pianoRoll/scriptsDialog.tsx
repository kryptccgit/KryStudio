// ──────────────────────────────────────────────────────────────────────
// Piano roll ▸ Tools ▸ Scripts…: Krypt Script note devices (shared/scripts).
// Pick a script (factory, your library, this project), turn its knobs, see
// the result drawn on the roll (preview), pick one of 4 Variations (seeds)
// and Apply = ONE undo step. The code view edits the JavaScript, checks it
// (line-numbered errors) and saves it into the project or your library.
// Scripts never run here: every run is an IPC call to main, which runs it in
// the QuickJS sandbox (electron/scripts/sandbox.ts).
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Braces, CircleAlert, Dice5, FlaskConical, FolderOpen, Library, Plus, Save, type LucideIcon } from 'lucide-react';
import { NOTE_NAMES_SHARP, SCALES } from '@shared/music/theory';
import { ticksPerBar } from '@shared/schema/time';
import { patternLength } from '@shared/schema/project';
import { variationSeed } from '@shared/music/generate';
import { parseScriptHeader, resolveParams } from '@shared/scripts/header';
import { NEW_SCRIPT_TEMPLATE } from '@shared/scripts/factory';
import type { ScriptCatalog, ScriptHeader, ScriptInfo, ScriptIssue, ScriptParam, ScriptParamValues, ScriptPlan, ScriptRunRequest } from '@shared/scripts/types';
import { dispatch, getProject } from '../../doc/store';
import { Check, DialogForm, DialogSelect, Field, NumberBox, Segmented, openDialog } from '../../components/Dialog';
import { Knob } from '../../controls/Knob';
import { flashHint } from '../../app/hints';
import { toast } from '../../app/notify';
import { cls } from '../../utils/format';
import type { PianoRollController } from './controller';
import { usePianoRollView } from './store';

// ── Remembered settings (session) ─────────────────────────────────────

interface ScriptPrefs {
  scriptId: string;
  seed: number;
  mode: 'replace' | 'merge';
  key: { root: number; scale: string } | null;
  params: Record<string, ScriptParamValues>;
  codeOpen: boolean;
}

const newSeed = (): number => Math.floor(Math.random() * 2 ** 31);
const usePrefs = create<ScriptPrefs>(() => ({ scriptId: 'factory:euclid-chance', seed: newSeed(), mode: 'replace', key: null, params: {}, codeOpen: false }));

const SCALE_LABELS: Record<string, string> = {
  major: 'Major',
  minor: 'Minor',
  harmonicMinor: 'Harmonic minor',
  melodicMinor: 'Melodic minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  locrian: 'Locrian',
  majorPentatonic: 'Major pentatonic',
  minorPentatonic: 'Minor pentatonic',
  blues: 'Blues',
  chromatic: 'Chromatic',
};

const SOURCE_LABEL: Record<ScriptInfo['source'], string> = { factory: 'Factory', user: 'My library', project: 'This project' };

// ── Small pieces ──────────────────────────────────────────────────────

function SmallButton({ icon: Icon, label, onClick, title, active, disabled }: { icon: LucideIcon; label: string; onClick: () => void; title?: string; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cls(
        'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition disabled:opacity-40',
        active ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/5 text-white/85 hover:border-white/20',
      )}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

const fmt = (p: Extract<ScriptParam, { type: 'number' }>, v: number): string => {
  const decimals = p.step >= 1 ? 0 : p.step >= 0.1 ? 1 : 2;
  return v.toFixed(decimals);
};

function ParamControls({ header, values, onChange }: { header: ScriptHeader; values: ScriptParamValues; onChange: (id: string, v: number | string | boolean) => void }) {
  const numbers = header.params.filter((p): p is Extract<ScriptParam, { type: 'number' }> => p.type === 'number');
  const others = header.params.filter((p) => p.type !== 'number');
  if (!header.params.length) return <div className="text-[11px] text-krypt-muted">This script has no knobs.</div>;
  return (
    <div className="space-y-2.5" data-guide="scripts.params">
      {numbers.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-2">
          {numbers.map((p) => {
            const v = Number(values[p.id] ?? p.default);
            const span = p.max - p.min;
            const steps = Math.round(span / p.step);
            return (
              <div key={p.id} className="flex w-[68px] flex-col items-center gap-0.5">
                <Knob
                  value={(v - p.min) / span}
                  defaultValue={(p.default - p.min) / span}
                  display={fmt(p, v)}
                  label={p.label}
                  showLabel
                  size={34}
                  steps={steps > 0 && steps <= 4000 ? steps : undefined}
                  bipolar={p.min < 0 && p.max > 0}
                  onChange={(norm) => onChange(p.id, Math.round((p.min + Math.round((norm * span) / p.step) * p.step) * 1e6) / 1e6)}
                  onReset={() => onChange(p.id, p.default)}
                />
                <div className="font-mono text-[10px] text-white/70">{fmt(p, v)}</div>
              </div>
            );
          })}
        </div>
      )}
      {others.map((p) =>
        p.type === 'choice' ? (
          <Field key={p.id} label={p.label}>
            {p.options.length <= 5 && p.options.join('').length <= 36 ? (
              <Segmented size="sm" value={String(values[p.id] ?? p.default)} onChange={(v) => onChange(p.id, v)} options={p.options.map((o) => ({ value: o, label: o }))} />
            ) : (
              <DialogSelect value={String(values[p.id] ?? p.default)} options={p.options.map((o) => ({ value: o, label: o }))} onChange={(v) => onChange(p.id, v)} width={150} />
            )}
          </Field>
        ) : p.type === 'toggle' ? (
          <Check key={p.id} checked={Boolean(values[p.id] ?? p.default)} onChange={(v) => onChange(p.id, v)} label={p.label} />
        ) : null,
      )}
    </div>
  );
}

/** A tiny piano-roll drawing of one take. */
function Thumb({ plan }: { plan: ScriptPlan }) {
  const W = 120;
  const H = 46;
  const { start, end } = plan.range;
  const keys = plan.notes.map((n) => n.key);
  const lo = Math.min(...keys) - 1;
  const hi = Math.max(...keys) + 1;
  const rowH = Math.max(1.5, Math.min(5, (H - 4) / Math.max(1, hi - lo)));
  const y = (k: number): number => H - 2 - ((k - lo) / Math.max(1, hi - lo)) * (H - 4) - rowH / 2;
  const span = Math.max(1, Math.max(end, ...plan.notes.map((n) => n.tick + n.dur)) - start);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[46px]">
      {plan.notes.map((n, i) => (
        <rect key={i} x={((n.tick - start) / span) * W} y={y(n.key)} width={Math.max(1, (n.dur / span) * W - 0.3)} height={rowH} rx={0.6} fill="url(#krypt-script-grad)" opacity={0.45 + 0.55 * n.vel} />
      ))}
    </svg>
  );
}

function Variations({ results, seeds, current, onPick }: { results: Array<{ ok: boolean; data?: ScriptPlan; message?: string }>; seeds: number[]; current: number; onPick: (seed: number) => void }) {
  return (
    <div data-guide="scripts.variations">
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="krypt-script-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#6366F1" />
            <stop offset="50%" stopColor="#A855F7" />
            <stop offset="100%" stopColor="#EC4899" />
          </linearGradient>
        </defs>
      </svg>
      <div className="grid grid-cols-4 gap-1.5">
        {seeds.map((s, i) => {
          const r = results[i];
          const plan = r?.ok ? r.data : undefined;
          return (
            <button
              key={s}
              type="button"
              title={plan ? `Apply this take (seed ${s}): ${plan.notes.length} notes` : r?.message ?? 'Running…'}
              disabled={!plan}
              onClick={() => onPick(s)}
              className={cls(
                'overflow-hidden rounded-lg border bg-black/40 p-1 text-left transition hover:border-krypt-purple/60 hover:bg-krypt-purple/10 disabled:opacity-40',
                s === current ? 'border-krypt-purple/50' : 'border-white/10',
              )}
            >
              {plan && plan.notes.length ? <Thumb plan={plan} /> : <div className="h-[46px]" />}
              <div className="mt-0.5 flex items-center justify-between px-0.5 font-mono text-[9px] text-krypt-muted">
                <span>{i === 0 ? 'this take' : `take ${i + 1}`}</span>
                <span>{plan ? plan.notes.length : '–'}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The code view: a monospace textarea, Check, Save to project / library, and the issues with their lines. */
function CodeView({
  code,
  setCode,
  issues,
  onCheck,
  onSaveProject,
  onSaveLibrary,
  onNew,
  onReveal,
  busy,
}: {
  code: string;
  setCode: (c: string) => void;
  issues: ScriptIssue[];
  onCheck: () => void;
  onSaveProject: () => void;
  onSaveLibrary: () => void;
  onNew: () => void;
  onReveal: () => void;
  busy: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const goto = (line: number): void => {
    const el = ta.current;
    if (!el || line < 1) return;
    const lines = el.value.split('\n');
    const start = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    el.scrollTop = Math.max(0, (line - 4) * 15);
  };
  return (
    <div className="space-y-1.5" data-guide="scripts.code">
      <textarea
        ref={ta}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const el = e.currentTarget;
            const s = el.selectionStart;
            setCode(`${el.value.slice(0, s)}  ${el.value.slice(el.selectionEnd)}`);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
          e.stopPropagation();
        }}
        spellCheck={false}
        wrap="off"
        rows={16}
        className="block w-full resize-y rounded-lg border border-white/10 bg-black/50 p-2 font-mono text-[11px] leading-[15px] text-white/90 outline-none focus:border-krypt-purple/60"
      />
      {issues.length > 0 && (
        <div className="max-h-24 space-y-0.5 overflow-auto rounded-lg border border-amber-400/30 bg-amber-400/5 p-1.5">
          {issues.map((i, k) => (
            <button key={k} type="button" onClick={() => goto(i.line)} className="flex w-full items-start gap-1.5 text-left text-[10.5px] text-amber-200 hover:text-white">
              <CircleAlert size={12} className="mt-[1px] shrink-0" />
              <span>
                {i.line > 0 && <span className="font-mono">Line {i.line}: </span>}
                {i.message}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <SmallButton icon={FlaskConical} label="Check" title="Check the header, compile and try it once" onClick={onCheck} disabled={busy} />
        <SmallButton icon={Save} label="Save to project" title="Keep this script in the song (one undo step)" onClick={onSaveProject} disabled={busy} />
        <SmallButton icon={Library} label="Save to my library" title="Keep it for every project (userData/scripts)" onClick={onSaveLibrary} disabled={busy} />
        <SmallButton icon={Plus} label="New" title="Start from a small example" onClick={onNew} />
        <SmallButton icon={FolderOpen} label="Library folder" title="Open your script library folder" onClick={onReveal} />
      </div>
    </div>
  );
}

// ── The dialog ────────────────────────────────────────────────────────

function ScriptsBody({ ctl, close, initialRange }: { ctl: PianoRollController; close: () => void; initialRange: { fromBar: number; bars: number } }) {
  const p = usePrefs();
  const set = (patch: Partial<ScriptPrefs>): void => usePrefs.setState(patch);
  const [catalog, setCatalog] = useState<ScriptCatalog | null>(null);
  const [range, setRange] = useState(initialRange);
  const [draft, setDraft] = useState<string | null>(null);
  const [issues, setIssues] = useState<ScriptIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ ok: boolean; data?: ScriptPlan; message?: string }>>([]);
  const [saveName, setSaveName] = useState('');

  const reload = async (select?: string): Promise<void> => {
    try {
      const c = await window.krypt.scripts.list();
      setCatalog(c);
      if (select) set({ scriptId: select });
    } catch (e) {
      toast.error(`Couldn't list the scripts: ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const all = useMemo(() => (catalog ? [...catalog.project, ...catalog.user, ...catalog.factory] : []), [catalog]);
  const current = all.find((s) => s.id === p.scriptId) ?? (catalog ? catalog.factory[0] : undefined);
  const code = draft ?? current?.code ?? '';
  const edited = draft !== null && draft !== current?.code;
  const parsed = useMemo(() => parseScriptHeader(code), [code]);
  const header = parsed.ok ? parsed.header : current?.header ?? null;
  const values = useMemo(() => {
    if (!header) return {};
    const r = resolveParams(header, p.params[p.scriptId], false);
    return r.ok ? r.params : {};
  }, [header, p.params, p.scriptId]);

  const target = ctl.getTarget();
  const req = (seed: number): ScriptRunRequest | null =>
    target && (edited || current)
      ? {
          script: edited || !current ? { code } : { id: current.id },
          patternId: target.patternId,
          channelId: target.channelId,
          ids: ctl.selectedIds(),
          range,
          mode: p.mode,
          params: values,
          seed,
          ...(p.key ? { key: p.key } : {}),
        }
      : null;
  const seeds = [0, 1, 2, 3].map((i) => variationSeed(p.seed, i));
  const reqKey = JSON.stringify(req(p.seed));

  // previews: the 4 takes (the first one drawn on the roll), debounced while typing / turning knobs
  const runSeq = useRef(0);
  useEffect(() => {
    const r = req(p.seed);
    if (!r || (edited && !parsed.ok)) {
      ctl.clearPreview();
      setResults([]);
      if (edited && !parsed.ok) setIssues(parsed.issues);
      return;
    }
    const n = ++runSeq.current;
    const timer = window.setTimeout(() => {
      void window.krypt.scripts.preview(r, seeds).then(
        (out) => {
          if (n !== runSeq.current) return;
          setResults(out);
          const first = out[0];
          if (first?.ok && first.data) ctl.showPlannedNotes(first.data);
          else ctl.clearPreview();
        },
        (e: unknown) => {
          if (n === runSeq.current) setResults([{ ok: false, message: (e as Error).message }]);
        },
      );
    }, edited ? 350 : 60);
    return () => window.clearTimeout(timer);
    // compared by value (reqKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, reqKey]);

  // a run error with a line shows in the code view too
  const err = results[0] && !results[0].ok ? results[0].message ?? 'The script failed' : null;
  useEffect(() => {
    if (!edited || !parsed.ok) return;
    const m = err?.match(/ line (\d+): (.*)$/s);
    setIssues(err ? [{ line: m ? Number(m[1]) : 0, message: m ? m[2] : err }] : []);
  }, [err, edited, parsed.ok]);

  const apply = async (seed: number): Promise<void> => {
    const r = req(seed);
    if (!r) {
      flashHint('Select a pattern and a channel first', 'warn');
      return;
    }
    setBusy(true);
    const out = await window.krypt.scripts.apply(r).catch((e: unknown) => ({ ok: false, message: (e as Error).message, data: undefined }));
    setBusy(false);
    if (!out.ok || !out.data) {
      toast.error(out.message ?? 'The script failed');
      return;
    }
    ctl.clearPreview();
    ctl.selectIds(out.data.ids);
    flashHint(out.message ?? 'Done', 'ok');
    if (seed !== p.seed) set({ seed });
    close();
    ctl.focus();
  };

  const check = async (): Promise<void> => {
    setBusy(true);
    const c = await window.krypt.scripts.check(code, { trial: true });
    setBusy(false);
    setIssues(c.issues);
    if (c.ok) flashHint(`"${c.header?.name}" looks good: header, syntax and a test run passed`, 'ok');
    else toast.warn(`${c.issues.length} problem${c.issues.length === 1 ? '' : 's'} in the script: see the lines under the code`);
  };

  const saveProject = async (): Promise<void> => {
    setBusy(true);
    const c = await window.krypt.scripts.check(code, { trial: true });
    if (!c.ok) {
      setBusy(false);
      setIssues(c.issues);
      toast.warn('Fix the problems under the code first');
      return;
    }
    const r = await dispatch<{ id: string; name: string; created: boolean }>('scripts.save', { code, ...(saveName.trim() ? { name: saveName.trim() } : {}), ...(current?.source === 'project' && !saveName.trim() ? { id: current.id } : {}) }, { label: 'Save script' });
    setBusy(false);
    if (r.ok && r.data) {
      flashHint(`${r.data.created ? 'Saved' : 'Updated'} "${r.data.name}" in this project`, 'ok');
      setDraft(null);
      setIssues([]);
      await reload(r.data.id);
    }
  };

  const saveLibrary = async (): Promise<void> => {
    setBusy(true);
    const c = await window.krypt.scripts.check(code, { trial: true });
    if (!c.ok) {
      setBusy(false);
      setIssues(c.issues);
      toast.warn('Fix the problems under the code first');
      return;
    }
    const r = await window.krypt.scripts.saveToLibrary(code, saveName.trim() || undefined);
    setBusy(false);
    if (!r.ok || !r.data) {
      toast.error(r.message ?? "Couldn't save the script");
      return;
    }
    toast.success(r.message ?? 'Saved');
    setDraft(null);
    setIssues([]);
    await reload(r.data.id);
  };

  const options = all.map((s) => ({ value: s.id, label: `${SOURCE_LABEL[s.source]} · ${s.name}${s.header ? '' : ' (has errors)'}` }));
  const plan = results[0]?.ok ? results[0].data : undefined;
  const summary = plan
    ? `${plan.notes.length} notes · bar${plan.range.bars === 1 ? ` ${plan.range.fromBar}` : `s ${plan.range.fromBar}–${plan.range.fromBar + plan.range.bars - 1}`} · ${plan.keyName}${plan.remove.length ? ` · replaces ${plan.remove.length}` : ''} · ${plan.ms} ms${plan.logs.length ? ` · log: ${plan.logs[plan.logs.length - 1]}` : ''} · one undo step`
    : null;

  return (
    <DialogForm
      busy={busy}
      submitLabel="Apply"
      submitDisabled={!plan}
      onCancel={close}
      onSubmit={() => void apply(p.seed)}
      extra={err ? <span className="text-amber-300">{err}</span> : <span>{summary ?? (catalog ? 'Running the script…' : 'Loading scripts…')}</span>}
    >
      <Field label="Script" hint={header?.description || (current && !current.header ? 'This script has errors: open the code' : undefined)} wide>
        <div className="flex gap-1.5" data-guide="scripts.picker">
          <DialogSelect
            value={current?.id ?? ''}
            options={options.length ? options : [{ value: '', label: 'Loading…' }]}
            onChange={(scriptId) => {
              set({ scriptId });
              setDraft(null);
              setIssues([]);
            }}
            width={300}
          />
          <SmallButton icon={Braces} label={p.codeOpen ? 'Hide code' : 'Code'} title="Read or edit the JavaScript" active={p.codeOpen} onClick={() => set({ codeOpen: !p.codeOpen })} />
        </div>
      </Field>
      {header && (
        <div className="text-[10px] text-krypt-muted">
          {header.kind === 'generator' ? 'Generator: writes notes into the bars' : ctl.selectionSize ? `Transform: changes the ${ctl.selectionSize} selected notes` : "Transform: changes the channel's notes in the bars"}
          {edited ? ' · edited, not saved' : ''}
        </div>
      )}
      {p.codeOpen && (
        <CodeView
          code={code}
          setCode={(c) => setDraft(c)}
          issues={issues}
          busy={busy}
          onCheck={() => void check()}
          onSaveProject={() => void saveProject()}
          onSaveLibrary={() => void saveLibrary()}
          onNew={() => {
            setDraft(NEW_SCRIPT_TEMPLATE);
            setIssues([]);
          }}
          onReveal={() => void window.krypt.scripts.revealLibrary().then((r) => (r.ok ? flashHint(r.message ?? 'Opened', 'ok') : toast.error(r.message ?? "Couldn't open the folder")))}
        />
      )}
      {p.codeOpen && (
        <Field label="Save as" hint="Name for Save (empty = the @name in the header)">
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            maxLength={64}
            placeholder={header?.name ?? 'My device'}
            className="h-7 w-[200px] rounded-lg border border-white/10 bg-black/40 px-2 text-[11px] text-white outline-none focus:border-krypt-purple/60"
          />
        </Field>
      )}
      <div className="h-px bg-white/[0.06]" />
      {header ? <ParamControls header={header} values={values} onChange={(id, v) => set({ params: { ...p.params, [p.scriptId]: { ...values, [id]: v } } })} /> : <div className="text-[11px] text-amber-300">Fix the header to get the knobs back.</div>}
      <div className="h-px bg-white/[0.06]" />
      <Field label="Bars" hint={ctl.selectionSize ? 'Default: the bars of the selection' : 'Default: the whole pattern'}>
        <div className="flex items-center gap-1.5 text-[11px] text-krypt-muted">
          from
          <NumberBox value={range.fromBar} min={1} max={4096} onChange={(fromBar) => setRange((r) => ({ ...r, fromBar }))} width={46} />
          for
          <NumberBox value={range.bars} min={1} max={256} onChange={(bars) => setRange((r) => ({ ...r, bars }))} width={46} />
        </div>
      </Field>
      {header?.kind === 'generator' && (
        <Field label="Existing notes" hint={p.mode === 'replace' ? 'Replaced in these bars' : 'Kept; new notes are added'}>
          <Segmented
            size="sm"
            value={p.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: 'replace', label: 'Replace' },
              { value: 'merge', label: 'Merge' },
            ]}
          />
        </Field>
      )}
      <Field label="Key" hint={p.key ? undefined : 'Auto: the key of this pattern'}>
        <div className="flex gap-1.5">
          <DialogSelect
            value={p.key ? p.key.root : -1}
            options={[{ value: -1, label: 'Auto' }, ...NOTE_NAMES_SHARP.map((n, i) => ({ value: i, label: n }))]}
            onChange={(root) => set({ key: root < 0 ? null : { root, scale: p.key?.scale ?? 'minor' } })}
            width={72}
          />
          {p.key && <DialogSelect value={p.key.scale} options={Object.keys(SCALES).map((s) => ({ value: s, label: SCALE_LABELS[s] ?? s }))} onChange={(scale) => set({ key: { root: p.key!.root, scale } })} width={140} />}
        </div>
      </Field>
      <Field label="Seed" hint="Same seed = same notes">
        <div className="flex items-center gap-1.5">
          <NumberBox value={p.seed} min={0} max={2147483647} onChange={(seed) => set({ seed })} width={96} />
          <SmallButton icon={Dice5} label="Re-roll" title="A new take" onClick={() => set({ seed: newSeed() })} />
        </div>
      </Field>
      <Field label="Variations" hint="Four takes; click one to apply it" wide>
        <Variations results={results} seeds={seeds} current={p.seed} onPick={(s) => void apply(s)} />
      </Field>
    </DialogForm>
  );
}

/** Default bar range: the selection's bars, else the whole pattern. */
function defaultRange(ctl: PianoRollController): { fromBar: number; bars: number } {
  const p = getProject();
  const t = ctl.getTarget();
  const ts = p?.transport.timeSig ?? { num: 4, den: 4 };
  const bar = ticksPerBar(ts);
  const pat = t && p ? p.patterns[t.patternId] : undefined;
  const sel = ctl.selectionSize ? ctl.scopeNotes() : [];
  if (sel.length) {
    const s = Math.floor(Math.min(...sel.map((n) => n.tick)) / bar);
    const e = Math.max(s + 1, Math.ceil(Math.max(...sel.map((n) => n.tick + n.dur)) / bar));
    return { fromBar: s + 1, bars: e - s };
  }
  return { fromBar: 1, bars: pat ? Math.max(1, Math.ceil(patternLength(pat, ts) / bar)) : 1 };
}

/** Tools ▸ Scripts… (and the toolbar braces button). */
export function openScriptsDialog(ctl: PianoRollController): void {
  if (!ctl.getTarget()) {
    flashHint('Select a pattern and a channel first', 'warn');
    return;
  }
  const v = usePianoRollView.getState();
  if (v.scale !== 'off') usePrefs.setState({ key: { root: v.scaleRoot, scale: v.scale } });
  const initialRange = defaultRange(ctl);
  openDialog({
    key: 'pianoRoll.tool',
    title: 'Scripts',
    icon: Braces,
    width: 560,
    doc: ctl.rootDocument(),
    near: ctl.rootRect() ?? undefined,
    subtitle: ctl.selectionSize ? `Works on the ${ctl.selectionSize} selected notes` : 'Note devices in JavaScript, run in a sandbox',
    render: (close) => <ScriptsBody ctl={ctl} close={close} initialRange={initialRange} />,
    onClose: () => ctl.clearPreview(),
  });
}
