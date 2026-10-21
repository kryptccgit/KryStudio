import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { AudioLines, Dice5, Drum, Music, Piano, Play, Spline, Square, WandSparkles, Waves, type LucideIcon } from 'lucide-react';
import { NOTE_NAMES_SHARP, SCALES, noteName } from '@shared/music/theory';
import { ticksPerBar } from '@shared/schema/time';
import { patternLength } from '@shared/schema/project';
import { guessKey, patternChords } from '@shared/commands/generate';
import {
  GENERATOR_LABELS,
  PROGRESSIONS,
  RATES,
  RATE_LABELS,
  variationSeed,
  type ArpOptions,
  type BassOptions,
  type ChordOptions,
  type GeneratorKind,
  type MelodyOptions,
  type RhythmOptions,
} from '@shared/music/generate';
import type { GeneratePlan } from '@shared/commands/generate';
import { getProject } from '../../doc/store';
import { Check, DialogForm, DialogSelect, Field, NumberBox, RangeField, Segmented, openDialog } from '../../components/Dialog';
import { flashHint } from '../../app/hints';
import { cls } from '../../utils/format';
import type { PianoRollController } from './controller';
import { usePianoRollView } from './store';

type KeyChoice = { root: number; scale: string } | null;

interface GenPrefs {
  kind: GeneratorKind;
  seed: number;
  mode: 'replace' | 'merge';
  key: KeyChoice;
  rhythm: Partial<RhythmOptions>;
  chords: Partial<ChordOptions>;
  arp: Partial<ArpOptions>;
  melody: Partial<MelodyOptions>;
  bass: Partial<BassOptions>;
}

const newSeed = (): number => Math.floor(Math.random() * 2 ** 31);

const usePrefs = create<GenPrefs>(() => ({ kind: 'melody', seed: newSeed(), mode: 'replace', key: null, rhythm: {}, chords: {}, arp: {}, melody: {}, bass: {} }));

const KINDS: Array<{ value: GeneratorKind; label: string; icon: LucideIcon }> = [
  { value: 'rhythm', label: 'Rhythm', icon: Drum },
  { value: 'chords', label: 'Chords', icon: Piano },
  { value: 'arp', label: 'Arp', icon: AudioLines },
  { value: 'melody', label: 'Melody', icon: Music },
  { value: 'bass', label: 'Bass', icon: Waves },
];

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const RATE_OPTIONS = RATES.map((r) => ({ value: r, label: RATE_LABELS[r] }));
const PROGRESSION_OPTIONS = [{ value: 'auto', label: 'Surprise me (seed)' }, ...PROGRESSIONS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: 'Custom numerals…' }];
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

function KeyBox({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <NumberBox value={value} min={0} max={127} onChange={onChange} width={52} />
      <span className="w-9 font-mono text-[11px] text-krypt-muted">{noteName(value)}</span>
    </div>
  );
}

function SmallButton({ icon: Icon, label, onClick, title, active }: { icon: LucideIcon; label: string; onClick: () => void; title?: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cls(
        'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition',
        active ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/5 text-white/85 hover:border-white/20',
      )}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

function ProgressionField({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const v = value ?? 'auto';
  const preset = v === 'auto' || PROGRESSIONS.some((p) => p.id === v);
  const [custom, setCustom] = useState(preset ? 'i VI III VII' : v);
  return (
    <Field label="Progression" hint="By scale degree, in the key" wide>
      <div className="flex gap-1.5">
        <DialogSelect value={preset ? v : 'custom'} options={PROGRESSION_OPTIONS} onChange={(x) => onChange(x === 'custom' ? custom : x)} width={190} />
        {!preset && (
          <input
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              onChange(e.target.value);
            }}
            spellCheck={false}
            placeholder="i VI III VII"
            className="h-7 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2 font-mono text-[11px] text-white outline-none focus:border-krypt-purple/60"
          />
        )}
      </div>
    </Field>
  );
}

