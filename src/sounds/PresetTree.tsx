import { useMemo, useState } from 'react';
import { ChevronRight, Download, Folder, FolderOpen, Layers, ScanSearch, SwatchBook, UserRound } from 'lucide-react';
import { pluginById } from '@shared/plugins/catalog';
import type { PresetSummary } from '@shared/sounds/types';
import { getProject } from '../doc/store';
import { effectiveChannelId, getUi } from '../state/ui';
import { openMenu, type MenuItem } from '../components/Menu';
import { flashHint } from '../app/hints';
import { cls } from '../utils/format';
import { encodePresetDrag, groupPresets, PRESET_MIME, roleLabel } from './logic';
import { presetList, useSounds } from './store';
import { addPresetChannel, applyChainPreset, deleteUserPreset, loadPresetOnChannel, renameUserPreset, revealUserPresets } from './actions';
import { showPackInHome, useMissingPack } from './packs';
import { needsPackMessage, packPhrase } from './packsLogic';
import { openSimilar } from './similar';

const indent = (depth: number): number => 6 + depth * 12;

function selectedInsertOrMaster(): string {
  const p = getProject();
  const s = getUi().selectedInsertId;
  return s && p.mixer.inserts[s] ? s : p.mixer.masterId;
}

function insertName(id: string): string {
  const ins = getProject().mixer.inserts[id];
  return !ins ? 'insert' : ins.isMaster ? 'the master' : ins.name;
}

function presetMenu(p: PresetSummary, pack: { id: string; name: string } | null): MenuItem[] {
  const items: MenuItem[] = [{ type: 'header', label: p.name }];
  if (pack) items.push({ label: `Get ${packPhrase(pack.name)}…`, icon: Download, hint: needsPackMessage(p.name, pack), onSelect: () => showPackInHome(pack.id) }, { type: 'separator' });
  if (p.kind === 'instrument') {
    const chId = effectiveChannelId();
    const ch = chId ? getProject().channels[chId] : null;
    items.push({ label: 'Add to Channel Rack', icon: SwatchBook, onSelect: () => void addPresetChannel(p.id) });
    if (ch) items.push({ label: `Load onto ${ch.name}`, hint: 'Replace the selected channel’s sound with this preset (one undo step)', onSelect: () => void loadPresetOnChannel(ch.id, p.id) });
    items.push({ label: 'More like this', icon: ScanSearch, hint: 'The closest presets and samples by timbre, in the Browser', onSelect: () => openSimilar({ kind: 'preset', id: p.id }, p.name) });
  } else {
    const ins = selectedInsertOrMaster();
    items.push(
      { label: `Load onto ${insertName(ins)}`, icon: Layers, hint: 'Replace the selected insert’s effects with this chain', onSelect: () => void applyChainPreset(ins, p.id, 'replace') },
      { label: `Add after ${insertName(ins)}’s effects`, hint: 'Append the chain to the selected insert', onSelect: () => void applyChainPreset(ins, p.id, 'append') },
    );
  }
  if (p.source === 'user') {
    items.push(
      { type: 'separator' },
      { label: 'Rename…', onSelect: () => void renameUserPreset(p) },
      { label: 'Show presets folder', onSelect: () => void revealUserPresets() },
      { label: 'Delete…', danger: true, onSelect: () => void deleteUserPreset(p) },
    );
  }
  return items;
}

