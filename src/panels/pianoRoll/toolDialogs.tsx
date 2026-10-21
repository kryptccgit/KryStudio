import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  AlignHorizontalJustifyStart,
  ArrowDownUp,
  AudioLines,
  Blend,
  Braces,
  Combine,
  Dice5,
  Drum,
  FlipHorizontal2,
  FlipVertical2,
  Grid3x3,
  Music,
  Palette,
  Scissors,
  Shuffle,
  SlidersHorizontal,
  Spline,
  VolumeX,
  Waves,
  WandSparkles,
  type LucideIcon,
  MicVocal,
} from 'lucide-react';
import { CHORD_QUALITIES, NOTE_NAMES_SHARP, SCALES, noteName } from '@shared/music/theory';
import { PPQ, ticksPerBar } from '@shared/schema/time';
import { GROOVE_TEMPLATES } from '@shared/grooves/apply';
import { getProject } from '../../doc/store';
import { Check, DialogForm, DialogSelect, Field, NumberBox, RangeField, Segmented, openDialog } from '../../components/Dialog';
import type { MenuItem } from '../../components/Menu';
import { shortcutFor } from '../../input/keymap';
import { flashHint } from '../../app/hints';
import type { PianoRollController } from './controller';
import { NOTE_COLORS } from './paint';
import { usePianoRollView } from './store';
import { openGenerateDialog } from './generateDialog';
import { openScriptsDialog } from './scriptsDialog';
import { openSingDialog } from '../../voice/SingDialog';

interface Prefs {
  quantize: { grid: number; strength: number; starts: boolean; ends: boolean; swing: number };
  chop: { mode: 'grid' | 'pieces'; grid: number; pieces: number };
  strum: { time: number; curve: number; direction: 'up' | 'down' | 'alternate'; keepEnds: boolean };
  arp: { pattern: 'up' | 'down' | 'upDown' | 'downUp' | 'random'; rate: number; gate: number; octaves: number; chord: string; seed: number };
  randomize: { vel: number; timing: number; pitch: number; length: number; inKey: boolean; seed: number };
  limit: { low: number; high: number; mode: 'octave' | 'clamp' };
  levels: { prop: 'vel' | 'pan' | 'release' | 'modX' | 'modY' | 'fine'; mode: 'ramp' | 'lfo'; from: number; to: number; curve: number; shape: 'sine' | 'triangle' | 'square' | 'saw'; period: number; depth: number; center: number; phase: number };
  scaleSnap: { root: number; scale: string; direction: 'nearest' | 'up' | 'down' };
}

const usePrefs = create<Prefs>(() => ({
  quantize: { grid: 0, strength: 1, starts: true, ends: false, swing: 0 },
  chop: { mode: 'grid', grid: 0, pieces: 2 },
  strum: { time: 120, curve: 0, direction: 'up', keepEnds: true },
  arp: { pattern: 'up', rate: PPQ / 4, gate: 0.85, octaves: 1, chord: '', seed: 1 },
  randomize: { vel: 0.15, timing: 0, pitch: 0, length: 0, inKey: true, seed: 1 },
  limit: { low: 48, high: 84, mode: 'octave' },
  levels: { prop: 'vel', mode: 'ramp', from: 0.3, to: 1, curve: 0, shape: 'sine', period: PPQ * 4, depth: 0.8, center: 0.6, phase: 0 },
  scaleSnap: { root: 0, scale: 'minor', direction: 'nearest' },
}));

function usePref<K extends keyof Prefs>(k: K): [Prefs[K], (patch: Partial<Prefs[K]>) => void] {
  const v = usePrefs((s) => s[k]);
  return [v, (patch) => usePrefs.setState((s) => ({ [k]: { ...s[k], ...patch } }) as Partial<Prefs>)];
}

const newSeed = (): number => Math.floor(Math.random() * 2 ** 31);

export function ticksLabel(t: number): string {
  const bar = ticksPerBar(getProject()?.transport.timeSig ?? { num: 4, den: 4 });
  if (t > 0 && t % bar === 0) return `${t / bar} bar${t === bar ? '' : 's'}`;
  if (t > 0 && t % PPQ === 0) return `${t / PPQ} beat${t === PPQ ? '' : 's'}`;
  const r = PPQ / t;
  if (Number.isInteger(r)) return `1/${r} beat`;
  return `${t} ticks`;
}

