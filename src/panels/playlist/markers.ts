import type { Marker } from '@shared/schema/project';
import { cleanMarkerName, markerSection, MARKER_NAME_MAX } from '@shared/commands/markers';
import { MARKER_BAND_H } from './markerHits';
import { formatBBT, type TimeSig } from '@shared/schema/time';
import { RULER_FONT } from '../../editors/gridPaint';
import { dispatch } from '../../doc/store';
import { flashHint } from '../../app/hints';
import type { MenuItem } from '../../components/Menu';
import { Flag, Pencil, Repeat, Trash2 } from 'lucide-react';

export { MARKER_BAND_H, hitMarker, markersWithDrag, type MarkerDrag } from './markerHits';

let measureCtx: CanvasRenderingContext2D | null = null;
export function markerLabelWidth(name: string): number {
  try {
    measureCtx ??= document.createElement('canvas').getContext('2d');
  } catch {
    measureCtx = null;
  }
  if (!measureCtx) return name.length * 6;
  measureCtx.font = RULER_FONT;
  return measureCtx.measureText(name).width;
}

export async function moveMarker(m: Marker, tick: number, ts: TimeSig): Promise<void> {
  const r = await dispatch('playlist.moveMarker', { id: m.id, tick: Math.max(0, Math.round(tick)) });
  if (r.ok) flashHint(`Moved "${m.name}" to ${formatBBT(tick, ts)}`, 'ok');
}

export async function renameMarker(m: Marker, name: string): Promise<boolean> {
  const clean = cleanMarkerName(name);
  if (clean === m.name) return true;
  const r = await dispatch('playlist.renameMarker', { id: m.id, name });
  if (r.ok) flashHint(`Renamed to "${clean}"`, 'ok');
  return r.ok;
}

export async function removeMarker(m: Marker): Promise<void> {
  const r = await dispatch('playlist.removeMarker', { id: m.id });
  if (r.ok) flashHint(`Deleted marker "${m.name}"`, 'ok');
}

export async function loopMarkerSection(markers: Record<string, Marker>, m: Marker, songEnd: number, barTicks: number): Promise<void> {
  const s = markerSection(markers, m.id, songEnd, barTicks);
  if (!s) return;
  const r = await dispatch('transport.set', { loop: { enabled: true, start: s.start, end: s.end } }, { label: `Loop "${m.name}"` });
  if (r.ok) flashHint(`Looping "${m.name}"`, 'ok');
}

export function editMarkerInline(host: HTMLElement, m: Marker, x: number): () => void {
  const doc = host.ownerDocument;
  host.querySelector('input[data-marker-edit]')?.remove();
  const input = doc.createElement('input');
  input.dataset.markerEdit = m.id;
  input.value = m.name;
  input.maxLength = MARKER_NAME_MAX;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Marker name');
  input.className = 'absolute z-10 rounded-sm border border-krypt-pink/70 bg-krypt-void px-1 font-mono text-[10px] text-white outline-none';
  Object.assign(input.style, { left: `${Math.max(0, x + 6)}px`, top: '0px', height: `${MARKER_BAND_H + 1}px`, width: `${Math.max(90, markerLabelWidth(m.name) + 28)}px` });
  let done = false;
  const close = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value;
    input.remove();
    if (save) void renameMarker(m, v);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') close(true);
    else if (e.key === 'Escape') close(false);
  });
  input.addEventListener('blur', () => close(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  host.appendChild(input);
  input.focus();
  input.select();
  return () => close(false);
}

export interface MarkerMenuDeps {
  markers: Record<string, Marker>;
  songEnd: number;
  barTicks: number;
  ts: TimeSig;
  rename: () => void;
  locate: (tick: number) => void;
}

export function markerMenuItems(m: Marker, d: MarkerMenuDeps): MenuItem[] {
  const s = markerSection(d.markers, m.id, d.songEnd, d.barTicks);
  return [
    { type: 'header', label: `${m.name} · ${formatBBT(m.tick, d.ts)}` },
    { label: 'Rename…', icon: Pencil, hint: 'Or double-click the marker', onSelect: d.rename },
    { label: 'Jump here', icon: Flag, onSelect: () => d.locate(m.tick) },
    {
      label: 'Loop this section',
      icon: Repeat,
      disabled: !s,
      hint: s ? `${formatBBT(s.start, d.ts)} to ${formatBBT(s.end, d.ts)}: up to the next marker or the song end` : undefined,
      onSelect: () => void loopMarkerSection(d.markers, m, d.songEnd, d.barTicks),
    },
    { type: 'separator' },
    { label: 'Delete marker', icon: Trash2, danger: true, onSelect: () => void removeMarker(m) },
  ];
}