function ChordSourceField({ value, onChange, hasChords, allowNone }: { value: string | undefined; onChange: (v: 'auto' | 'pattern' | 'progression' | 'none') => void; hasChords: boolean; allowNone?: boolean }) {
  const opts: Array<{ value: 'auto' | 'pattern' | 'progression' | 'none'; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'pattern', label: 'Pattern chords' },
    { value: 'progression', label: 'Progression' },
  ];
  if (allowNone) opts.push({ value: 'none', label: 'None' });
  return (
    <Field label="Follow chords" hint={hasChords ? 'Chords found in this pattern' : 'No chords in this pattern yet: Auto uses the progression'} wide>
      <Segmented size="sm" value={(value ?? 'auto') as 'auto' | 'pattern' | 'progression' | 'none'} onChange={onChange} options={opts} />
    </Field>
  );
}

function RhythmFields({ o, set, rootKey }: { o: Partial<RhythmOptions>; set: (p: Partial<RhythmOptions>) => void; rootKey: number }) {
  const mode = o.mode ?? 'euclid';
  const steps = o.steps ?? 16;
  return (
    <>
      <Field label="Pattern">
        <Segmented
          value={mode}
          onChange={(m) => set({ mode: m })}
          options={[
            { value: 'euclid', label: 'Euclidean' },
            { value: 'density', label: 'Density' },
          ]}
        />
      </Field>
      {mode === 'euclid' ? (
        <>
          <RangeField label="Steps" value={steps} min={2} max={32} step={1} onChange={(v) => set({ steps: v, pulses: Math.min(o.pulses ?? 5, v), rotation: Math.min(o.rotation ?? 0, v - 1) })} />
          <RangeField label="Pulses" hint="Hits spread evenly over the steps" value={Math.min(o.pulses ?? 5, steps)} min={1} max={steps} step={1} onChange={(v) => set({ pulses: v })} />
          <RangeField label="Rotation" value={Math.min(o.rotation ?? 0, steps - 1)} min={0} max={steps - 1} step={1} onChange={(v) => set({ rotation: v })} />
        </>
      ) : (
        <RangeField label="Density" hint="Strong beats fill first" value={o.density ?? 0.5} min={0.05} max={1} step={0.05} format={pct} onChange={(v) => set({ density: v })} />
      )}
      <Field label="Step">
        <DialogSelect value={o.rate ?? '16th'} options={RATE_OPTIONS} onChange={(rate) => set({ rate })} width={130} />
      </Field>
      <Field label="Accents">
        <DialogSelect
          value={o.accents ?? 'downbeats'}
          options={[
            { value: 'none', label: 'None' },
            { value: 'downbeats', label: 'On the beat' },
            { value: 'backbeat', label: 'Backbeat (2 and 4)' },
            { value: 'offbeats', label: 'Off-beats' },
            { value: 'random', label: 'Random' },
          ]}
          onChange={(accents) => set({ accents })}
          width={150}
        />
      </Field>
      <RangeField label="Ghost notes" hint="Soft hits on empty steps" value={o.ghosts ?? 0} min={0} max={1} step={0.05} format={(v) => (v ? pct(v) : 'Off')} onChange={(v) => set({ ghosts: v })} />
      <RangeField label="32nd rolls" hint="Hat rolls, mostly at bar ends" value={o.rolls ?? 0} min={0} max={1} step={0.05} format={(v) => (v ? pct(v) : 'Off')} onChange={(v) => set({ rolls: v })} />
      <Field label="Note" hint="Default: the channel's root key">
        <KeyBox value={o.note ?? rootKey} onChange={(note) => set({ note })} />
      </Field>
    </>
  );
}

