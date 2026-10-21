import { useEffect, useId, useState } from 'react';
import { Download, ImagePlus, Loader2, Shuffle, Sparkles, Trash2 } from 'lucide-react';
import { COVER_STYLES, MP3_BITRATES, type CoverPreview, type CoverStyle, type Mp3Kbps } from '@shared/types';
import { formatBBT, ticksToSeconds } from '@shared/schema/time';
import { dispatch, getProject, useProject } from '../doc/store';
import { Check, DialogForm, DialogSelect, Field, NumberBox, RangeField, Segmented, openDialog } from '../components/Dialog';
import { fmtClock } from '../utils/format';
import { useProjectStatus } from '../state/status';
import { report, toast } from './notify';
import { flashHint } from './hints';
import { GENRES } from './ProjectInfoDialog';
import { renderCover, styleForSeed } from './coverArt';
import { exportRequest, formatLabel, loadExportPrefs, saveExportPrefs, type ExportPrefs, type ExportRunner, type ExportScope } from './exportRequest';

const input =
  'h-7 w-full rounded-lg border border-white/10 bg-black/40 px-2 text-[12px] text-white placeholder-krypt-muted/50 outline-none transition focus:border-krypt-purple/60';

const STYLE_LABEL: Record<CoverStyle, string> = { waves: 'Waves', grid: 'Grid', orbit: 'Orbit', bars: 'Bars' };

interface InfoFields {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  track: string;
}

function infoFromMeta(): InfoFields {
  const m = getProject().meta;
  return { title: m.title ?? '', artist: m.artist ?? '', album: m.album ?? '', year: m.year ? String(m.year) : '', genre: m.genre ?? '', track: m.trackNumber ? String(m.trackNumber) : '' };
}

function infoPatch(f: InfoFields): { args: Record<string, unknown> | null; error: string | null } {
  const m = getProject().meta;
  const args: Record<string, unknown> = {};
  const year = f.year.trim();
  const track = f.track.trim();
  if (year && !/^\d{4}$/.test(year)) return { args: null, error: 'Year is four digits, e.g. 2026' };
  if (track && !(/^\d{1,3}$/.test(track) && Number(track) >= 1)) return { args: null, error: 'Track # is a number from 1 to 999' };
  if (f.title.trim() !== (m.title ?? '')) args.title = f.title.trim();
  if (f.artist.trim() !== (m.artist ?? '')) args.artist = f.artist.trim();
  if (f.album.trim() !== (m.album ?? '')) args.album = f.album.trim();
  if (f.genre.trim() !== (m.genre ?? '')) args.genre = f.genre.trim();
  if ((year ? Number(year) : undefined) !== m.year) args.year = year ? Number(year) : null;
  if ((track ? Number(track) : undefined) !== m.trackNumber) args.trackNumber = track ? Number(track) : null;
  return { args: Object.keys(args).length ? args : null, error: null };
}

