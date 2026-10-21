// ──────────────────────────────────────────────────────────────────────
// Master an album (research/23 §2), the same numbered, linear flow as
// Master a song (research/22: one action per step): ① Your songs (pick /
// drop, reorder, remove), ② Pick a style, ③ Sound like a song you love
// (optional, folded; never one of the album's own songs), More options
// (prompt, targets, "Keep the album's dynamics"), then a big Master my
// album button that says why it is disabled. The working view ticks
// through the real stages. The result: a one-line headline, three numbered
// next steps (▶ a song + Before / After, Keep, Export all), and the song
// table / tone chart under Details. Pure view logic: ./albumLogic.
// ──────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, AudioLines, Ban, Check, ChevronDown, ChevronRight, CircleX, DiscAlbum, Download, FolderOpen, Headphones, History, Loader2, Play, Plus, TriangleAlert, Undo2, X } from 'lucide-react';
import { ALBUM_MAX_SONGS } from '@shared/automix/album';
import { Check as CheckBox, Field, NumberBox, Segmented, openDialog } from '../components/Dialog';
import { ProgressBar } from '../ears/ProgressBar';
import { hasFiles } from '../app/fileDrop';
import { cls } from '../utils/format';
import {
  LUFS_MAX,
  LUFS_MIN,
  MATCHING_NOTE,
  TP_MAX,
  TP_MIN,
  abNote,
  barFraction,
  closenessText,
  effectiveTarget,
  fmtLufs,
  loudnessUse,
  masterStepOf,
  masterStepStates,
  masterSteps,
  progressDetail,
  percentText,
  presetById,
  presetHeading,
  referenceAbNote,
  referenceClash,
  targetHint,
} from './logic';
import { EXPORT_FORMATS, albumFormError, albumHeadline, albumResultHeadline, albumResultWhere, albumTones, loudestAfter, songLabel, songRows, trackNumber } from './albumLogic';
import { albumBackToForm, useAlbum } from './albumStore';
import { useAutoMix } from './store';
import { loadPresets } from './actions';
import {
  albumReference,
  cancelAlbum,
  clearAlbumSongs,
  dropSongs,
  exportAlbum,
  keepAlbum,
  moveAlbumSong,
  onAlbumDialogClosed,
  onAlbumDialogOpened,
  pickSongs,
  playAlbumReference,
  playAlbumSong,
  removeAlbumSong,
  setAlbumAB,
  setExportFormat,
  startAlbum,
  stopAlbumReference,
  undoAlbum,
} from './albumActions';
import { Details, Fold, GoodToKnow, NextStep, Note, PresetCards, ReferenceRow, SectionTitle, StepHead, StepList, ToneOverlay, bigPrimary, btn, primary } from './AutoMixDialog';
import { ResultTransport } from './ResultTransport';
import { updateAlbumForm } from './albumStore';

export function openAlbumDialog(doc?: Document | null): void {
  openDialog({
    key: 'automix-album',
    title: 'Master an album',
    subtitle: 'Three steps: choose your songs in order, pick one style for all of them, then click Master my album. It opens in a new tab, and your files are never changed.',
    icon: DiscAlbum,
    width: 800,
    doc,
    render: (close) => <AlbumView close={close} />,
    onClose: onAlbumDialogClosed,
  });
  onAlbumDialogOpened();
}

function AlbumView({ close }: { close: () => void }) {
  const phase = useAlbum((s) => s.phase);
  if (phase === 'done') return <DoneView close={close} />;
  if (phase !== 'idle') return <ProgressView close={close} />;
  return <FormView close={close} />;
}

// ── The form ──────────────────────────────────────────────────────────

