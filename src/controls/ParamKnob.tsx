// ──────────────────────────────────────────────────────────────────────
// Document-bound controls. A control addressed by a ParamRef resolves its
// spec (paramSpecFor), reads its value (getParamValue) and writes through
// `params.set` with coalesceKey 'knob:<ref>' so one drag = ONE undo entry.
//
//   <ParamKnob paramRef={`channel/${id}/volume`} size={18} />
//   <ParamControl paramRef={`insert/${i}/slot/${s}/mode`} />   // auto: knob / toggle / select
//   <SpecKnob spec={GLIDE} value={ch.poly.glideMs} onCommit={...} />  // non-ParamRef values
//
// (`ref` is reserved by React, hence `paramRef`.)
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { ClipboardCopy, ClipboardPaste, Link2, RotateCcw, Spline } from 'lucide-react';
import { CATALOG } from '@shared/plugins/catalog';
import { formatParam, fromNormalized, toNormalized, type ParamSpec } from '@shared/plugins/types';
import { getParamValue, paramSpecFor } from '@shared/schema/params';
import { dispatch, getProject, useProject, withGroup } from '../doc/store';
import { openMenu, type MenuItem } from '../components/Menu';
import { Fader, Knob, Slider } from './Knob';
import { Select, Toggle } from './Toggle';
import { parseParamInput } from './parse';
import { flashHint } from '../app/hints';
import { toast } from '../app/notify';
import { useLiveParam } from '../live/automationFollow';
import { controllerMenuItems } from '../live/controllerMenu';
import { cls } from '../utils/format';

// ── Gesture plumbing (local value while dragging, rAF-coalesced writes) ─

export function useGestureValue(spec: ParamSpec | null, docValue: number | null, commit: (plain: number) => unknown) {
  const [local, setLocal] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const frame = useRef<number>(0);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const flush = async (): Promise<void> => {
    if (pending.current === null) return;
    const v = pending.current;
    pending.current = null;
    await commitRef.current(v);
  };

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const value = local ?? docValue ?? spec?.default ?? 0;
  const norm = spec ? toNormalized(spec, value) : 0;

  const setPlain = (plain: number): void => {
    setLocal(plain);
    pending.current = plain;
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        void flush();
      });
    }
  };

  return {
    value,
    norm,
    gesturing: local !== null,
    setNorm: (n: number) => {
      if (spec) setPlain(fromNormalized(spec, n));
    },
    setPlain,
    end: async () => {
      if (frame.current) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
      }
      await flush();
      setLocal(null);
    },
    /** One-shot write (typed value, reset, paste). */
    commitNow: async (plain: number) => {
      pending.current = plain;
      await flush();
      setLocal(null);
    },
  };
}

// ── ParamRef binding ──────────────────────────────────────────────────

export function useParam(paramRef: string) {
  const spec = useProject((p) => paramSpecFor(p, CATALOG, paramRef));
  const docValue = useProject((p) => getParamValue(p, CATALOG, paramRef));
  const g = useGestureValue(spec, docValue, (value) =>
    dispatch('params.set', { ref: paramRef, value }, { coalesceKey: `knob:${paramRef}`, label: spec ? `Set ${spec.name}` : undefined }),
  );
  // Automated params follow their automation clip while the song plays (src/live/automationFollow.ts).
  const live = useLiveParam(paramRef);
  if (spec && live.norm !== null && !g.gesturing) return { spec, ...g, value: fromNormalized(spec, live.norm), norm: live.norm, automated: live.automated, following: true };
  return { spec, ...g, automated: live.automated, following: false };
}

/** Small pink dot on automated controls (pulses while it follows the clip). */
function AutomatedMark({ following, children }: { following: boolean; children: React.ReactNode }) {
  return (
    <span className="relative inline-flex">
      {children}
      <span
        className={cls('pointer-events-none absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-krypt-pink', following ? 'shadow-[0_0_6px_rgba(236,72,153,0.9)]' : 'opacity-70')}
      />
    </span>
  );
}