function gridOptions(): Array<{ value: number; label: string }> {
  const bar = ticksPerBar(getProject()?.transport.timeSig ?? { num: 4, den: 4 });
  return [bar, PPQ * 2, PPQ, PPQ / 2, PPQ / 3, PPQ / 4, PPQ / 6, PPQ / 8, PPQ / 12, PPQ / 16].map((v) => ({
    value: v,
    label: v === PPQ / 4 ? '1/4 beat (step)' : ticksLabel(v),
  }));
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
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

function highlightedKey(): { root: number; scale: string } | null {
  const v = usePianoRollView.getState();
  return v.scale === 'off' ? null : { root: v.scaleRoot, scale: v.scale };
}

function scopeText(ctl: PianoRollController): string {
  const n = ctl.selectionSize;
  return n ? `${n} selected note${n === 1 ? '' : 's'}` : `all ${ctl.noteCount} notes of the channel`;
}

function ToolForm({
  ctl,
  cmd,
  args,
  label,
  close,
  children,
  submitLabel = 'Apply',
}: {
  ctl: PianoRollController;
  cmd: string;
  args: Record<string, unknown>;
  label: string;
  close: () => void;
  children: ReactNode;
  submitLabel?: string;
}) {
  const key = JSON.stringify(args);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setErr(ctl.previewTool(cmd, args)));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, cmd, key]);
  return (
    <DialogForm
      busy={busy}
      submitLabel={submitLabel}
      submitDisabled={!!err}
      onCancel={close}
      onSubmit={async () => {
        setBusy(true);
        const ok = await ctl.runTool(cmd, args, label);
        setBusy(false);
        if (ok) {
          close();
          ctl.focus();
        }
      }}
      extra={err ? <span className="text-amber-300">{err}</span> : <span>Preview on the roll · applies to {scopeText(ctl)} · one undo step</span>}
    >
      {children}
    </DialogForm>
  );
}

function open(ctl: PianoRollController, title: string, icon: LucideIcon, width: number, body: (close: () => void) => ReactNode): void {
  if (!ctl.getTarget()) {
    flashHint('Select a pattern and a channel first', 'warn');
    return;
  }
  if (!ctl.noteCount) {
    flashHint('This channel has no notes in this pattern', 'warn');
    return;
  }
  openDialog({
    key: 'pianoRoll.tool',
    title,
    icon,
    width,
    doc: ctl.rootDocument(),
    near: ctl.rootRect() ?? undefined,
    subtitle: `Applies to ${scopeText(ctl)}`,
    render: body,
    onClose: () => ctl.clearPreview(),
  });
}

function QuantizeBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const [p, set] = usePref('quantize');
  const grid = p.grid || Math.max(1, ctl.snapGridTicks() > 1 ? ctl.snapGridTicks() : PPQ / 4);
  return (
    <ToolForm ctl={ctl} cmd="notes.quantize" args={{ grid, strength: p.strength, starts: p.starts, ends: p.ends, swing: p.swing }} label="Quantize" close={close}>
      <Field label="Grid" hint="Notes snap to this grid">
        <DialogSelect value={grid} options={gridOptions()} onChange={(g) => set({ grid: g })} />
      </Field>
      <RangeField label="Strength" hint="100% = hard quantize" value={p.strength} min={0} max={1} step={0.05} format={pct} onChange={(strength) => set({ strength })} />
      <RangeField label="Swing" hint="Delays every 2nd grid line" value={p.swing} min={0} max={1} step={0.05} format={pct} onChange={(swing) => set({ swing })} />
      <div className="flex gap-5 pt-1">
        <Check checked={p.starts} onChange={(starts) => set({ starts })} label="Start times" hint="Move notes, keep their length" />
        <Check checked={p.ends} onChange={(ends) => set({ ends })} label="Note ends" hint="Snap lengths to the grid" />
      </div>
    </ToolForm>
  );
}

function ChopBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const [p, set] = usePref('chop');
  const grid = p.grid || Math.max(1, ctl.snapGridTicks() > 1 ? ctl.snapGridTicks() : PPQ / 4);
  return (
    <ToolForm ctl={ctl} cmd="notes.chop" args={{ mode: p.mode, grid, pieces: p.pieces }} label="Chop" close={close}>
      <Field label="Chop by">
        <Segmented
          value={p.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'grid', label: 'Grid' },
            { value: 'pieces', label: 'Equal pieces' },
          ]}
        />
      </Field>
      {p.mode === 'grid' ? (
        <Field label="Grid" hint="Cuts at every grid line inside a note">
          <DialogSelect value={grid} options={gridOptions()} onChange={(g) => set({ grid: g })} />
        </Field>
      ) : (
        <RangeField label="Pieces" hint="Per note" value={p.pieces} min={2} max={16} step={1} onChange={(pieces) => set({ pieces })} />
      )}
    </ToolForm>
  );
}

function StrumBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const [p, set] = usePref('strum');
  return (
    <ToolForm ctl={ctl} cmd="notes.strum" args={{ time: p.time, curve: p.curve, direction: p.direction, keepEnds: p.keepEnds }} label="Strum" close={close}>
      <RangeField label="Time" hint="Spread of each chord" value={p.time} min={10} max={PPQ} step={10} format={ticksLabel} onChange={(time) => set({ time })} />
      <RangeField label="Curve" hint="Bend: fast then slow, or slow then fast" value={p.curve} min={-1} max={1} step={0.05} format={(v) => (v === 0 ? 'Even' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`)} onChange={(curve) => set({ curve })} />
      <Field label="Direction">
        <Segmented
          value={p.direction}
          onChange={(direction) => set({ direction })}
          options={[
            { value: 'up', label: 'Up' },
            { value: 'down', label: 'Down' },
            { value: 'alternate', label: 'Alternate' },
          ]}
        />
      </Field>
      <Check checked={p.keepEnds} onChange={(keepEnds) => set({ keepEnds })} label="Keep note ends" hint="Later notes get shorter instead of ringing longer" />
    </ToolForm>
  );
}

const ARP_CHORDS = [{ value: '', label: 'Off' }, ...['maj', 'm', '7', 'maj7', 'm7', 'sus2', 'sus4', 'dim', 'aug', '9', 'm9'].filter((q) => CHORD_QUALITIES[q]).map((q) => ({ value: q, label: `Chord ${q}` }))];

function ArpBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const [p, set] = usePref('arp');
  return (
    <ToolForm
      ctl={ctl}
      cmd="notes.arpeggiate"
      args={{ pattern: p.pattern, rate: p.rate, gate: p.gate, octaves: p.octaves, seed: p.seed, ...(p.chord ? { chord: p.chord } : {}) }}
      label="Arpeggiate"
      close={close}
    >
      <Field label="Pattern" wide>
        <Segmented
          size="sm"
          value={p.pattern}
          onChange={(pattern) => set({ pattern })}
          options={[
            { value: 'up', label: 'Up' },
            { value: 'down', label: 'Down' },
            { value: 'upDown', label: 'Up-down' },
            { value: 'downUp', label: 'Down-up' },
            { value: 'random', label: 'Random', icon: Dice5 },
          ]}
        />
      </Field>
      <Field label="Rate" hint="Time between arp notes">
        <DialogSelect value={p.rate} options={gridOptions()} onChange={(rate) => set({ rate })} />
      </Field>
      <RangeField label="Gate" hint="Note length as a share of the rate" value={p.gate} min={0.05} max={1} step={0.05} format={pct} onChange={(gate) => set({ gate })} />
      <Field label="Range">
        <Segmented value={p.octaves} onChange={(octaves) => set({ octaves })} options={[1, 2, 3, 4].map((o) => ({ value: o, label: `${o} oct` }))} />
      </Field>
      <Field label="Single notes" hint="Arpeggiate a lone note as this chord">
        <DialogSelect value={p.chord} options={ARP_CHORDS} onChange={(chord) => set({ chord })} width={170} />
      </Field>
      {p.pattern === 'random' && (
        <Field label="Variation">
          <button type="button" onClick={() => set({ seed: newSeed() })} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11px] font-semibold text-white/85 hover:border-white/20">
            <Dice5 size={13} /> Roll again
          </button>
        </Field>
      )}
    </ToolForm>
  );
}

function RandomizeBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const [p, set] = usePref('randomize');
  const key = highlightedKey();
  const scale = p.inKey && key ? { scale: key } : {};
  return (
    <ToolForm ctl={ctl} cmd="notes.randomize" args={{ seed: p.seed, vel: p.vel, timing: p.timing, pitch: p.pitch, length: p.length, ...scale }} label="Randomize" close={close}>
      <RangeField label="Velocity" hint="Max ± change" value={p.vel} min={0} max={1} step={0.05} format={pct} onChange={(vel) => set({ vel })} />
      <RangeField label="Timing" hint="Max ± shift" value={p.timing} min={0} max={PPQ / 4} step={5} format={(v) => (v ? `${v} ticks` : 'Off')} onChange={(timing) => set({ timing })} />
      <RangeField label="Pitch" hint={p.inKey && key ? 'Max ± scale steps' : 'Max ± semitones'} value={p.pitch} min={0} max={12} step={1} format={(v) => (v ? `±${v}` : 'Off')} onChange={(pitch) => set({ pitch })} />
      <RangeField label="Length" hint="Max ± change" value={p.length} min={0} max={1} step={0.05} format={pct} onChange={(length) => set({ length })} />
      <div className="flex items-center justify-between pt-1">
        <Check
          checked={p.inKey && !!key}
          onChange={(inKey) => set({ inKey })}
          label="Stay in key"
          hint={key ? `${NOTE_NAMES_SHARP[key.root]} ${SCALE_LABELS[key.scale] ?? key.scale} (toolbar scale)` : 'Pick a scale in the toolbar first'}
        />
        <button type="button" onClick={() => set({ seed: newSeed() })} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11px] font-semibold text-white/85 hover:border-white/20">
          <Dice5 size={13} /> Roll again
        </button>
      </div>
    </ToolForm>
  );
}

function KeyBox({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <NumberBox value={value} min={0} max={127} onChange={onChange} width={52} />
      <span className="w-9 font-mono text-[11px] text-krypt-muted">{noteName(value)}</span>
    </div>
  );
}

function LimitBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const [p, set] = usePref('limit');
  return (
    <ToolForm ctl={ctl} cmd="notes.limit" args={{ low: p.low, high: p.high, mode: p.mode }} label="Limit key range" close={close}>
      <Field label="Lowest key" hint="MIDI number (60 = C4)">
        <KeyBox value={p.low} onChange={(low) => set({ low })} />
      </Field>
      <Field label="Highest key">
        <KeyBox value={p.high} onChange={(high) => set({ high })} />
      </Field>
      <Field label="Out-of-range notes">
        <Segmented
          value={p.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'octave', label: 'Move by octaves' },
            { value: 'clamp', label: 'Clamp' },
          ]}
        />
      </Field>
    </ToolForm>
  );
}

const LEVEL_PROPS: Array<{ value: Prefs['levels']['prop']; label: string }> = [
  { value: 'vel', label: 'Velocity' },
  { value: 'pan', label: 'Pan' },
  { value: 'release', label: 'Release' },
  { value: 'modX', label: 'Mod X' },
  { value: 'modY', label: 'Mod Y' },
  { value: 'fine', label: 'Fine pitch' },
];

function LevelsBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const [p, set] = usePref('levels');
  const args =
    p.mode === 'ramp'
      ? { prop: p.prop, mode: p.mode, from: p.from, to: p.to, curve: p.curve }
      : { prop: p.prop, mode: p.mode, shape: p.shape, period: p.period, depth: p.depth, center: p.center, phase: p.phase };
  const periods = [PPQ / 2, PPQ, PPQ * 2, PPQ * 4, PPQ * 8, PPQ * 16].map((v) => ({ value: v, label: ticksLabel(v) }));
  return (
    <ToolForm ctl={ctl} cmd="notes.levels" args={args} label={p.mode === 'ramp' ? 'Ramp' : 'LFO'} close={close}>
      <Field label="Property">
        <DialogSelect value={p.prop} options={LEVEL_PROPS} onChange={(prop) => set({ prop })} />
      </Field>
      <Field label="Shape">
        <Segmented
          value={p.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'ramp', label: 'Ramp' },
            { value: 'lfo', label: 'LFO', icon: Waves },
          ]}
        />
      </Field>
      {p.mode === 'ramp' ? (
        <>
          <RangeField label="From" value={p.from} min={0} max={1} step={0.01} format={pct} onChange={(from) => set({ from })} />
          <RangeField label="To" value={p.to} min={0} max={1} step={0.01} format={pct} onChange={(to) => set({ to })} />
          <RangeField label="Curve" value={p.curve} min={-1} max={1} step={0.05} format={(v) => (v === 0 ? 'Linear' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`)} onChange={(curve) => set({ curve })} />
        </>
      ) : (
        <>
          <Field label="Wave">
            <Segmented
              size="sm"
              value={p.shape}
              onChange={(shape) => set({ shape })}
              options={[
                { value: 'sine', label: 'Sine' },
                { value: 'triangle', label: 'Triangle' },
                { value: 'square', label: 'Square' },
                { value: 'saw', label: 'Saw' },
              ]}
            />
          </Field>
          <Field label="Period">
            <DialogSelect value={p.period} options={periods} onChange={(period) => set({ period })} />
          </Field>
          <RangeField label="Depth" value={p.depth} min={0} max={1} step={0.05} format={pct} onChange={(depth) => set({ depth })} />
          <RangeField label="Center" value={p.center} min={0} max={1} step={0.05} format={pct} onChange={(center) => set({ center })} />
          <RangeField label="Phase" value={p.phase} min={0} max={1} step={0.05} format={pct} onChange={(phase) => set({ phase })} />
        </>
      )}
    </ToolForm>
  );
}

function ScaleSnapBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const [p, set] = usePref('scaleSnap');
  return (
    <ToolForm ctl={ctl} cmd="notes.scaleSnap" args={{ root: p.root, scale: p.scale, direction: p.direction }} label="Snap to scale" close={close}>
      <Field label="Key">
        <div className="flex gap-1.5">
          <DialogSelect value={p.root} options={NOTE_NAMES_SHARP.map((n, i) => ({ value: i, label: n }))} onChange={(root) => set({ root })} width={64} />
          <DialogSelect value={p.scale} options={Object.keys(SCALES).map((s) => ({ value: s, label: SCALE_LABELS[s] ?? s }))} onChange={(scale) => set({ scale })} width={150} />
        </div>
      </Field>
      <Field label="Out-of-key notes move">
        <Segmented
          value={p.direction}
          onChange={(direction) => set({ direction })}
          options={[
            { value: 'nearest', label: 'Nearest' },
            { value: 'up', label: 'Up' },
            { value: 'down', label: 'Down' },
          ]}
        />
      </Field>
    </ToolForm>
  );
}

export const toolDialogs = {
  quantize: (ctl: PianoRollController) => open(ctl, 'Quantize', Grid3x3, 420, (close) => <QuantizeBody ctl={ctl} close={close} />),
  chop: (ctl: PianoRollController) => open(ctl, 'Chop', Scissors, 400, (close) => <ChopBody ctl={ctl} close={close} />),
  strum: (ctl: PianoRollController) => open(ctl, 'Strum', AlignHorizontalJustifyStart, 420, (close) => <StrumBody ctl={ctl} close={close} />),
  arpeggiate: (ctl: PianoRollController) => open(ctl, 'Arpeggiate', AudioLines, 460, (close) => <ArpBody ctl={ctl} close={close} />),
  randomize: (ctl: PianoRollController) => open(ctl, 'Randomize', Shuffle, 420, (close) => <RandomizeBody ctl={ctl} close={close} />),
  limit: (ctl: PianoRollController) => open(ctl, 'Limit key range', ArrowDownUp, 400, (close) => <LimitBody ctl={ctl} close={close} />),
  levels: (ctl: PianoRollController) => open(ctl, 'Levels: ramp / LFO', SlidersHorizontal, 440, (close) => <LevelsBody ctl={ctl} close={close} />),
  scaleSnap: (ctl: PianoRollController) => {
    const k = highlightedKey();
    if (k) usePrefs.setState((s) => ({ scaleSnap: { ...s.scaleSnap, root: k.root, scale: k.scale } }));
    open(ctl, 'Snap to scale', Music, 420, (close) => <ScaleSnapBody ctl={ctl} close={close} />);
  },
};

