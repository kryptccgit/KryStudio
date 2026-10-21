// Piano Roll panel. React renders the chrome ONCE; the canvas surfaces are
// driven imperatively by PianoRollController (no re-render during gestures).
// Edits (activePatternId, selected channel from src/editors/selection.ts).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Blend, Braces, ChevronDown, Ghost, Grid3x3, Layers, LocateFixed, Magnet, MicVocal, Music, Piano, Spline, WandSparkles, Wrench, type LucideIcon } from 'lucide-react';
import { CHORD_QUALITIES, NOTE_NAMES_SHARP, SCALES } from '@shared/music/theory';
import { TICKS_PER_STEP } from '@shared/schema/time';
import { dispatch, useDocStore } from '../../doc/store';
import { SNAP_OPTIONS, type SnapId } from '../../editors/snap';
import { TOOLS } from '../../editors/tools';
import { resolveChannel, useEditorSelection, isNoteChannel } from '../../editors/selection';
import { ScrollTrack, Sep, ToolBar, ToolButton, ToolSelect } from '../../editors/ui';
import { MOD_KEY } from '../../utils/format';
import { toggleMenuAt, type MenuItem } from '../../components/Menu';
import { PianoRollController, PR, prRows } from './controller';
import { LANE_PROPS, PR_TOOLS, usePianoRollView, type LaneProp } from './store';
import { NOTE_COLORS } from './paint';
import { colorItems, toolsMenuItems } from './toolDialogs';
import { openGenerateDialog } from './generateDialog';
import { openScriptsDialog } from './scriptsDialog';
import { openSingDialog } from '../../voice/SingDialog';
import { shortcutFor } from '../../input/keymap';

const CHORD_OPTIONS = [
  { value: '', label: 'Single note' },
  ...['maj', 'm', '5', 'dim', 'aug', 'sus2', 'sus4', '6', 'm6', '7', 'maj7', 'm7', 'mmaj7', 'dim7', 'm7b5', 'add9', 'madd9', '9', 'maj9', 'm9', '11', 'm11', '13']
    .filter((q) => CHORD_QUALITIES[q])
    .map((q) => ({ value: q, label: `Chord ${q}` })),
];

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
  majorPentatonic: 'Major pent.',
  minorPentatonic: 'Minor pent.',
  blues: 'Blues',
  chromatic: 'Chromatic',
};
const SCALE_OPTIONS = [{ value: 'off', label: 'No scale' }, ...Object.keys(SCALES).map((s) => ({ value: s, label: SCALE_LABELS[s] ?? s }))];
const ROOT_OPTIONS = NOTE_NAMES_SHARP.map((n, i) => ({ value: String(i), label: n }));
const LANE_OPTIONS = (Object.keys(LANE_PROPS) as LaneProp[]).map((p) => ({ value: p, label: LANE_PROPS[p].short, title: LANE_PROPS[p].label }));

function lenLabel(t: number): string {
  if (t % (TICKS_PER_STEP * 4) === 0) return `${t / (TICKS_PER_STEP * 4)} beat${t === TICKS_PER_STEP * 4 ? '' : 's'}`;
  if (t % TICKS_PER_STEP === 0) return `${t / TICKS_PER_STEP} step${t === TICKS_PER_STEP ? '' : 's'}`;
  return `${t} ticks`;
}