export function PresetRow({ p, depth, selected, onSelect, showRole }: { p: PresetSummary; depth: number; selected: boolean; onSelect: (key: string) => void; showRole?: boolean }) {
  const Icon = p.kind === 'chain' ? Layers : SwatchBook;
  const plugin = p.kind === 'instrument' ? (pluginById(p.plugin ?? '')?.name ?? p.plugin ?? '') : '';
  const pack = useMissingPack()(p);
  const action = p.kind === 'chain' ? 'double-click to load onto the selected mixer insert, or drag onto an insert’s effects' : 'double-click or drag onto the Channel Rack to add it';
  return (
    <div
      draggable
      onDragStart={(ev) => {
        ev.dataTransfer.setData(PRESET_MIME, encodePresetDrag(p));
        ev.dataTransfer.setData('text/plain', p.name);
        ev.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => {
        onSelect(`preset:${p.id}`);
        flashHint(`${p.name}${plugin ? ` · ${plugin}` : ''}${p.description ? ` · ${p.description}` : ''}`, 'info', 4000);
      }}
      onDoubleClick={() => void (p.kind === 'chain' ? applyChainPreset(selectedInsertOrMaster(), p.id, 'replace') : addPresetChannel(p.id))}
      onContextMenu={(ev) => {
        ev.preventDefault();
        onSelect(`preset:${p.id}`);
        openMenu(ev, presetMenu(p, pack));
      }}
      className={cls(
        'group flex h-[22px] cursor-grab items-center gap-1.5 rounded pr-1.5 text-[11px] transition-colors',
        selected ? 'bg-white/[0.08] text-white' : 'text-white/80 hover:bg-white/[0.04] hover:text-white',
      )}
      style={{ paddingLeft: indent(depth) }}
      data-hint={pack ? needsPackMessage(p.name, pack) : `${p.name}${p.source === 'user' ? ' (yours)' : ''} · ${action}`}
    >
      <span className="w-3 flex-shrink-0" />
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-krypt-muted" />
      <span className={cls('truncate', pack && 'text-white/50')}>{p.name}</span>
      {showRole && <span className="flex-shrink-0 text-[9px] text-krypt-muted/70">{roleLabel(p.role, p.kind)}</span>}
      {pack && <Download className="ml-auto h-2.5 w-2.5 flex-shrink-0 text-krypt-purple/80" aria-label={`Needs ${packPhrase(pack.name)}`} />}
      {p.source === 'user' && <UserRound className={cls('h-2.5 w-2.5 flex-shrink-0 text-krypt-purple', !pack && 'ml-auto')} aria-label="Your preset" />}
    </div>
  );
}

function FolderRow({ label, count, open, depth, onToggle, hint }: { label: string; count: number; open: boolean; depth: number; onToggle: () => void; hint?: string }) {
  const Icon = open ? FolderOpen : Folder;
  return (
    <div
      onClick={onToggle}
      className="flex h-[22px] cursor-pointer items-center gap-1.5 rounded pr-1.5 text-[11px] text-white/80 transition-colors hover:bg-white/[0.04] hover:text-white"
      style={{ paddingLeft: indent(depth) }}
      data-hint={hint ?? label}
    >
      <ChevronRight className={cls('h-3 w-3 flex-shrink-0 text-krypt-muted transition-transform', open && 'rotate-90')} />
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple/80" />
      <span className="truncate">{label}</span>
      <span className="ml-auto flex-shrink-0 font-mono text-[9px] text-krypt-muted/60">{count}</span>
    </div>
  );
}

export function PresetTree({ depth, selected, onSelect }: { depth: number; selected: string | null; onSelect: (key: string) => void }) {
  const state = useSounds((s) => s.state);
  const error = useSounds((s) => s.error);
  const all = presetList(state);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const instruments = useMemo(() => groupPresets(all, { kind: 'instrument' }), [all]);
  const chains = useMemo(() => groupPresets(all, { kind: 'chain' }), [all]);
  const chainTotal = chains.reduce((n, g) => n + g.presets.length, 0);
  const toggle = (k: string): void => setOpen((o) => ({ ...o, [k]: !o[k] }));

  if (!instruments.length && !chains.length)
    return (
      <div className="py-0.5 text-[10px] leading-snug text-krypt-muted/80" style={{ paddingLeft: indent(depth) + 15 }}>
        {error ? `Couldn’t read presets: ${error}` : 'No presets yet. Save one from a channel’s plugin editor.'}
      </div>
    );

  return (
    <>
      {instruments.map((g) => (
        <div key={g.role}>
          <FolderRow label={g.label} count={g.presets.length} open={!!open[`i:${g.role}`]} depth={depth} onToggle={() => toggle(`i:${g.role}`)} />
          {open[`i:${g.role}`] && g.presets.map((p) => <PresetRow key={p.id} p={p} depth={depth + 1} selected={selected === `preset:${p.id}`} onSelect={onSelect} />)}
        </div>
      ))}
      {chains.length > 0 && (
        <div>
          <FolderRow label="Effect chains" count={chainTotal} open={!!open.chains} depth={depth} onToggle={() => toggle('chains')} hint="Ready-made effect chains for the master, buses, inserts and sends" />
          {open.chains &&
            chains.map((g) => (
              <div key={g.role}>
                <FolderRow label={g.label} count={g.presets.length} open={!!open[`c:${g.role}`]} depth={depth + 1} onToggle={() => toggle(`c:${g.role}`)} />
                {open[`c:${g.role}`] && g.presets.map((p) => <PresetRow key={p.id} p={p} depth={depth + 2} selected={selected === `preset:${p.id}`} onSelect={onSelect} />)}
              </div>
            ))}
        </div>
      )}
    </>
  );
}

export function usePresetMatches(query: string): PresetSummary[] {
  const state = useSounds((s) => s.state);
  const all = presetList(state);
  return useMemo(() => {
    if (!query.trim()) return [];
    return [...groupPresets(all, { kind: 'instrument', text: query }), ...groupPresets(all, { kind: 'chain', text: query })].flatMap((g) => g.presets).slice(0, 200);
  }, [all, query]);
}