export const quickTools = {
  quickChop: (ctl: PianoRollController) => void ctl.runTool('notes.chop', { mode: 'grid', grid: Math.max(1, ctl.snapGridTicks() > 1 ? ctl.snapGridTicks() : PPQ / 4) }, 'Quick chop'),
  glue: (ctl: PianoRollController) => void ctl.runTool('notes.glue', {}, 'Glue'),
  legato: (ctl: PianoRollController) => void ctl.runTool('notes.legato', {}, 'Legato'),
  flipH: (ctl: PianoRollController) => void ctl.runTool('notes.flip', { axis: 'horizontal' }, 'Flip horizontally'),
  flipV: (ctl: PianoRollController) => {
    const k = highlightedKey();
    void ctl.runTool('notes.flip', { axis: 'vertical', ...(k ? { scale: k } : {}) }, k ? 'Flip vertically (in key)' : 'Flip vertically');
  },
  toggleMute: (ctl: PianoRollController) => void ctl.runTool('notes.setProps', { mute: 'toggle' }, 'Mute / unmute'),
  toggleSlide: (ctl: PianoRollController) => void ctl.runTool('notes.setProps', { slide: 'toggle' }, 'Slide on / off'),
  setColor: (ctl: PianoRollController, color: number) => void ctl.runTool('notes.setProps', { color }, `Colour group ${color + 1}`),
  scaleSnap: (ctl: PianoRollController) => {
    const k = highlightedKey();
    if (k) void ctl.runTool('notes.scaleSnap', { root: k.root, scale: k.scale }, `Snap to ${NOTE_NAMES_SHARP[k.root]} ${SCALE_LABELS[k.scale] ?? k.scale}`);
    else toolDialogs.scaleSnap(ctl);
  },
};