export function PianoRoll() {
  const [ctl] = useState(() => new PianoRollController());
  const r = {
    root: useRef<HTMLDivElement>(null),
    body: useRef<HTMLDivElement>(null),
    keysHost: useRef<HTMLDivElement>(null),
    keys: useRef<HTMLCanvasElement>(null),
    rulerHost: useRef<HTMLDivElement>(null),
    ruler: useRef<HTMLCanvasElement>(null),
    gridHost: useRef<HTMLDivElement>(null),
    grid: useRef<HTMLCanvasElement>(null),
    content: useRef<HTMLCanvasElement>(null),
    overlay: useRef<HTMLCanvasElement>(null),
    laneHost: useRef<HTMLDivElement>(null),
    lane: useRef<HTMLCanvasElement>(null),
    ph1: useRef<HTMLDivElement>(null),
    ph2: useRef<HTMLDivElement>(null),
    ph3: useRef<HTMLDivElement>(null),
    splitter: useRef<HTMLDivElement>(null),
    hTrack: useRef<HTMLDivElement>(null),
    hThumb: useRef<HTMLDivElement>(null),
    vTrack: useRef<HTMLDivElement>(null),
    vThumb: useRef<HTMLDivElement>(null),
  };

  useEffect(() => {
    const req = <T,>(x: { current: T | null }) => x.current as T;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__kryptPianoRoll = ctl; // devtools / scripted UI checks
    return ctl.attach({
      root: req(r.root),
      body: req(r.body),
      keysHost: req(r.keysHost),
      keys: req(r.keys),
      rulerHost: req(r.rulerHost),
      ruler: req(r.ruler),
      gridHost: req(r.gridHost),
      grid: req(r.grid),
      content: req(r.content),
      overlay: req(r.overlay),
      laneHost: req(r.laneHost),
      lane: req(r.lane),
      playheads: [req(r.ph1), req(r.ph2), req(r.ph3)],
      splitter: req(r.splitter),
      hTrack: req(r.hTrack),
      hThumb: req(r.hThumb),
      vTrack: req(r.vTrack),
      vThumb: req(r.vThumb),
    });
    // refs are stable; attach once per controller
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl]);

  const laneH = usePianoRollView((s) => s.laneH);
  const lane = usePianoRollView((s) => s.lane);
  const set = usePianoRollView((s) => s.set);
  const hasTarget = useDocStore((s) => !!s.project?.transport.activePatternId && !!resolveChannel(s.project, null));

  return (
    <div ref={r.root} data-editor-root="" data-editor="pianoRoll" tabIndex={0} className="flex h-full w-full min-w-0 flex-col bg-krypt-void text-white outline-none" onContextMenu={(e) => e.preventDefault()}>
      <PianoRollToolbar ctl={ctl} />
      <div
        ref={r.body}
        className="relative grid min-h-0 flex-1 select-none"
        style={{ gridTemplateColumns: `${PR.keyW}px minmax(0,1fr) ${PR.sb}px`, gridTemplateRows: prRows(laneH) }}
      >
        {/* row 1: corner · ruler · corner */}
        <div className="border-b border-r border-white/10 bg-krypt-panel" />
        <div ref={r.rulerHost} className="relative overflow-hidden cursor-pointer" title="Click to set the play position">
          <canvas ref={r.ruler} className="absolute left-0 top-0" />
          <div ref={r.ph1} className="pointer-events-none absolute left-0 top-0 h-full" style={{ display: 'none' }}>
            <div className="absolute -left-[5px] bottom-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-krypt-pink" />
          </div>
        </div>
        <div className="border-b border-white/10 bg-krypt-panel" />

        {/* row 2: keyboard · grid · vscroll */}
        <div ref={r.keysHost} className="relative overflow-hidden">
          <canvas ref={r.keys} className="absolute left-0 top-0 cursor-pointer" />
        </div>
        <div ref={r.gridHost} className="relative overflow-hidden">
          <canvas ref={r.grid} className="absolute left-0 top-0" />
          <canvas ref={r.content} className="absolute left-0 top-0" />
          <canvas ref={r.overlay} className="absolute left-0 top-0" style={{ touchAction: 'none' }} />
          <div ref={r.ph2} className="pointer-events-none absolute left-0 top-0 h-full w-px bg-krypt-pink shadow-[0_0_8px_rgba(236,72,153,0.8)]" style={{ display: 'none' }} />
          {!hasTarget && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-krypt-muted">
              Select a pattern and a channel to edit notes
            </div>
          )}
        </div>
        <ScrollTrack axis="y" trackRef={r.vTrack} thumbRef={r.vThumb} />

        {/* row 3: splitter */}
        <div ref={r.splitter} className="col-span-3 cursor-row-resize border-y border-white/10 bg-krypt-panel hover:bg-krypt-purple/30" title="Drag to resize the note-property lane" />

        {/* row 4: lane */}
        <div className="flex flex-col gap-1 overflow-hidden border-r border-white/10 bg-krypt-panel p-1">
          <select
            value={lane}
            onChange={(e) => {
              set({ lane: e.target.value as LaneProp });
              r.root.current?.focus({ preventScroll: true });
            }}
            title="Note property shown in the lane"
            className="w-full cursor-pointer rounded border border-white/10 bg-krypt-void px-0.5 py-0.5 font-mono text-[10px] text-white/80 outline-none"
          >
            {LANE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} title={o.title} className="bg-krypt-surface">
                {o.label}
              </option>
            ))}
          </select>
          <span className="px-0.5 text-[9px] leading-tight text-white/30">Drag to paint · Alt = default</span>
        </div>
        <div ref={r.laneHost} data-guide="pianoRoll.velocity" className="relative overflow-hidden">
          <canvas ref={r.lane} className="absolute left-0 top-0 cursor-ns-resize" style={{ touchAction: 'none' }} />
          <div ref={r.ph3} className="pointer-events-none absolute left-0 top-0 h-full w-px bg-krypt-pink/70" style={{ display: 'none' }} />
        </div>
        <div className="bg-krypt-panel" />

        {/* row 5: hscroll */}
        <div className="border-r border-t border-white/10 bg-krypt-panel" />
        <ScrollTrack axis="x" trackRef={r.hTrack} thumbRef={r.hThumb} />
        <div className="border-t border-white/10 bg-krypt-panel" />
      </div>
    </div>
  );
}