function ChordFields({ o, set }: { o: Partial<ChordOptions>; set: (p: Partial<ChordOptions>) => void }) {
  return (
    <>
      <ProgressionField value={o.progression} onChange={(progression) => set({ progression })} />
      <Field label="Chords">
        <Segmented
          size="sm"
          value={o.extensions ?? 'auto'}
          onChange={(extensions) => set({ extensions })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'triads', label: 'Triads' },
            { value: 'sevenths', label: '7ths' },
            { value: 'ninths', label: '9ths' },
          ]}
        />
      </Field>
      <Field label="Voicing">
        <Segmented
          size="sm"
          value={o.voicing ?? 'close'}
          onChange={(voicing) => set({ voicing })}
          options={[
            { value: 'close', label: 'Close' },
            { value: 'open', label: 'Open' },
            { value: 'spread', label: 'Spread' },
          ]}
        />
      </Field>
      <Field label="Inversions" hint="Auto = smooth voice leading">
        <DialogSelect
          value={o.inversion ?? 'auto'}
          options={[
            { value: 'auto', label: 'Auto (voice leading)' },
            { value: 'root', label: 'Root position' },
            { value: 'first', label: 'First inversion' },
            { value: 'second', label: 'Second inversion' },
            { value: 'third', label: 'Third inversion' },
          ]}
          onChange={(inversion) => set({ inversion })}
          width={170}
        />
      </Field>
      <Field label="Rhythm">
        <DialogSelect
          value={o.rhythm ?? 'whole'}
          options={[
            { value: 'whole', label: 'Held' },
            { value: 'halves', label: 'Halves' },
            { value: 'quarters', label: 'Quarters' },
            { value: 'stabs', label: 'Stabs' },
            { value: 'offbeat', label: 'Off-beat (house)' },
            { value: 'pulse', label: '8th pulse' },
          ]}
          onChange={(rhythm) => set({ rhythm })}
          width={150}
        />
      </Field>
      <BarsPerChord value={o.barsPerChord} onChange={(barsPerChord) => set({ barsPerChord })} />
      <Field label="Octave">
        <Segmented size="sm" value={o.octave ?? 4} onChange={(octave) => set({ octave })} options={[2, 3, 4, 5, 6].map((v) => ({ value: v, label: `C${v}` }))} />
      </Field>
    </>
  );
}

function BarsPerChord({ value, onChange }: { value: number | undefined; onChange: (v: 0.5 | 1 | 2 | 4) => void }) {
  return (
    <Field label="Chord length">
      <Segmented
        size="sm"
        value={(value ?? 1) as 0.5 | 1 | 2 | 4}
        onChange={onChange}
        options={[
          { value: 0.5, label: '½ bar' },
          { value: 1, label: '1 bar' },
          { value: 2, label: '2 bars' },
          { value: 4, label: '4 bars' },
        ]}
      />
    </Field>
  );
}

function ArpFields({ o, set, hasChords }: { o: Partial<ArpOptions>; set: (p: Partial<ArpOptions>) => void; hasChords: boolean }) {
  const fromPattern = (o.chords ?? 'auto') === 'pattern' || ((o.chords ?? 'auto') === 'auto' && hasChords);
  return (
    <>
      <ChordSourceField value={o.chords} onChange={(chords) => set({ chords: chords as ArpOptions['chords'] })} hasChords={hasChords} />
      {!fromPattern && <ProgressionField value={o.progression} onChange={(progression) => set({ progression })} />}
      {!fromPattern && <BarsPerChord value={o.barsPerChord} onChange={(barsPerChord) => set({ barsPerChord })} />}
      <Field label="Style" wide>
        <Segmented
          size="sm"
          value={o.style ?? 'up'}
          onChange={(style) => set({ style })}
          options={[
            { value: 'up', label: 'Up' },
            { value: 'down', label: 'Down' },
            { value: 'upDown', label: 'Up-down' },
            { value: 'downUp', label: 'Down-up' },
            { value: 'converge', label: 'Converge' },
            { value: 'random', label: 'Random', icon: Dice5 },
          ]}
        />
      </Field>
      <Field label="Rate">
        <DialogSelect value={o.rate ?? '16th'} options={RATE_OPTIONS} onChange={(rate) => set({ rate })} width={130} />
      </Field>
      <Field label="Range">
        <Segmented size="sm" value={o.octaves ?? 1} onChange={(octaves) => set({ octaves })} options={[1, 2, 3, 4].map((v) => ({ value: v, label: `${v} oct` }))} />
      </Field>
      <RangeField label="Gate" hint="Note length as a share of the rate" value={o.gate ?? 0.8} min={0.05} max={1} step={0.05} format={pct} onChange={(gate) => set({ gate })} />
      {!fromPattern && (
        <Field label="Octave">
          <Segmented size="sm" value={o.octave ?? 4} onChange={(octave) => set({ octave })} options={[2, 3, 4, 5, 6].map((v) => ({ value: v, label: `C${v}` }))} />
        </Field>
      )}
    </>
  );
}