function automatedHint(label: string, hint: string | undefined, following: boolean): string {
  return `${hint ?? label} · automated: ${following ? 'following its automation clip' : 'follows its automation clip while the song plays'}`;
}

let clipboardValue: { norm: number; from: string } | null = null;

export async function createAutomationClip(paramRef: string): Promise<void> {
  const p = getProject();
  const spec = paramSpecFor(p, CATALOG, paramRef);
  if (!spec) {
    toast.error('That parameter no longer exists');
    return;
  }
  if (spec.automatable === false) {
    toast.warn(`${spec.name} can't be automated`);
    return;
  }
  const used = new Set(Object.values(p.playlist.clips).map((c) => c.trackId));
  const free = p.playlist.trackOrder.find((t) => !used.has(t));
  const ok = await withGroup(`Automate ${spec.name}`, async (groupId) => {
    let trackId = free;
    if (!trackId) {
      const r = await dispatch<{ id: string }>('playlist.addTrack', {}, { groupId });
      if (!r.ok || !r.data) return false;
      trackId = r.data.id;
    }
    const r = await dispatch('automation.create', { target: paramRef, trackId, start: 0 }, { groupId });
    return r.ok ? trackId : false;
  });
  if (ok) {
    const name = getProject().playlist.tracks[ok]?.name ?? 'the playlist';
    toast.success(`Automation clip for ${spec.name} added to ${name}`);
  }
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flashHint(`Copied ${what}`, 'ok');
  } catch {
    toast.error(`Couldn't copy ${what} to the clipboard`);
  }
}

function TypeInValue({ spec, value, onCommit, onCancel }: { spec: ParamSpec; value: number; onCommit: (v: number) => void; onCancel: () => void }) {
  const [text, setText] = useState(() => formatParam(spec, value));
  const [bad, setBad] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 10);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-[0.16em] text-krypt-muted mb-1">Type in value</div>
      <input
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const v = parseParamInput(spec, text);
            if (v === null) setBad(true);
            else onCommit(v);
          } else if (e.key === 'Escape') onCancel();
        }}
        className={cls(
          'w-full rounded-md border bg-black/50 px-2 py-1 font-mono text-[11px] text-white outline-none',
          bad ? 'border-rose-400/70' : 'border-white/15 focus:border-krypt-purple/70',
        )}
      />
      <div className="mt-1 text-[9px] text-krypt-muted/70">
        {bad ? <span className="text-rose-300">Not a valid value</span> : `${formatParam(spec, spec.min)} … ${formatParam(spec, spec.max)} · Enter to set`}
      </div>
    </div>
  );
}

/** The FL-style right-click menu every parameter control shares. */
export function paramMenuItems(paramRef: string | null, spec: ParamSpec, value: number, commit: (plain: number) => void, extra: MenuItem[] = []): MenuItem[] {
  const items: MenuItem[] = [
    { type: 'header', label: spec.name },
    { type: 'custom', render: (close) => <TypeInValue spec={spec} value={value} onCommit={(v) => (commit(v), close())} onCancel={close} /> },
    { label: `Reset to default (${formatParam(spec, spec.default)})`, icon: RotateCcw, shortcut: 'Dbl-click', onSelect: () => commit(spec.default) },
    { type: 'separator' },
    { label: 'Copy value', icon: ClipboardCopy, onSelect: () => {
        clipboardValue = { norm: toNormalized(spec, value), from: spec.name };
        flashHint(`Copied ${formatParam(spec, value)}`, 'ok');
      } },
    {
      label: clipboardValue ? `Paste value (from ${clipboardValue.from})` : 'Paste value',
      icon: ClipboardPaste,
      disabled: !clipboardValue,
      onSelect: () => clipboardValue && commit(fromNormalized(spec, clipboardValue.norm)),
    },
  ];
  if (paramRef) {
    items.push(
      { type: 'separator' },
      {
        label: 'Create automation clip',
        icon: Spline,
        disabled: spec.automatable === false,
        hint: 'Adds an automation clip for this parameter on the first empty playlist track',
        onSelect: () => void createAutomationClip(paramRef),
      },
      { label: 'Copy ParamRef', icon: Link2, detail: paramRef, onSelect: () => void copyText(paramRef, 'ParamRef') },
      // Live input: MIDI-learn ("Link to controller…") + unlink.
      ...controllerMenuItems(paramRef, spec.name),
    );
  }
  return items.concat(extra);
}

