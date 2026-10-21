// ──────────────────────────────────────────────────────────────────────
// "Save preset…" (a channel's sound) and "Save chain as preset…" (a mixer
// insert's effects): name, role, genres, tags, description (+ include
// effects for a channel). Main writes the file (window.krypt.sounds); the
// dialog stays open with a toast when that fails.
// ──────────────────────────────────────────────────────────────────────

import { useMemo, useState, type ReactNode } from 'react';
import { Layers, Save } from 'lucide-react';
import { pluginById } from '@shared/plugins/catalog';
import { GENRES, type GenreId } from '@shared/sounds/genres';
import { CHAIN_ROLES, COMMON_TAGS, INSTRUMENT_ROLES, type ChainRole, type InstrumentRole } from '@shared/sounds/types';
import { getProject } from '../doc/store';
import { Check, DialogForm, DialogSelect, Field, openDialog } from '../components/Dialog';
import { toast } from '../app/notify';
import { cls } from '../utils/format';
import { CHAIN_ROLE_LABELS, INSTRUMENT_ROLE_NAMES, guessChainRole, parseTagList, presetSaveDefaults, validatePresetName } from './logic';
import { openPresetsInBrowser } from './actions';
import { factoryPreset } from '@shared/sounds/factory';
import { useSounds } from './store';

const input =
  'h-8 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 text-[12px] text-white placeholder-krypt-muted/50 outline-none transition focus:border-krypt-purple/60';

function Chips<T extends string>({ all, on, onToggle, label }: { all: ReadonlyArray<{ id: T; name: string }>; on: readonly T[]; onToggle: (id: T) => void; label: (id: T) => string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((g) => (
        <button
          key={g.id}
          type="button"
          aria-pressed={on.includes(g.id)}
          onClick={() => onToggle(g.id)}
          className={cls(
            'h-5 rounded-full border px-2 text-[10px] font-semibold transition',
            on.includes(g.id) ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/[0.03] text-white/55 hover:border-white/20 hover:text-white',
          )}
        >
          {label(g.id)}
        </button>
      ))}
    </div>
  );
}

interface MetaState {
  name: string;
  tags: string;
  genres: GenreId[];
  description: string;
}