function MelodyFields({ o, set, hasChords }: { o: Partial<MelodyOptions>; set: (p: Partial<MelodyOptions>) => void; hasChords: boolean }) {
  const src = o.chords ?? 'auto';
  return (
    <>
      <Field label="Contour" wide>
        <Segmented
          size="sm"
          value={o.contour ?? 'arch'}
          onChange={(contour) => set({ contour })}
          options={[
            { value: 'rise', label: 'Rise' },
            { value: 'fall', label: 'Fall' },
            { value: 'arch', label: 'Arch' },
            { value: 'valley', label: 'Valley' },
            { value: 'wave', label: 'Wave' },
          ]}
        />
      </Field>
      <Field label="Lowest note">
        <KeyBox value={o.low ?? 60} onChange={(low) => set({ low })} />
      </Field>
      <Field label="Highest note">
        <KeyBox value={o.high ?? 79} onChange={(high) => set({ high })} />
      </Field>
      <RangeField label="Density" value={o.density ?? 0.6} min={0.05} max={1} step={0.05} format={pct} onChange={(density) => set({ density })} />
      <Field label="Feel">
        <Segmented
          size="sm"
          value={o.feel ?? '8ths'}
          onChange={(feel) => set({ feel })}
          options={[
            { value: 'quarters', label: '1/4' },
            { value: '8ths', label: '1/8' },
            { value: '16ths', label: '1/16' },
            { value: 'syncopated', label: 'Syncopated' },
          ]}
        />
      </Field>
      <Field label="Phrase">
        <Segmented size="sm" value={o.phrase ?? 2} onChange={(phrase) => set({ phrase })} options={[1, 2, 4].map((v) => ({ value: v as 1 | 2 | 4, label: `${v} bar${v === 1 ? '' : 's'}` }))} />
      </Field>
      <Check checked={o.callResponse ?? true} onChange={(callResponse) => set({ callResponse })} label="Call and response" hint="Every second phrase repeats the first with a new ending" />
      <ChordSourceField value={src} onChange={(chords) => set({ chords })} hasChords={hasChords} allowNone />
      {src === 'progression' && <ProgressionField value={o.progression} onChange={(progression) => set({ progression })} />}
      {src !== 'none' && (
        <RangeField label="Chord tones" hint="Strong beats land on the chord" value={o.chordTones ?? 0.7} min={0} max={1} step={0.05} format={pct} onChange={(chordTones) => set({ chordTones })} />
      )}
    </>
  );
}