/** Toolbar dropdown (Tools menu, colour groups); keyboard focus returns to the roll afterwards. */
function MenuButton({ ctl, title, items, icon: Icon, label, children }: { ctl: PianoRollController; title: string; items: () => MenuItem[]; icon?: LucideIcon; label?: string; children?: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      aria-label={title}
      onPointerDown={(e) => e.preventDefault() /* keep keyboard focus on the editor */}
      onClick={() => ref.current && toggleMenuAt(ref.current, items, { minWidth: 230, onClose: () => ctl.focus() })}
      className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-white/65 transition hover:bg-white/5 hover:text-white"
    >
      {Icon && <Icon size={15} strokeWidth={1.8} />}
      {children}
      {label && <span className="text-[11px] font-semibold">{label}</span>}
      <ChevronDown size={11} className="text-white/35" />
    </button>
  );
}

function PianoRollToolbar({ ctl }: { ctl: PianoRollController }) {
  const v = usePianoRollView();
  const selectedChannel = useEditorSelection((s) => s.channelId);
  const setChannel = useEditorSelection((s) => s.setChannel);
  // primitive selectors → re-render only when names/colors change
  const patKey = useDocStore((s) => (s.project ? s.project.patternOrder.map((id) => `${id}\u0001${s.project!.patterns[id]?.name ?? ''}`).join('\u0002') : ''));
  const chKey = useDocStore((s) =>
    s.project
      ? s.project.channelOrder
          .filter((id) => isNoteChannel(s.project!, id))
          .map((id) => `${id}\u0001${s.project!.channels[id].name}\u0001${s.project!.channels[id].color}`)
          .join('\u0002')
      : '',
  );
  const activePat = useDocStore((s) => s.project?.transport.activePatternId ?? '');
  const channelId = useDocStore((s) => resolveChannel(s.project, selectedChannel) ?? '');
  const patterns = patKey ? patKey.split('\u0002').map((s) => s.split('\u0001')) : [];
  const channels = chKey ? chKey.split('\u0002').map((s) => s.split('\u0001')) : [];
  const chColor = channels.find((c) => c[0] === channelId)?.[2] ?? '#A855F7';

  return (
    <ToolBar data-guide="pianoRoll.tools">
      <ToolSelect
        title="Pattern"
        icon={Layers}
        value={activePat}
        onChange={(id) => void dispatch('patterns.select', { id })}
        options={patterns.map(([id, name]) => ({ value: id, label: name }))}
        className="max-w-[150px]"
      />
      <label className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-krypt-void pl-2 pr-0.5" title="Channel (target of the piano roll)">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: chColor }} />
        <select
          value={channelId}
          onChange={(e) => {
            setChannel(e.target.value);
            (e.target.closest('[data-editor-root]') as HTMLElement | null)?.focus({ preventScroll: true });
          }}
          className="h-full max-w-[120px] cursor-pointer bg-transparent pr-1 font-mono text-[11px] text-white/85 outline-none"
        >
          {channels.map(([id, name]) => (
            <option key={id} value={id} className="bg-krypt-surface">
              {name}
            </option>
          ))}
        </select>
      </label>
      <Sep />
      {PR_TOOLS.map((t) => (
        <ToolButton key={t} icon={TOOLS[t].icon} label={TOOLS[t].label} shortcut={TOOLS[t].key} active={v.tool === t} onClick={() => v.set({ tool: t })} />
      ))}
      <Sep />
      <MenuButton ctl={ctl} title="Tools: quantize, chop, glue, strum, arpeggiate, randomize, flip, levels…" items={() => toolsMenuItems(ctl)} icon={Wrench} label="Tools" />
      <ToolButton data-guide="pianoRoll.generate" icon={WandSparkles} label="Generate: rhythm, chords, arp, melody or bass in the key" shortcut={shortcutFor('pianoRoll.generate') || undefined} onClick={() => openGenerateDialog(ctl)} />
      <ToolButton data-guide="pianoRoll.scripts" icon={Braces} label="Scripts: note devices in JavaScript (yours, the AI's or the factory ones)" shortcut={shortcutFor('pianoRoll.scripts') || undefined} onClick={() => openScriptsDialog(ctl)} />
      <ToolButton data-guide="voice.sing" icon={MicVocal} label="Sing my notes: type lyrics and a voice sings them on this melody (Krypt Voice)" shortcut={shortcutFor('pianoRoll.sing') || undefined} onClick={() => openSingDialog(ctl)} />
      <MenuButton ctl={ctl} title="Note colour group: new notes use it, and it recolours the selection" items={() => colorItems(ctl)}>
        <span className="h-3 w-3 rounded-sm border border-white/30" style={{ background: NOTE_COLORS[v.noteColor] ?? NOTE_COLORS[0] }} />
      </MenuButton>
      <ToolButton icon={Spline} label="Slide: new notes glide from the previous note" active={v.slideMode} onClick={() => v.set({ slideMode: !v.slideMode })} />
      <ToolButton icon={Grid3x3} label="Quantize selection (or all)" shortcut={`${MOD_KEY}+Q`} onClick={() => void ctl.quantize()} />
      <Sep />
      <ToolSelect<SnapId> data-guide="pianoRoll.snap" title="Snap (hold Alt to bypass)" icon={Magnet} value={v.snap} onChange={(snap) => v.set({ snap })} options={SNAP_OPTIONS.map((o) => ({ value: o.id, label: o.label }))} />
      <ToolSelect title="Chord stamp: Draw places the whole chord" icon={Music} value={v.chord} onChange={(chord) => v.set({ chord })} options={CHORD_OPTIONS} />
      <ToolSelect title="Scale root" icon={Piano} value={String(v.scaleRoot)} onChange={(x) => v.set({ scaleRoot: Number(x) })} options={ROOT_OPTIONS} />
      <ToolSelect data-guide="pianoRoll.scale" title="Scale highlight" value={v.scale} onChange={(scale) => v.set({ scale })} options={SCALE_OPTIONS} />
      <Sep />
      <ToolButton icon={Ghost} label="Ghost notes (other channels)" active={v.ghosts} onClick={() => v.set({ ghosts: !v.ghosts })} />
      <ToolButton icon={Blend} label="Velocity as opacity (notes in their colour group)" active={v.velAlpha} onClick={() => v.set({ velAlpha: !v.velAlpha })} />
      <ToolButton icon={LocateFixed} label="Follow playhead" active={v.follow} onClick={() => v.set({ follow: !v.follow })} />
      <div className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-white/35" title="New notes take the last used length (click a note to pick its length)">
        len {lenLabel(v.lastLen)}
      </div>
    </ToolBar>
  );
}