export function colorItems(ctl: PianoRollController): MenuItem[] {
  const cur = usePianoRollView.getState().noteColor;
  return NOTE_COLORS.map((c, i) => ({
    label: i === 0 ? 'Group 1 (default)' : `Group ${i + 1}`,
    swatch: c,
    checked: cur === i,
    detail: i ? `MIDI channel ${i + 1} on export` : undefined,
    onSelect: () => {
      usePianoRollView.getState().set({ noteColor: i });
      if (ctl.selectionSize) quickTools.setColor(ctl, i);
      else flashHint(`New notes use colour group ${i + 1}`, 'ok');
    },
  }));
}

function grooveItems(ctl: PianoRollController): MenuItem[] {
  return [
    { type: 'header', label: 'Feel of real drummers · Groove MIDI Dataset (CC BY 4.0)' },
    ...GROOVE_TEMPLATES.map((t) => ({
      label: t.label,
      detail: `${t.performances} performances · ${t.bpm[1]} BPM median`,
      onSelect: () => void ctl.runTool('notes.groove', { template: t.id, amount: 1, velocity: 0.5 }, `Groove: ${t.label}`),
    })),
  ];
}

export function toolsMenuItems(ctl: PianoRollController): MenuItem[] {
  const sc = (id: string) => shortcutFor(id);
  const k = highlightedKey();
  return [
    { type: 'header', label: ctl.selectionSize ? `Tools · ${ctl.selectionSize} selected` : 'Tools · whole channel' },
    { label: 'Generate…', icon: WandSparkles, shortcut: sc('pianoRoll.generate'), detail: 'Rhythm, chords, arp, melody, bass', onSelect: () => openGenerateDialog(ctl) },
    { label: 'Scripts…', icon: Braces, shortcut: sc('pianoRoll.scripts'), detail: 'Note devices in JavaScript', onSelect: () => openScriptsDialog(ctl) },
    { label: 'Sing my notes…', icon: MicVocal, shortcut: sc('pianoRoll.sing'), detail: 'Lyrics sung on this melody (Krypt Voice)', onSelect: () => openSingDialog(ctl) },
    { type: 'separator' },
    { label: 'Quantize…', icon: Grid3x3, shortcut: sc('pianoRoll.quantize'), onSelect: () => toolDialogs.quantize(ctl) },
    { label: 'Quick quantize', shortcut: 'Ctrl+Q', onSelect: () => void ctl.quantize() },
    { type: 'separator' },
    { label: 'Chop…', icon: Scissors, shortcut: sc('pianoRoll.chop'), onSelect: () => toolDialogs.chop(ctl) },
    { label: 'Quick chop (snap grid)', shortcut: sc('pianoRoll.quickChop'), onSelect: () => quickTools.quickChop(ctl) },
    { label: 'Glue', icon: Combine, shortcut: sc('pianoRoll.glue'), onSelect: () => quickTools.glue(ctl) },
    { label: 'Legato', shortcut: sc('pianoRoll.legato'), onSelect: () => quickTools.legato(ctl) },
    { type: 'separator' },
    { label: 'Strum…', icon: AlignHorizontalJustifyStart, shortcut: sc('pianoRoll.strum'), onSelect: () => toolDialogs.strum(ctl) },
    { label: 'Arpeggiate…', icon: AudioLines, shortcut: sc('pianoRoll.arpeggiate'), onSelect: () => toolDialogs.arpeggiate(ctl) },
    { label: 'Randomize…', icon: Shuffle, shortcut: sc('pianoRoll.randomize'), onSelect: () => toolDialogs.randomize(ctl) },
    { label: 'Levels: ramp / LFO…', icon: SlidersHorizontal, shortcut: sc('pianoRoll.levels'), onSelect: () => toolDialogs.levels(ctl) },
    { type: 'submenu', label: 'Groove', icon: Drum, items: grooveItems(ctl) },
    { type: 'separator' },
    { label: 'Flip horizontally', icon: FlipHorizontal2, shortcut: sc('pianoRoll.flipH'), onSelect: () => quickTools.flipH(ctl) },
    { label: k ? 'Flip vertically (in key)' : 'Flip vertically', icon: FlipVertical2, shortcut: sc('pianoRoll.flipV'), onSelect: () => quickTools.flipV(ctl) },
    {
      label: k ? `Snap to ${NOTE_NAMES_SHARP[k.root]} ${SCALE_LABELS[k.scale] ?? k.scale}` : 'Snap to scale…',
      icon: Music,
      shortcut: sc('pianoRoll.scaleSnap'),
      onSelect: () => quickTools.scaleSnap(ctl),
    },
    { label: 'Limit key range…', icon: ArrowDownUp, shortcut: sc('pianoRoll.limit'), onSelect: () => toolDialogs.limit(ctl) },
    { type: 'separator' },
    { label: 'Mute / unmute', icon: VolumeX, shortcut: sc('pianoRoll.toggleMute'), onSelect: () => quickTools.toggleMute(ctl) },
    { label: 'Slide on / off', icon: Spline, shortcut: sc('pianoRoll.toggleSlide'), onSelect: () => quickTools.toggleSlide(ctl) },
    { type: 'submenu', label: 'Colour group', icon: Palette, items: colorItems(ctl) },
    {
      type: 'submenu',
      label: 'Select',
      icon: Blend,
      items: [
        { label: 'All', shortcut: 'Ctrl+A', onSelect: () => ctl.selectAll() },
        { label: 'Muted notes', onSelect: () => flashHint(`${ctl.selectWhere((n) => !!n.mute)} muted notes selected`, 'ok') },
        { label: 'Slide notes', onSelect: () => flashHint(`${ctl.selectWhere((n) => n.slide)} slide notes selected`, 'ok') },
        {
          label: 'Current colour group',
          onSelect: () => {
            const c = usePianoRollView.getState().noteColor;
            flashHint(`${ctl.selectWhere((n) => (n.color ?? 0) === c)} notes in group ${c + 1} selected`, 'ok');
          },
        },
        ...(k ? [{ label: 'Out-of-key notes', onSelect: () => flashHint(`${ctl.selectWhere((n) => !(SCALES[k.scale] ?? []).includes((((n.key - k.root) % 12) + 12) % 12))} out-of-key notes selected`, 'ok') }] : []),
      ],
    },
  ];
}