/** Name, genres, tags and description: the part both dialogs share. */
function MetaFields({ meta, set, roleField }: { meta: MetaState; set: (patch: Partial<MetaState>) => void; roleField: ReactNode }) {
  const nameErr = validatePresetName(meta.name);
  const tagList = parseTagList(meta.tags);
  const toggleTag = (t: string): void => {
    const next = tagList.includes(t) ? tagList.filter((x) => x !== t) : [...tagList, t];
    set({ tags: next.join(', ') });
  };
  const genreItems = useMemo(() => GENRES.map((g) => ({ id: g.id, name: g.name })), []);
  return (
    <>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label="Name" wide>
          <input data-autofocus value={meta.name} maxLength={64} onChange={(e) => set({ name: e.target.value })} className={input} placeholder="e.g. Night Pluck" />
          {nameErr && meta.name !== '' && <div className="mt-1 text-[10px] text-rose-300">{nameErr}</div>}
        </Field>
        {roleField}
      </div>
      <Field label="Genres" hint="Agents and the genre filter use these. None = fits anything." wide>
        <Chips all={genreItems} on={meta.genres} onToggle={(id) => set({ genres: meta.genres.includes(id) ? meta.genres.filter((g) => g !== id) : [...meta.genres, id] })} label={(id) => genreItems.find((g) => g.id === id)?.name ?? id} />
      </Field>
      <Field label="Tags" hint="Words that describe it, separated by commas. Click to add a common one." wide>
        <input value={meta.tags} onChange={(e) => set({ tags: e.target.value })} className={input} placeholder="dark, wide, punchy" />
        <div className="mt-1.5 flex flex-wrap gap-1">
          {COMMON_TAGS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => toggleTag(t)}
              className={cls(
                'rounded-full border px-1.5 text-[9.5px] leading-4 transition',
                tagList.includes(t) ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/[0.08] text-krypt-muted hover:border-white/20 hover:text-white',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Description" hint="One sentence: what it sounds like and when to use it." wide>
        <textarea
          value={meta.description}
          maxLength={300}
          rows={2}
          onChange={(e) => set({ description: e.target.value })}
          className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[12px] leading-relaxed text-white placeholder-krypt-muted/50 outline-none transition focus:border-krypt-purple/60"
          placeholder="Bright detuned pluck for drops and hooks."
        />
      </Field>
    </>
  );
}

// ── Channel sound ─────────────────────────────────────────────────────

function SaveChannelForm({ channelId, close }: { channelId: string; close: () => void }) {
  const p = getProject();
  const ch = p.channels[channelId];
  const cached = useSounds((s) => (ch?.generator.preset ? s.cache[ch.generator.preset.id] : undefined));
  const loaded = ch?.generator.preset ? (factoryPreset(ch.generator.preset.id) ?? cached) : undefined;
  const defaults = presetSaveDefaults(ch?.name ?? 'Sound', loaded && loaded.kind === 'instrument' ? loaded : null);
  const [meta, setMeta] = useState<MetaState>({ name: defaults.name, tags: defaults.tags.join(', '), genres: defaults.genres, description: defaults.description });
  const [role, setRole] = useState<InstrumentRole>(defaults.role);
  const ins = ch ? p.mixer.inserts[ch.insertId] : undefined;
  const fxCount = ins?.slotOrder.length ?? 0;
  const ownInsert = !!ins && !ins.isMaster;
  const [withFx, setWithFx] = useState(ownInsert && fxCount > 0);
  const [busy, setBusy] = useState(false);
  if (!ch) return <div className="p-4 text-[12px] text-krypt-muted">This channel no longer exists.</div>;
  const nameErr = validatePresetName(meta.name);

  const submit = async (): Promise<void> => {
    if (nameErr) {
      toast.warn(nameErr);
      return;
    }
    setBusy(true);
    try {
      const r = await window.krypt.sounds.saveChannel(channelId, {
        name: meta.name.trim(),
        role,
        tags: parseTagList(meta.tags),
        genres: meta.genres,
        description: meta.description.trim(),
        withFx: withFx && ownInsert,
      });
      if (r.ok) {
        close();
        toast.success(`Saved preset ${r.data?.name ?? meta.name.trim()}`, { action: { label: 'Show in Browser', run: openPresetsInBrowser } });
      } else toast.error(r.message || 'Couldn’t save the preset');
    } catch (err) {
      toast.error(`Couldn’t save the preset: ${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  const fxHint = !ins
    ? 'This channel has no mixer insert.'
    : ins.isMaster
      ? 'This channel plays straight into the master, so no effects are saved with it.'
      : fxCount
        ? `Saves the ${fxCount} effect${fxCount === 1 ? '' : 's'} on insert “${ins.name}” with the sound.`
        : `Insert “${ins.name}” has no effects yet.`;

  return (
    <DialogForm onSubmit={() => void submit()} onCancel={close} submitLabel="Save preset" submitDisabled={!!nameErr} busy={busy} extra={`${pluginById(ch.generator.type)?.name ?? ch.generator.type} · your presets folder`}>
      <MetaFields
        meta={meta}
        set={(patch) => setMeta((m) => ({ ...m, ...patch }))}
        roleField={
          <Field label="Role" wide>
            <DialogSelect value={role} onChange={setRole} width={130} options={INSTRUMENT_ROLES.map((r) => ({ value: r, label: INSTRUMENT_ROLE_NAMES[r] }))} />
          </Field>
        }
      />
      <div className={cls(!ownInsert || !fxCount ? 'opacity-60' : '')}>
        <Check checked={withFx && ownInsert} onChange={(v) => ownInsert && setWithFx(v)} label="Include effects" hint={fxHint} />
      </div>
    </DialogForm>
  );
}

export function openSavePresetDialog(channelId: string, doc?: Document | null): void {
  const ch = getProject().channels[channelId];
  if (!ch) {
    toast.error('That channel no longer exists');
    return;
  }
  openDialog({
    key: 'save-preset',
    title: 'Save preset',
    subtitle: `${ch.name}'s sound, for this and every other project. Agents can find it too.`,
    icon: Save,
    width: 500,
    doc,
    render: (close) => <SaveChannelForm channelId={channelId} close={close} />,
  });
}

// ── Insert chain ──────────────────────────────────────────────────────

function SaveChainForm({ insertId, close }: { insertId: string; close: () => void }) {
  const ins = getProject().mixer.inserts[insertId];
  const [meta, setMeta] = useState<MetaState>({ name: ins ? (ins.isMaster ? 'My master chain' : `${ins.name} chain`).slice(0, 64) : '', tags: '', genres: [], description: '' });
  const [role, setRole] = useState<ChainRole>(guessChainRole(ins?.name ?? '', !!ins?.isMaster));
  const [busy, setBusy] = useState(false);
  if (!ins) return <div className="p-4 text-[12px] text-krypt-muted">This insert no longer exists.</div>;
  const nameErr = validatePresetName(meta.name);
  const names = ins.slotOrder.map((s) => pluginById(ins.slots[s]?.type ?? '')?.name.replace(/^Krypt /, '') ?? 'Plugin');

  const submit = async (): Promise<void> => {
    if (nameErr) {
      toast.warn(nameErr);
      return;
    }
    setBusy(true);
    try {
      const r = await window.krypt.sounds.saveChain(insertId, {
        name: meta.name.trim(),
        role,
        tags: parseTagList(meta.tags),
        genres: meta.genres,
        description: meta.description.trim(),
      });
      if (r.ok) {
        close();
        toast.success(`Saved chain ${r.data?.name ?? meta.name.trim()}`, { action: { label: 'Show in Browser', run: openPresetsInBrowser } });
      } else toast.error(r.message || 'Couldn’t save the chain');
    } catch (err) {
      toast.error(`Couldn’t save the chain: ${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogForm onSubmit={() => void submit()} onCancel={close} submitLabel="Save chain" submitDisabled={!!nameErr} busy={busy} extra={names.join(' → ')}>
      <MetaFields
        meta={meta}
        set={(patch) => setMeta((m) => ({ ...m, ...patch }))}
        roleField={
          <Field label="Goes on" wide>
            <DialogSelect value={role} onChange={setRole} width={130} options={CHAIN_ROLES.map((r) => ({ value: r, label: CHAIN_ROLE_LABELS[r] }))} />
          </Field>
        }
      />
    </DialogForm>
  );
}

export function openSaveChainDialog(insertId: string, doc?: Document | null): void {
  const ins = getProject().mixer.inserts[insertId];
  if (!ins) {
    toast.error('That mixer insert no longer exists');
    return;
  }
  if (!ins.slotOrder.length) {
    toast.warn(`${ins.isMaster ? 'The master' : ins.name} has no effects to save yet. Add some first.`);
    return;
  }
  openDialog({
    key: 'save-chain',
    title: 'Save chain as preset',
    subtitle: `The ${ins.slotOrder.length} effect${ins.slotOrder.length === 1 ? '' : 's'} on ${ins.isMaster ? 'the master' : ins.name}, with their settings.`,
    icon: Layers,
    width: 500,
    doc,
    render: (close) => <SaveChainForm insertId={insertId} close={close} />,
  });
}