// ── Components ────────────────────────────────────────────────────────

interface ParamProps {
  paramRef: string;
  label?: string;
  showLabel?: boolean;
  showValue?: boolean;
  color?: string;
  className?: string;
  hint?: string;
  disabled?: boolean;
}

function isBipolar(spec: ParamSpec): boolean {
  return spec.min < 0 && spec.max > 0 && spec.scale === 'linear';
}

function steps(spec: ParamSpec): number | undefined {
  if (spec.options) return spec.options.length;
  if (spec.step && spec.step > 0) {
    const n = Math.round((spec.max - spec.min) / spec.step) + 1;
    return n <= 64 ? n : undefined;
  }
  return undefined;
}

function useBound(paramRef: string) {
  const p = useParam(paramRef);
  const commitNow = p.commitNow;
  const onContextMenu = (e: React.MouseEvent): void => {
    if (!p.spec) return;
    openMenu(e, paramMenuItems(paramRef, p.spec, p.value, (v) => void commitNow(v)));
  };
  return { p, onContextMenu };
}

function Missing({ size }: { size: number }) {
  return <div className="rounded-full border border-dashed border-white/10" style={{ width: size, height: size }} data-hint="Parameter not available" />;
}

export function ParamKnob({ paramRef, size = 32, ...rest }: ParamProps & { size?: number }) {
  const { p, onContextMenu } = useBound(paramRef);
  if (!p.spec) return <Missing size={size} />;
  const spec = p.spec;
  const knob = (
    <Knob
      size={size}
      value={p.norm}
      defaultValue={toNormalized(spec, spec.default)}
      display={formatParam(spec, p.value)}
      label={rest.label ?? spec.name}
      showLabel={rest.showLabel}
      showValue={rest.showValue}
      steps={steps(spec)}
      bipolar={isBipolar(spec)}
      color={rest.color}
      hint={p.automated ? automatedHint(rest.label ?? spec.name, rest.hint, p.following) : rest.hint}
      disabled={rest.disabled}
      className={rest.className}
      onChange={p.setNorm}
      onEnd={() => void p.end()}
      onReset={() => void p.commitNow(spec.default)}
      onContextMenu={onContextMenu}
    />
  );
  return p.automated ? <AutomatedMark following={p.following}>{knob}</AutomatedMark> : knob;
}

export function ParamFader({ paramRef, height = 120, width = 22, ...rest }: ParamProps & { height?: number; width?: number }) {
  const { p, onContextMenu } = useBound(paramRef);
  if (!p.spec) return <div style={{ width, height }} />;
  const spec = p.spec;
  const marks = spec.scale === 'gain' && spec.max >= 1 ? [toNormalized(spec, 1)] : [];
  const fader = (
    <Fader
      height={height}
      width={width}
      marks={marks}
      value={p.norm}
      defaultValue={toNormalized(spec, spec.default)}
      display={formatParam(spec, p.value)}
      label={rest.label ?? spec.name}
      hint={p.automated ? automatedHint(rest.label ?? spec.name, rest.hint, p.following) : rest.hint}
      color={rest.color}
      className={rest.className}
      onChange={p.setNorm}
      onEnd={() => void p.end()}
      onReset={() => void p.commitNow(spec.default)}
      onContextMenu={onContextMenu}
    />
  );
  return p.automated ? <AutomatedMark following={p.following}>{fader}</AutomatedMark> : fader;
}