function CoverPicker({ text }: { text: { title: string; artist: string } }) {
  const coverFile = useProject((p) => p.meta.cover?.file ?? null);
  const [preview, setPreview] = useState<CoverPreview | null>(null);
  const [busy, setBusy] = useState<null | 'choose' | 'generate' | 'remove'>(null);
  const [seed, setSeed] = useState(1);
  const [style, setStyle] = useState<CoverStyle>('waves');

  useEffect(() => {
    let live = true;
    if (!coverFile) {
      setPreview(null);
      return;
    }
    void window.krypt.project
      .cover()
      .then((r) => {
        if (!live) return;
        if (r.ok) setPreview(r.data ?? null);
        else toast.error(`Couldn't show the cover: ${r.message ?? 'unknown error'}`);
      })
      .catch((err) => toast.error(`Couldn't show the cover: ${(err as Error)?.message ?? err}`));
    return () => {
      live = false;
    };
  }, [coverFile]);

  const choose = async (): Promise<void> => {
    setBusy('choose');
    try {
      const r = await window.krypt.project.chooseCover();
      if (!r.ok && /cancel/i.test(r.message ?? '')) return;
      if (report(r)) flashHint(r.message ?? 'Cover set', 'ok');
    } catch (err) {
      toast.error(`Choose image failed: ${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(null);
    }
  };

  const generate = async (nextSeed: number, nextStyle: CoverStyle): Promise<void> => {
    setBusy('generate');
    try {
      const img = await renderCover(getProject(), { style: nextStyle, seed: nextSeed, title: text.title, artist: text.artist });
      const r = await window.krypt.project.setCoverImage(img.bytes, img.mime, `Generate cover art (${STYLE_LABEL[nextStyle]})`);
      if (report(r)) flashHint(`Cover generated: ${STYLE_LABEL[nextStyle]} #${nextSeed}`, 'ok');
    } catch (err) {
      toast.error(`Generate cover failed: ${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(null);
    }
  };

  const shuffle = (): void => {
    const s = seed + 1;
    const st = styleForSeed(s);
    setSeed(s);
    setStyle(st);
    void generate(s, st);
  };

  const remove = async (): Promise<void> => {
    setBusy('remove');
    const r = await dispatch('project.clearCover', {}, { label: 'Remove cover art' });
    setBusy(null);
    if (r.ok) flashHint('Cover removed (undo brings it back)', 'ok');
  };

  const btn =
    'inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-[11px] font-semibold text-white/85 transition hover:border-white/20 hover:bg-white/10 disabled:opacity-40';
  return (
    <div className="flex w-[176px] flex-shrink-0 flex-col gap-1.5">
      <div className="relative h-[176px] w-[176px] overflow-hidden rounded-xl border border-white/10 bg-black/40" data-hint="The cover embedded in your exports">
        {preview ? (
          <img src={preview.dataUrl} alt="Cover art" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center text-[10px] leading-snug text-krypt-muted">
            <ImagePlus size={20} strokeWidth={1.6} className="text-white/30" />
            No cover yet
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Loader2 size={18} className="animate-spin text-white/80" />
          </div>
        )}
      </div>
      <button type="button" className={btn} disabled={!!busy} onClick={() => void choose()} data-hint="PNG or JPEG, up to 20 MB: cropped to a square, at most 1400 px">
        <ImagePlus size={12} /> Choose image…
      </button>
      <div className="flex gap-1">
        <button type="button" className={`${btn} flex-1`} disabled={!!busy} onClick={() => void generate(seed, style)} data-hint="Draw a cover from this song's notes, title and artist">
          <Sparkles size={12} /> Generate
        </button>
        <button type="button" className={btn} disabled={!!busy} onClick={shuffle} aria-label="Shuffle" data-hint="Another generated look">
          <Shuffle size={12} />
        </button>
      </div>
      <div className="flex gap-1">
        <DialogSelect<CoverStyle> value={style} options={COVER_STYLES.map((s) => ({ value: s, label: STYLE_LABEL[s] }))} onChange={setStyle} width={128} />
        <button type="button" className={btn} disabled={!!busy || !coverFile} onClick={() => void remove()} aria-label="Remove cover" data-hint="Remove the cover">
          <Trash2 size={12} />
        </button>
      </div>
      {preview && <div className="text-[9px] text-krypt-muted">{`${preview.width}×${preview.height} · ${preview.mime === 'image/png' ? 'PNG' : 'JPEG'} · ${Math.max(1, Math.round(preview.bytes / 1024))} KB`}</div>}
    </div>
  );
}

function ExportForm({ close, run }: { close: () => void; run: ExportRunner }) {
  const p = getProject();
  const listId = useId();
  const statusName = useProjectStatus((s) => s.status?.name) ?? p.meta.name;
  const [prefs, setPrefs] = useState<ExportPrefs>(() => {
    const x = loadExportPrefs();
    if (!x.patternId || !p.patterns[x.patternId]) x.patternId = p.transport.activePatternId;
    return x;
  });
  const [info, setInfo] = useState<InfoFields>(infoFromMeta);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<ExportPrefs>): void => setPrefs((s) => ({ ...s, ...patch }));
  const setField = (patch: Partial<InfoFields>): void => setInfo((s) => ({ ...s, ...patch }));
  const loop = p.transport.loop;
  const hasLoop = loop.end > loop.start;
  const scope: ExportScope = prefs.scope === 'loop' && !hasLoop ? 'song' : prefs.scope;
  const format = prefs.format;
  const req = exportRequest({ ...prefs, scope, format }, p);
  const seconds = req ? ticksToSeconds(req.ticks, p.transport.bpm) : 0;
  const tail = prefs.tail === 'cut' ? 0 : prefs.tailSec;
  const stems = !!prefs.stems;
  const summary = req
    ? `≈ ${fmtClock(seconds)}${tail ? ` + ${tail.toFixed(1)} s tail` : ''} · ${formatLabel({ format, mp3Kbps: prefs.mp3Kbps })}${stems ? ' · stems into a folder' : prefs.normalize ? ' · normalized' : ''}`
    : 'Nothing to render';
  const check = infoPatch(info);
  const coverText = { title: info.title.trim() || statusName, artist: info.artist.trim() || p.meta.author };

  const submit = async (): Promise<void> => {
    if (!req || check.error) return;
    if (check.args) {
      setBusy(true);
      const r = await dispatch('project.setInfo', check.args, { label: 'Edit song info' });
      setBusy(false);
      if (!r.ok) return;
    }
    const next = { ...prefs, scope, format };
    saveExportPrefs(next);
    close();
    void run(req.opts, req.label, { openFolder: next.openFolder });
  };

  const scopes: Array<{ value: ExportScope; label: string; title?: string }> = [
    { value: 'song', label: 'Song', title: 'The whole Playlist arrangement' },
    { value: 'pattern', label: 'Pattern', title: 'One pattern, looped as often as you like' },
  ];
  if (hasLoop) scopes.push({ value: 'loop', label: 'Loop region', title: 'The loop region set on the Playlist ruler' });
  const formats: Array<{ value: ExportPrefs['format']; label: string; title?: string }> = [
    { value: 'wav16', label: '16-bit' },
    { value: 'wav24', label: '24-bit' },
    { value: 'wav32f', label: '32-bit float' },
    { value: 'mp3', label: 'MP3', title: 'MP3 with the song info and cover: the cover shows everywhere, Windows Explorer included' },
  ];

  return (
    <DialogForm onSubmit={() => void submit()} onCancel={close} submitLabel={stems ? 'Export stems…' : 'Export…'} submitDisabled={!req || !!check.error} busy={busy} extra={check.error ? <span className="text-rose-300">{check.error}</span> : summary}>
      <section className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-krypt-muted">Song info & cover</h4>
          <span className="text-[9px] text-krypt-muted/80">Saved with the project, written into the file</span>
        </div>
        <div className="flex gap-3">
          <CoverPicker text={coverText} />
          <div className="grid min-w-0 flex-1 grid-cols-2 content-start gap-x-2 gap-y-2">
            <label className="col-span-2 block">
              <span className="text-[10px] font-semibold text-white/70">Title</span>
              <input data-autofocus value={info.title} maxLength={200} placeholder={statusName} onChange={(e) => setField({ title: e.target.value })} className={input} />
            </label>
            <label className="col-span-2 block">
              <span className="text-[10px] font-semibold text-white/70">Artist</span>
              <input value={info.artist} maxLength={200} placeholder={p.meta.author || 'Your artist name'} onChange={(e) => setField({ artist: e.target.value })} className={input} />
            </label>
            <label className="col-span-2 block">
              <span className="text-[10px] font-semibold text-white/70">Album</span>
              <input value={info.album} maxLength={200} placeholder="Single" onChange={(e) => setField({ album: e.target.value })} className={input} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold text-white/70">Year</span>
              <input value={info.year} inputMode="numeric" maxLength={4} placeholder={String(new Date().getFullYear())} onChange={(e) => setField({ year: e.target.value.replace(/[^\d]/g, '') })} className={input} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold text-white/70">Track #</span>
              <input value={info.track} inputMode="numeric" maxLength={3} placeholder="1" onChange={(e) => setField({ track: e.target.value.replace(/[^\d]/g, '') })} className={input} />
            </label>
            <label className="col-span-2 block">
              <span className="text-[10px] font-semibold text-white/70">Genre</span>
              <input value={info.genre} maxLength={64} list={listId} placeholder="e.g. Trap" onChange={(e) => setField({ genre: e.target.value })} className={input} />
              <datalist id={listId}>
                {GENRES.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
            <p className="col-span-2 text-[9px] leading-snug text-krypt-muted">
              MP3 shows the cover everywhere, Windows Explorer included. WAV keeps the song info in Explorer; WAV covers show in most music players, not in Explorer.
            </p>
          </div>
        </div>
      </section>
      <Field
        label="Output"
        hint={stems ? 'One file per mixer insert that plays, plus Master, into a new folder. Song info stays out of stems.' : 'The whole mix in one file, with your song info and cover'}
      >
        <Segmented
          value={stems ? 'stems' : 'file'}
          options={[
            { value: 'file', label: 'One file' },
            { value: 'stems', label: 'Stems', title: 'One file per mixer insert, named like "01 Kick", plus "Master"' },
          ]}
          onChange={(v) => set(v === 'stems' ? { stems: true, format: 'wav32f' } : { stems: false })}
        />
      </Field>
      <Field label="Render" hint={hasLoop ? undefined : 'Drag on the Playlist ruler to set a loop region'}>
        <Segmented value={scope} options={scopes} onChange={(s) => set({ scope: s })} />
      </Field>
      {scope === 'pattern' && (
        <Field label="Pattern" hint="Plays the pattern back to back">
          <div className="flex items-center gap-2">
            <DialogSelect
              value={prefs.patternId ?? ''}
              options={p.patternOrder.map((id) => ({ value: id, label: p.patterns[id]?.name ?? id }))}
              onChange={(patternId) => set({ patternId })}
              width={150}
            />
            <NumberBox value={prefs.loops} min={1} max={64} onChange={(loops) => set({ loops })} suffix="×" width={44} />
          </div>
        </Field>
      )}
      {scope === 'loop' && (
        <Field label="Range">
          <span className="font-mono text-[11px] text-white/80">
            {formatBBT(loop.start, p.transport.timeSig)} → {formatBBT(loop.end, p.transport.timeSig)}
          </span>
        </Field>
      )}
      <Field label="Format" hint={format === 'mp3' ? "MP3, constant bitrate, through Windows' own encoder" : 'WAV at the audio device’s sample rate'}>
        <Segmented value={format} options={formats} onChange={(f) => set({ format: f })} />
      </Field>
      {format === 'mp3' && (
        <Field label="Bitrate" hint="320 kbps sounds best; 128 makes small files">
          <Segmented<Mp3Kbps> value={prefs.mp3Kbps ?? 320} options={MP3_BITRATES.map((k) => ({ value: k, label: `${k}` }))} onChange={(mp3Kbps) => set({ mp3Kbps })} />
        </Field>
      )}
      <Field label="Tail" hint="Leave remainder keeps reverb and delay tails ringing out">
        <Segmented
          value={prefs.tail}
          options={[
            { value: 'leave', label: 'Leave remainder' },
            { value: 'cut', label: 'Cut' },
          ]}
          onChange={(tail) => set({ tail })}
        />
      </Field>
      {prefs.tail === 'leave' && (
        <RangeField label="Tail length" value={prefs.tailSec} min={0} max={30} step={0.5} onChange={(tailSec) => set({ tailSec })} format={(v) => `${v.toFixed(1)} s`} />
      )}
      <div className="space-y-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5">
        {stems ? (
          <p className="text-[10px] leading-snug text-krypt-muted">Stems are never normalized: each one keeps its level in the mix, so they line up and sum back to your song. Use 32-bit float: a part can peak above 0 dB before the master limiter, and 16 / 24-bit or MP3 would clip it.</p>
        ) : (
          <Check checked={prefs.normalize} onChange={(normalize) => set({ normalize })} label="Normalize" hint="Scale the export so its loudest peak hits −0.1 dBFS" />
        )}
        <Check checked={prefs.openFolder} onChange={(openFolder) => set({ openFolder })} label="Open the folder after export" />
      </div>
    </DialogForm>
  );
}

export function openExportDialog(run: ExportRunner, doc?: Document | null): void {
  openDialog({
    title: 'Export audio',
    subtitle: 'Renders offline, faster than real time, with your song info and cover. You pick the file name (or the folder, for stems) next.',
    icon: Download,
    width: 620,
    doc,
    render: (close) => <ExportForm close={close} run={run} />,
  });
}