function BassFields({ o, set, hasChords }: { o: Partial<BassOptions>; set: (p: Partial<BassOptions>) => void; hasChords: boolean }) {
  const fromPattern = (o.chords ?? 'auto') === 'pattern' || ((o.chords ?? 'auto') === 'auto' && hasChords);
  return (
    <>
      <ChordSourceField value={o.chords} onChange={(chords) => set({ chords: chords as BassOptions['chords'] })} hasChords={hasChords} />
      {!fromPattern && <ProgressionField value={o.progression} onChange={(progression) => set({ progression })} />}
      {!fromPattern && <BarsPerChord value={o.barsPerChord} onChange={(barsPerChord) => set({ barsPerChord })} />}
      <Field label="Style" wide>
        <Segmented
          size="sm"
          value={o.style ?? 'root'}
          onChange={(style) => set({ style })}
          options={[
            { value: 'root', label: 'Roots' },
            { value: 'rootFifth', label: 'Root-fifth' },
            { value: 'octave', label: 'Octaves' },
            { value: 'walking', label: 'Walking' },
            { value: 'glide808', label: '808 glide', icon: Spline },
          ]}
        />
      </Field>
      <Field label="Rhythm">
        <DialogSelect
          value={o.rhythm ?? 'auto'}
          options={[
            { value: 'auto', label: 'Auto (style)' },
            { value: 'whole', label: 'Held' },
            { value: 'halves', label: 'Halves' },
            { value: 'quarters', label: 'Quarters' },
            { value: 'eighths', label: '8ths' },
            { value: 'offbeat', label: 'Off-beat (house)' },
            { value: 'tresillo', label: 'Tresillo (reggaeton)' },
            { value: 'trap', label: 'Trap' },
            { value: 'funk', label: 'Funk 16ths' },
          ]}
          onChange={(rhythm) => set({ rhythm })}
          width={160}
        />
      </Field>
      <Field label="Octave">
        <Segmented size="sm" value={o.octave ?? 2} onChange={(octave) => set({ octave })} options={[0, 1, 2, 3, 4].map((v) => ({ value: v, label: `C${v}` }))} />
      </Field>
      <RangeField label="Passing notes" hint="Lead into the next chord" value={o.passing ?? 0.15} min={0} max={1} step={0.05} format={(v) => (v ? pct(v) : 'Off')} onChange={(passing) => set({ passing })} />
      <RangeField label="Gate" value={o.gate ?? 0.9} min={0.05} max={1} step={0.05} format={pct} onChange={(gate) => set({ gate })} />
    </>
  );
}

function Thumb({ plan }: { plan: GeneratePlan }) {
  const W = 120;
  const H = 46;
  const { start, end } = plan.range;
  const keys = plan.notes.map((n) => n.key);
  const lo = Math.min(...keys) - 1;
  const hi = Math.max(...keys) + 1;
  const rowH = Math.max(1.5, Math.min(5, (H - 4) / Math.max(1, hi - lo)));
  const y = (k: number): number => H - 2 - ((k - lo) / Math.max(1, hi - lo)) * (H - 4) - rowH / 2;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[46px]">
      {plan.notes.map((n, i) => (
        <rect
          key={i}
          x={((n.tick - start) / (end - start)) * W}
          y={y(n.key)}
          width={Math.max(1, (n.dur / (end - start)) * W - 0.3)}
          height={rowH}
          rx={0.6}
          fill="url(#krypt-gen-grad)"
          opacity={0.45 + 0.55 * n.vel}
        />
      ))}
    </svg>
  );
}