export function ParamSlider({ paramRef, width = 80, height = 12, ...rest }: ParamProps & { width?: number; height?: number }) {
  const { p, onContextMenu } = useBound(paramRef);
  if (!p.spec) return <div style={{ width, height }} />;
  const spec = p.spec;
  return (
    <Slider
      width={width}
      height={height}
      value={p.norm}
      defaultValue={toNormalized(spec, spec.default)}
      display={formatParam(spec, p.value)}
      label={rest.label ?? spec.name}
      bipolar={isBipolar(spec)}
      hint={rest.hint}
      color={rest.color}
      className={rest.className}
      onChange={p.setNorm}
      onEnd={() => void p.end()}
      onReset={() => void p.commitNow(spec.default)}
      onContextMenu={onContextMenu}
    />
  );
}

/** Picks the right control for a spec: on/off → toggle, enum → select, else a knob. */
export function ParamControl({ paramRef, size = 36, ...rest }: ParamProps & { size?: number }) {
  const { p, onContextMenu } = useBound(paramRef);
  if (!p.spec) return null;
  const spec = p.spec;
  const label = rest.label ?? spec.name;
  if (spec.options && spec.options.length === 2 && spec.min === 0 && spec.max === 1) {
    return (
      <div className="flex flex-col items-center gap-1 w-[64px]" onContextMenu={(e) => (e.preventDefault(), onContextMenu(e))}>
        <div className="max-w-[64px] truncate text-[9px] font-semibold uppercase tracking-wider text-krypt-muted" title={label}>
          {label}
        </div>
        <Toggle
          variant="button"
          on={Math.round(p.value) === 1}
          onChange={(on) => void p.commitNow(on ? 1 : 0)}
          hint={`${label}: ${formatParam(spec, p.value)}`}
          className="w-12 justify-center"
        >
          {spec.options[Math.round(p.value)] ?? (Math.round(p.value) ? 'On' : 'Off')}
        </Toggle>
      </div>
    );
  }
  if (spec.options) {
    return (
      <div className="flex flex-col items-center gap-1" onContextMenu={(e) => (e.preventDefault(), onContextMenu(e))}>
        <div className="max-w-[96px] truncate text-[9px] font-semibold uppercase tracking-wider text-krypt-muted" title={label}>
          {label}
        </div>
        <Select
          value={Math.round(p.value)}
          options={spec.options.map((o, i) => ({ value: i, label: o }))}
          onChange={(v) => void p.commitNow(v)}
          hint={label}
          width={92}
        />
      </div>
    );
  }
  return <ParamKnob paramRef={paramRef} size={size} showLabel showValue {...rest} />;
}

/**
 * A knob over a value that isn't a ParamRef (glide time, root key, cut
 * group...). The caller commits with its own command + coalesceKey.
 */
export function SpecKnob({
  spec,
  value,
  onCommit,
  size = 32,
  showLabel = true,
  showValue = true,
  format,
}: {
  spec: ParamSpec;
  value: number;
  onCommit: (plain: number) => unknown;
  size?: number;
  showLabel?: boolean;
  showValue?: boolean;
  format?: (v: number) => string;
}) {
  const g = useGestureValue(spec, value, onCommit);
  const fmt = format ?? ((v: number) => formatParam(spec, v));
  return (
    <Knob
      size={size}
      value={g.norm}
      defaultValue={toNormalized(spec, spec.default)}
      display={fmt(g.value)}
      label={spec.name}
      showLabel={showLabel}
      showValue={showValue}
      steps={steps(spec)}
      bipolar={isBipolar(spec)}
      onChange={g.setNorm}
      onEnd={() => void g.end()}
      onReset={() => void g.commitNow(spec.default)}
      onContextMenu={(e) => openMenu(e, paramMenuItems(null, spec, g.value, (v) => void g.commitNow(v)))}
    />
  );
}