function SongList() {
  const songs = useAlbum((s) => s.form.songs);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        dropSongs(e.dataTransfer);
      }}
      className={cls('rounded-xl border transition', over ? 'border-krypt-purple/70 bg-krypt-purple/[0.1]' : songs.length ? 'border-krypt-purple/35 bg-krypt-purple/[0.05]' : 'border-dashed border-white/15 bg-black/25')}
    >
      {songs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
          <button type="button" className={bigPrimary} data-autofocus onClick={() => void pickSongs()}>
            <FolderOpen size={15} /> Choose your songs…
          </button>
          <div className="text-[11px] text-krypt-muted">
            Hold Ctrl to pick several, or drop 2 to {ALBUM_MAX_SONGS} audio files here · WAV, MP3, M4A, FLAC and more
          </div>
        </div>
      ) : (
        <>
          <ol className="max-h-[230px] overflow-y-auto py-1" aria-label="Songs in album order">
            {songs.map((p, i) => (
              <li key={p} className="group flex items-center gap-2 px-3 py-1 hover:bg-white/[0.03]">
                <span className="w-5 flex-shrink-0 font-mono text-[10.5px] text-krypt-muted">{trackNumber(i)}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-white/90" title={p}>
                  {songLabel(p)}
                </span>
                <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-25" disabled={i === 0} onClick={() => moveAlbumSong(i, i - 1)} aria-label={`Move "${songLabel(p)}" up`}>
                  <ArrowUp size={12} />
                </button>
                <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-25" disabled={i === songs.length - 1} onClick={() => moveAlbumSong(i, i + 1)} aria-label={`Move "${songLabel(p)}" down`}>
                  <ArrowDown size={12} />
                </button>
                <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-krypt-muted transition hover:bg-rose-500/15 hover:text-rose-200" onClick={() => removeAlbumSong(i)} aria-label={`Remove "${songLabel(p)}"`}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-1.5">
            <span className="flex-1 text-[10.5px] text-krypt-muted">
              {songs.length} of {ALBUM_MAX_SONGS} songs · the arrows change the order · drop more here
            </span>
            <button type="button" className={cls(btn, 'h-7 px-2.5 text-[11px]')} disabled={songs.length >= ALBUM_MAX_SONGS} onClick={() => void pickSongs()}>
              <Plus size={12} /> Add songs…
            </button>
            <button type="button" className={cls(btn, 'h-7 px-2.5 text-[11px]')} onClick={clearAlbumSongs}>
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function FormView({ close }: { close: () => void }) {
  const form = useAlbum((s) => s.form);
  const reference = useAlbum((s) => s.reference);
  const showReference = useAlbum((s) => s.showReference);
  const showMore = useAlbum((s) => s.showMore);
  const presets = useAutoMix((s) => s.presets);
  const blocker = albumFormError(form);
  const clash = referenceClash(reference.path, form.songs, true);
  const matching = reference.status === 'ready' && !clash;
  const refOpen = showReference || !!reference.path;
  const t = effectiveTarget(form, presets.list, null, null, matching ? reference.sound : null);
  return (
    <div className="flex flex-col">
      <div className="space-y-4 px-4 py-3.5">
        <section aria-label="Your songs">
          <StepHead n={1} title="Your songs, in album order" line="The finished songs, first track first. Choosing them doesn't start anything yet." />
          <SongList />
        </section>

        <section aria-label="Pick a style">
          <StepHead
            n={2}
            title={matching ? presetHeading(reference) : 'Pick a style'}
            line={matching ? MATCHING_NOTE : 'One style for the whole album: how loud the songs get and their balance of bass and treble. The number on each card is its loudness in LUFS (closer to 0 is louder). Not sure? Keep Auto.'}
          />
          <PresetCards presets={presets} picked={form.preset} genre="" onPick={(id) => updateAlbumForm({ type: 'pickPreset', id })} onRetry={() => void loadPresets(true)} />
        </section>

        <section aria-label="Sound like a song you love">
          <Fold
            open={refOpen}
            onToggle={() => useAlbum.setState({ showReference: !refOpen })}
            head={
              <span className="flex items-center gap-2.5">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-white/15 font-mono text-[11.5px] font-semibold text-white/70">3</span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-semibold text-white/85">Sound like a song you love (optional)</span>
                  <span className="block text-[10.5px] leading-snug text-krypt-muted">A finished song you want yours to sound like. It's only measured, never copied.</span>
                </span>
              </span>
            }
          >
            <ReferenceRow state={reference} ctl={albumReference} issue={clash} />
          </Fold>
        </section>

        <Fold
          open={showMore}
          onToggle={() => useAlbum.setState({ showMore: !showMore })}
          head={
            <span className="block">
              <span className="block text-[12px] font-semibold text-white/75">More options</span>
              <span className="block text-[10.5px] text-krypt-muted">Describe the sound in words, set the loudness, keep quiet songs quieter. You can skip this.</span>
            </span>
          }
        >
          <div className="space-y-3">
            <section aria-label="Describe it">
              <SectionTitle>Describe it (optional)</SectionTitle>
              <textarea
                rows={2}
                value={form.prompt}
                maxLength={500}
                onChange={(e) => updateAlbumForm({ type: 'set', patch: { prompt: e.target.value } })}
                placeholder="warm and wide, not harsh, loud enough for streaming"
                className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[12.5px] leading-snug text-white outline-none transition placeholder:text-krypt-muted/60 focus:border-krypt-purple/60"
              />
            </section>
            <section aria-label="Options" className="space-y-2.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
              <Field label="Target loudness (LUFS)" hint={`${targetHint(t)} · ${loudnessUse(t.lufs)}${form.keepDynamics ? ' · for the loudest song' : ' · for every song'}`}>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={LUFS_MIN}
                    max={LUFS_MAX}
                    step={0.5}
                    value={t.lufs}
                    onChange={(e) => updateAlbumForm({ type: 'set', patch: { targetLufs: Number(e.target.value) } })}
                    className="h-1.5 w-[150px] cursor-pointer accent-krypt-purple"
                    aria-label="Target loudness in LUFS"
                  />
                  <span className="w-[76px] text-right font-mono text-[11px] text-white/85">{fmtLufs(t.lufs)}</span>
                </div>
              </Field>
              <Field label="Peak limit (no clipping)" hint="Every peak stays under this, so nothing clips. −1 is safe for streaming: MP3 and AAC add a little peak">
                <NumberBox value={t.truePeak} min={TP_MIN} max={TP_MAX} step={0.1} suffix="dBTP" width={52} onChange={(v) => updateAlbumForm({ type: 'set', patch: { truePeak: v } })} />
              </Field>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-0.5">
                <CheckBox
                  checked={form.keepDynamics}
                  onChange={(keepDynamics) => updateAlbumForm({ type: 'set', patch: { keepDynamics } })}
                  label="Keep the album's dynamics"
                  hint="The loudest song hits the target; quieter songs (intros, slow songs) stay a little quieter, up to 4 LU under it. Off: every song hits the target."
                />
                <CheckBox
                  checked={form.useAi}
                  onChange={(useAi) => updateAlbumForm({ type: 'set', patch: { useAi } })}
                  label="Let the connected AI read the prompt"
                  hint="Off: Krypt's built-in keyword reader. The audio is always measured on your PC."
                />
              </div>
            </section>
          </div>
        </Fold>
      </div>

      <div className="sticky bottom-0 border-t border-white/[0.06] bg-krypt-panel px-4 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <div className={cls('min-w-0 flex-1 text-[11px] leading-snug', blocker ? 'font-semibold text-amber-200/90' : 'text-krypt-muted')} aria-live="polite">
            {blocker ?? 'Measures each song a few times: about as long as exporting them. The mastering is one undo step in the new tab.'}
          </div>
          <button type="button" className={btn} onClick={close}>
            Close
          </button>
          <button type="button" className={bigPrimary} disabled={!!blocker} title={blocker ?? undefined} onClick={() => void startAlbum()}>
            <DiscAlbum size={15} /> Master my album
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Progress ──────────────────────────────────────────────────────────

function ProgressView({ close }: { close: () => void }) {
  const job = useAlbum();
  const running = job.phase === 'running' || job.phase === 'cancelling';
  const fraction = barFraction(job.phase === 'cancelling' ? 'running' : job.phase === 'running' ? 'running' : 'failed', job.progress);
  const message = job.phase === 'cancelling' ? 'Cancelling…' : (job.progress?.message ?? 'Starting…');
  const refUsed = !!job.reference.path && job.reference.status !== 'failed' && !referenceClash(job.reference.path, job.form.songs, true);
  const steps = masterSteps({ song: '', prompt: !!job.form.prompt.trim(), reference: refUsed, album: true });
  const current = masterStepOf(job.progress, true);
  const states = masterStepStates(job.phase, steps, current);
  const detail = progressDetail(job.progress?.message) || undefined;
  const n = job.form.songs.length;
  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-krypt-purple/15 text-purple-200">
            {running ? <Loader2 size={15} className="animate-spin" /> : <DiscAlbum size={15} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-white">{running ? `Mastering your ${n} songs…` : job.phase === 'failed' ? "The album couldn't be mastered" : 'Stopped mastering the album'}</div>
            <div className="truncate text-[11px] text-krypt-muted">
              One song at a time: measured, given its own chain, checked again (up to 3 passes).
              {refUsed && job.reference.sound ? ` Sounding like ${job.reference.sound.name}.` : ''}
            </div>
          </div>
        </div>
        <StepList steps={steps} states={states} detail={detail} />
        {running && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-white/80" title={message}>
                {message}
              </span>
              <span className="flex-shrink-0 font-mono text-krypt-muted">{percentText(fraction)}</span>
            </div>
            <ProgressBar fraction={fraction} />
          </div>
        )}
        {job.phase === 'failed' && (
          <Note icon={CircleX} tone="error">
            <div className="font-semibold">The album couldn't be mastered</div>
            <div className="mt-0.5 text-rose-100/85">{job.error}</div>
          </Note>
        )}
        {job.phase === 'cancelled' && (
          <Note icon={Ban} tone="warn">
            {job.error ?? 'Cancelled. Nothing was mastered.'}
          </Note>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <div className="min-w-0 flex-1 text-[10.5px] text-krypt-muted">{running ? 'Your original files are never changed. You can hide this: it keeps going, and Tools ▸ Master an album… shows it again.' : ''}</div>
        {running ? (
          <>
            <button type="button" className={btn} onClick={close}>
              Hide
            </button>
            <button type="button" className={cls(btn, 'border-rose-500/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20')} disabled={job.phase === 'cancelling'} onClick={() => void cancelAlbum()}>
              {job.phase === 'cancelling' ? <Loader2 size={13} className="animate-spin" /> : null}
              {job.phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={btn} onClick={close}>
              Close
            </button>
            <button type="button" className={primary} onClick={albumBackToForm}>
              Back to the steps
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Done ──────────────────────────────────────────────────────────────

function SongTable() {
  const o = useAlbum((s) => s.outcome);
  const selected = useAlbum((s) => s.selected);
  const [open, setOpen] = useState<number | null>(null);
  if (!o) return null;
  const rows = songRows(o);
  return (
    <div className="max-h-[260px] overflow-y-auto rounded-xl border border-white/[0.07] bg-black/30" role="table" aria-label="Songs before and after">
      <div className="sticky top-0 grid grid-cols-[28px_20px_minmax(0,1.6fr)_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,0.8fr)] items-center gap-2 border-b border-white/[0.06] bg-krypt-panel px-3 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-krypt-muted" role="row">
        <span />
        <span />
        <span role="columnheader">Song</span>
        <span role="columnheader">Loudness (LUFS)</span>
        <span role="columnheader">Peak</span>
        <span role="columnheader">Changes</span>
      </div>
      {rows.map((r) => {
        const song = o.songs[r.index];
        const expanded = open === r.index;
        return (
          <div key={r.index} className={cls('border-b border-white/[0.04] last:border-0', selected === r.index && 'bg-krypt-purple/[0.07]')} role="row">
            <div className="grid grid-cols-[28px_20px_minmax(0,1.6fr)_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,0.8fr)] items-center gap-2 px-3 py-1.5" title={r.why}>
              <button
                type="button"
                className={cls('flex h-6 w-6 items-center justify-center rounded-md transition', selected === r.index ? 'bg-krypt-purple/25 text-white' : 'bg-white/5 text-white/70 hover:bg-krypt-purple/20 hover:text-white')}
                onClick={() => void playAlbumSong(r.index)}
                aria-label={`Play "${r.name}"`}
                title={`Play "${r.name}" from its start (switch Before / After while it plays)`}
              >
                <Play size={11} />
              </button>
              <span className="font-mono text-[10.5px] text-krypt-muted">{trackNumber(r.index)}</span>
              <button type="button" className="flex min-w-0 items-center gap-1 text-left text-[12px] font-semibold text-white/90 hover:text-white" onClick={() => setOpen(expanded ? null : r.index)} aria-expanded={expanded}>
                {expanded ? <ChevronDown size={11} className="flex-shrink-0 text-krypt-muted" /> : <ChevronRight size={11} className="flex-shrink-0 text-krypt-muted" />}
                <span className="truncate">{r.name}</span>
                {r.warn && <TriangleAlert size={11} className="flex-shrink-0 text-amber-300" />}
              </button>
              <span className="flex min-w-0 items-center gap-1 font-mono text-[11px]" role="cell">
                <span className="truncate text-white/55">{r.before}</span>
                <ArrowRight size={10} className="flex-shrink-0 text-white/30" />
                <span className="truncate font-semibold text-white">{r.after}</span>
              </span>
              <span className={cls('truncate font-mono text-[11px]', r.warn ? 'text-amber-200' : 'text-white/75')} role="cell">
                {r.truePeak}
              </span>
              <span className="text-[11px] text-white/70" role="cell">
                {r.changes}
              </span>
            </div>
            {expanded && (
              <div className="space-y-1 px-9 pb-2 text-[11px] leading-snug text-white/75">
                <div className="text-krypt-muted">
                  Aimed at {r.aim} · {r.delta} · bars {song.bars}
                </div>
                {song.changes.map((c, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <Check size={10} className="mt-[3px] flex-shrink-0 text-krypt-purple" />
                    <span className="min-w-0">
                      <span className="text-white/90">{c.target.split('▸').slice(1).join('▸').trim() || c.target}: </span>
                      {c.what}
                    </span>
                  </div>
                ))}
                {song.notes.map((n) => (
                  <div key={n} className="flex items-start gap-1.5 text-amber-100/90">
                    <TriangleAlert size={10} className="mt-[3px] flex-shrink-0 text-amber-300" />
                    <span className="min-w-0">{n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AlbumAB() {
  const o = useAlbum((s) => s.outcome);
  const ab = useAlbum((s) => s.ab);
  const busy = useAlbum((s) => s.abBusy);
  const verdict = useAlbum((s) => s.verdict);
  const refPlaying = useAlbum((s) => s.refPlaying);
  const selected = useAlbum((s) => s.selected);
  if (!o) return null;
  const disabled = !o.entryId || verdict !== 'open' || busy;
  const song = selected !== null ? o.songs[selected] : null;
  const gap = song ? song.after.lufs - song.before.lufs : 0;
  return (
    <section aria-label="Compare before and after" className="rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Headphones size={14} className="text-krypt-purple" />
          <span className="text-[12px] font-semibold text-white">Compare</span>
        </div>
        <div className="inline-flex rounded-lg border border-white/10 bg-black/40 p-0.5" role="radiogroup" aria-label="Before or after">
          {(['before', 'after'] as const).map((v) => {
            const on = ab === v && !refPlaying;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={disabled}
                onClick={() => void setAlbumAB(v)}
                className={cls(
                  'inline-flex h-7 w-[84px] items-center justify-center gap-1 rounded-md text-[11.5px] font-semibold transition disabled:cursor-not-allowed',
                  on ? (v === 'after' ? 'bg-krypt-purple/25 text-white shadow-[inset_0_0_0_1px_rgba(168,85,247,0.6)]' : 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)]') : 'text-white/55 hover:bg-white/5 hover:text-white',
                  disabled && !on && 'opacity-40',
                )}
              >
                {busy && !on ? <Loader2 size={11} className="animate-spin" /> : null}
                {v === 'before' ? 'Before' : 'After'}
              </button>
            );
          })}
          {o.reference && (
            <button
              type="button"
              role="radio"
              aria-checked={refPlaying}
              onClick={() => void playAlbumReference()}
              title="Play the reference from its start, as loud as the album's loudest song"
              className={cls(
                'inline-flex h-7 items-center justify-center gap-1 rounded-md px-2.5 text-[11.5px] font-semibold transition',
                refPlaying ? 'bg-krypt-pink/20 text-white shadow-[inset_0_0_0_1px_rgba(236,72,153,0.6)]' : 'text-white/55 hover:bg-white/5 hover:text-white',
              )}
            >
              <Play size={11} /> Reference
            </button>
          )}
        </div>
        <span className="min-w-0 flex-1 text-[10.5px] text-krypt-muted">
          {!o.entryId ? 'Nothing changed, so there is nothing to compare.' : verdict === 'undone' ? 'Undone: you are hearing the songs as they were.' : 'Before / After switches the whole album.'}
        </span>
      </div>
      <div className="mt-2">
        <ResultTransport range={song ? { start: song.startTick, end: song.endTick, name: song.name } : null} refPlaying={refPlaying} onStopReference={stopAlbumReference} />
        <div className="mt-1 text-[10.5px] text-krypt-muted">{song ? `Playing: ${trackNumber(selected!)} ${song.name}` : 'The whole album (▶ on a song plays just that one).'}</div>
      </div>
      {o.entryId && song && <p className="mt-1.5 text-[11px] leading-snug text-white/75">{abNote(gap)}</p>}
      {o.reference && <p className="mt-1 text-[11px] leading-snug text-white/65">{referenceAbNote(loudestAfter(o), o.reference.lufs)}</p>}
    </section>
  );
}

function ExportBar() {
  const format = useAlbum((s) => s.exportFormat);
  const exporting = useAlbum((s) => s.exporting);
  const p = useAlbum((s) => s.exportProgress);
  const exported = useAlbum((s) => s.exported);
  const verdict = useAlbum((s) => s.verdict);
  const running = exporting !== 'idle';
  const fraction = p && p.fraction >= 0 ? Math.min(1, p.fraction) : -1;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented value={format} size="sm" options={EXPORT_FORMATS.map((f) => ({ value: f.value, label: f.label, title: f.title }))} onChange={setExportFormat} />
        {running ? (
          <button type="button" className={cls(btn, 'border-rose-500/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20')} disabled={exporting === 'cancelling'} onClick={() => void cancelAlbum()}>
            {exporting === 'cancelling' ? 'Cancelling…' : 'Cancel export'}
          </button>
        ) : (
          <button type="button" className={verdict === 'kept' ? primary : btn} data-autofocus={verdict !== 'open' ? true : undefined} onClick={() => void exportAlbum()}>
            <Download size={13} /> Export all…
          </button>
        )}
      </div>
      {running && (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-[11px]">
            <span className="min-w-0 flex-1 truncate text-white/80">{exporting === 'cancelling' ? 'Cancelling…' : (p?.message ?? 'Choosing the folder…')}</span>
            <span className="flex-shrink-0 font-mono text-krypt-muted">{percentText(fraction)}</span>
          </div>
          <ProgressBar fraction={fraction} />
        </div>
      )}
      {!running && exported && (
        <div className="text-[11px] text-white/70">
          Last export: {exported.files.length} file{exported.files.length === 1 ? '' : 's'} in <span className="font-mono text-white/85">{exported.folder}</span>
          {exported.failed.length ? <span className="text-amber-200"> · {exported.failed.length} failed</span> : null}
        </div>
      )}
    </div>
  );
}

function DoneView({ close }: { close: () => void }) {
  const o = useAlbum((s) => s.outcome);
  const verdict = useAlbum((s) => s.verdict);
  const exporting = useAlbum((s) => s.exporting);
  const presets = useAutoMix((s) => s.presets.list);
  if (!o) return null;
  const tones = albumTones(o);
  const target = o.reference ? o.reference.tone : o.curve;
  const busy = exporting !== 'idle';
  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.35)]">
            <Check size={15} strokeWidth={2.6} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-snug text-white">{albumResultHeadline(o)}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-krypt-muted">{albumResultWhere(o)}</div>
          </div>
        </div>

        <GoodToKnow notes={o.notes} />

        <section aria-label="What to do next">
          <SectionTitle>What to do next</SectionTitle>
          <ol className="space-y-3">
            <NextStep n={1} title="Listen: press ▶ on a song, then switch Before / After" line="Try a few songs. The ▶ jumps to that song in the album tab.">
              <SongTable />
              <AlbumAB />
            </NextStep>
            <NextStep
              n={2}
              title="Keep it"
              line={
                verdict === 'kept'
                  ? 'Kept. The mastering is one step in Edit ▸ History of the album tab.'
                  : verdict === 'undone'
                    ? 'Undone: the songs are back as they were. Edit ▸ History can bring the mastering back.'
                    : 'Like it? Click Keep. Not for you? Undo switches the whole album off.'
              }
            >
              {verdict === 'open' && (
                <div className="flex items-center gap-2">
                  <button type="button" className={primary} data-autofocus disabled={busy} onClick={() => void keepAlbum()}>
                    <Check size={13} /> Keep
                  </button>
                  <button type="button" className={btn} disabled={!o.entryId || busy} onClick={() => void undoAlbum()}>
                    <Undo2 size={13} /> Undo
                  </button>
                </div>
              )}
            </NextStep>
            <NextStep n={3} title="Export all: one file per song" line="Pick a format, then a folder. Each file is named “<song> (mastered)”. Nothing is overwritten.">
              <ExportBar />
            </NextStep>
          </ol>
        </section>

        <Details summary="the album's tone chart, the reference, the settings">
          <div className="text-[11px] text-krypt-muted">
            {o.reference ? `Sounding like ${o.reference.name} · ` : ''}
            Style: {presetById(presets, o.preset.id)?.name ?? o.preset.name} · {albumHeadline(o)}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <ToneOverlay before={tones.before} after={tones.after} target={target} targetLabel={o.reference ? 'Reference' : 'Album curve'} />
            <div className="space-y-2">
              {o.reference && (
                <Note icon={AudioLines} tone={o.reference.distanceBefore - o.reference.distanceAfter >= 0.1 ? 'ok' : 'warn'}>
                  <span className="font-semibold">{closenessText(o.reference)}.</span> <span className="text-white/60">Album average. Reference: {o.reference.summary}</span>
                </Note>
              )}
              <Note icon={History} tone="muted">
                Each song's chain sits on its own insert in the album tab (the Master holds only a safety limiter), with normal knobs you can change. The songs are one undo step, the mastering a second one. Click a song's name in the list for what changed.
              </Note>
            </div>
          </div>
        </Details>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
        {busy && <span className="mr-auto text-[10.5px] text-krypt-muted">Exporting… you can hide this, it keeps going.</span>}
        {!busy && verdict !== 'open' && (
          <button type="button" className={cls(btn, 'mr-auto')} onClick={albumBackToForm}>
            <DiscAlbum size={13} /> Master another album
          </button>
        )}
        <button type="button" className={btn} onClick={close}>
          {busy ? 'Hide' : 'Close'}
        </button>
      </div>
    </div>
  );
}