function Variations({ plans, seeds, onPick, current }: { plans: Array<GeneratePlan | null>; seeds: number[]; onPick: (seed: number) => void; current: number }) {
  return (
    <div>
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="krypt-gen-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#6366F1" />
            <stop offset="50%" stopColor="#A855F7" />
            <stop offset="100%" stopColor="#EC4899" />
          </linearGradient>
        </defs>
      </svg>
      <div className="grid grid-cols-4 gap-1.5">
        {plans.map((p, i) => (
          <button
            key={seeds[i]}
            type="button"
            title={p ? `Apply this take (seed ${seeds[i]}): ${p.notes.length} notes` : 'No notes with this seed'}
            disabled={!p}
            onClick={() => onPick(seeds[i])}
            className={cls(
              'overflow-hidden rounded-lg border bg-black/40 p-1 text-left transition hover:border-krypt-purple/60 hover:bg-krypt-purple/10 disabled:opacity-40',
              seeds[i] === current ? 'border-krypt-purple/50' : 'border-white/10',
            )}
          >
            {p ? <Thumb plan={p} /> : <div className="h-[46px]" />}
            <div className="mt-0.5 flex items-center justify-between px-0.5 font-mono text-[9px] text-krypt-muted">
              <span>{i === 0 ? 'this take' : `take ${i + 1}`}</span>
              <span>{p ? p.notes.length : 0}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function GenerateBody({ ctl, close, initialRange }: { ctl: PianoRollController; close: () => void; initialRange: { fromBar: number; bars: number } }) {
  const p = usePrefs();
  const set = (patch: Partial<GenPrefs>): void => usePrefs.setState(patch);
  const setOpts = <K extends GeneratorKind>(k: K, patch: Partial<GenPrefs[K]>): void => usePrefs.setState((s) => ({ [k]: { ...s[k], ...patch } }) as Partial<GenPrefs>);
  const [range, setRange] = useState(initialRange);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);

  const proj = getProject();
  const target = ctl.getTarget();
  const guessed = useMemo(() => (proj && target ? guessKey(proj, target.patternId) : null), [proj, target?.patternId]);
  const hasChords = useMemo(() => (proj && target ? patternChords(proj, target.patternId).length > 0 : false), [proj, target?.patternId]);
  const rootKey = (target && proj?.channels[target.channelId]?.rootKey) ?? 60;

  const args = (seed: number): Record<string, unknown> => ({
    kind: p.kind,
    options: p[p.kind],
    seed,
    mode: p.mode,
    range,
    ...(p.key ? { key: p.key } : {}),
  });
  const key = JSON.stringify(args(p.seed));

  const [preview, setPreview] = useState<{ plan: GeneratePlan } | { error: string } | null>(null);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPreview(ctl.previewGenerate(args(p.seed))));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, key]);

  const seeds = [0, 1, 2, 3].map((i) => variationSeed(p.seed, i));
  const variations = useMemo(
    () =>
      seeds.map((s) => {
        const r = ctl.planGenerate(args(s), true);
        return 'plan' in r ? r.plan : null;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctl, key],
  );

  useEffect(() => () => ctl.stopAudition(), [ctl]);
  useEffect(() => {
    ctl.stopAudition();
    setPlaying(false);
  }, [ctl, key]);

  const apply = async (seed: number): Promise<void> => {
    setBusy(true);
    const ok = await ctl.runGenerate(args(seed), `Generate ${GENERATOR_LABELS[p.kind].toLowerCase()}`);
    setBusy(false);
    if (ok) {
      if (seed !== p.seed) set({ seed });
      close();
      ctl.focus();
    }
  };

  const plan = preview && 'plan' in preview ? preview.plan : null;
  const err = preview && 'error' in preview ? preview.error : null;
  const audition = (): void => {
    if (playing) {
      ctl.stopAudition();
      setPlaying(false);
      return;
    }
    if (!plan) return;
    const ms = ctl.auditionNotes(plan.notes, plan.range.start, Math.min(plan.range.end, plan.range.start + 8 * ticksPerBar(proj?.transport.timeSig ?? { num: 4, den: 4 })));
    if (!ms) {
      flashHint('Nothing to audition: pick a channel first', 'warn');
      return;
    }
    setPlaying(true);
    window.setTimeout(() => setPlaying(false), ms + 50);
  };

  const keyText = p.key ? `${NOTE_NAMES_SHARP[p.key.root]} ${SCALE_LABELS[p.key.scale] ?? p.key.scale}` : guessed ? `Auto: ${guessed.name} (${guessed.source === 'pattern' ? 'from this pattern' : guessed.source === 'project' ? 'from the project' : 'default'})` : 'Auto';
  const summary = plan
    ? `${plan.notes.length} notes · bar${plan.range.bars === 1 ? ` ${plan.range.fromBar}` : `s ${plan.range.fromBar}–${plan.range.fromBar + plan.range.bars - 1}`} · ${plan.keyName}${plan.chords?.length ? ` · ${plan.chords.slice(0, 6).join(' ')}` : ''}${plan.remove.length ? ` · replaces ${plan.remove.length}` : ''} · one undo step`
    : null;

  let fields: ReactNode;
  switch (p.kind) {
    case 'rhythm':
      fields = <RhythmFields o={p.rhythm} set={(x) => setOpts('rhythm', x)} rootKey={rootKey} />;
      break;
    case 'chords':
      fields = <ChordFields o={p.chords} set={(x) => setOpts('chords', x)} />;
      break;
    case 'arp':
      fields = <ArpFields o={p.arp} set={(x) => setOpts('arp', x)} hasChords={hasChords} />;
      break;
    case 'melody':
      fields = <MelodyFields o={p.melody} set={(x) => setOpts('melody', x)} hasChords={hasChords} />;
      break;
    case 'bass':
      fields = <BassFields o={p.bass} set={(x) => setOpts('bass', x)} hasChords={hasChords} />;
      break;
  }

  return (
    <DialogForm
      busy={busy}
      submitLabel="Apply"
      submitDisabled={!!err}
      onCancel={close}
      onSubmit={() => void apply(p.seed)}
      extra={err ? <span className="text-amber-300">{err}</span> : <span>{summary ?? 'Preview on the roll'}</span>}
    >
      <Field label="Generator" wide>
        <Segmented value={p.kind} onChange={(kind) => set({ kind })} options={KINDS.map((k) => ({ value: k.value, label: k.label, icon: k.icon }))} />
      </Field>
      <Field label="Key" hint={keyText}>
        <div className="flex gap-1.5">
          <DialogSelect
            value={p.key ? p.key.root : -1}
            options={[{ value: -1, label: 'Auto' }, ...NOTE_NAMES_SHARP.map((n, i) => ({ value: i, label: n }))]}
            onChange={(root) => set({ key: root < 0 ? null : { root, scale: p.key?.scale ?? guessed?.key.scale ?? 'minor' } })}
            width={72}
          />
          {p.key && (
            <DialogSelect value={p.key.scale} options={Object.keys(SCALES).map((s) => ({ value: s, label: SCALE_LABELS[s] ?? s }))} onChange={(scale) => set({ key: { root: p.key!.root, scale } })} width={140} />
          )}
        </div>
      </Field>
      <Field label="Bars" hint={ctl.selectionSize ? 'Default: the bars of the selection' : 'Default: the whole pattern'}>
        <div className="flex items-center gap-1.5 text-[11px] text-krypt-muted">
          from
          <NumberBox value={range.fromBar} min={1} max={4096} onChange={(fromBar) => setRange((r) => ({ ...r, fromBar }))} width={46} />
          for
          <NumberBox value={range.bars} min={1} max={256} onChange={(bars) => setRange((r) => ({ ...r, bars }))} width={46} />
        </div>
      </Field>
      <Field label="Existing notes" hint={p.mode === 'replace' ? (ctl.selectionSize ? 'The selected notes are replaced' : "The channel's notes in these bars are replaced") : 'Kept; new notes are added'}>
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
      <div className="h-px bg-white/[0.06]" />
      {fields}
      <div className="h-px bg-white/[0.06]" />
      <Field label="Seed" hint="Same seed = same notes">
        <div className="flex items-center gap-1.5">
          <NumberBox value={p.seed} min={0} max={2147483647} onChange={(seed) => set({ seed })} width={96} />
          <SmallButton icon={Dice5} label="Re-roll" title="A new take" onClick={() => set({ seed: newSeed() })} />
          <SmallButton icon={playing ? Square : Play} label={playing ? 'Stop' : 'Listen'} title="Audition this take on the channel" onClick={audition} active={playing} />
        </div>
      </Field>
      <Field label="Variations" hint="Four takes; click one to apply it" wide>
        <Variations plans={variations} seeds={seeds} current={p.seed} onPick={(s) => void apply(s)} />
      </Field>
    </DialogForm>
  );
}

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

export function openGenerateDialog(ctl: PianoRollController): void {
  if (!ctl.getTarget()) {
    flashHint('Select a pattern and a channel first', 'warn');
    return;
  }
  const v = usePianoRollView.getState();
  if (v.scale !== 'off') usePrefs.setState({ key: { root: v.scaleRoot, scale: v.scale } });
  const initialRange = defaultRange(ctl);
  openDialog({
    key: 'pianoRoll.tool',
    title: 'Generate',
    icon: WandSparkles,
    width: 540,
    doc: ctl.rootDocument(),
    near: ctl.rootRect() ?? undefined,
    subtitle: ctl.selectionSize ? `Replaces or adds to the ${ctl.selectionSize} selected notes` : 'Writes into this channel of the pattern',
    render: (close) => <GenerateBody ctl={ctl} close={close} initialRange={initialRange} />,
    onClose: () => {
      ctl.stopAudition();
      ctl.clearPreview();
    },
  });
}
