// ──────────────────────────────────────────────────────────────────────
// Krypt Voice dialog (research/21): text → a voice clip. The text box
// (character count, Fish tag chips inserted at the cursor), the voice
// picker in Local / Cloud / My voice groups with their empty states (no
// Kokoro → Model Manager, no Fish key → Settings ▸ Voice), speed, Krypt
// Tune, where the clip goes (the playhead or a bar / track), Preview and
// Add to song with progress + Cancel. Pure view logic lives in ./logic.
// ──────────────────────────────────────────────────────────────────────

import { playState } from '../live/playState';
import { PPQ } from '@shared/schema/time';
import { useEffect, useRef, useState } from 'react';
import { AudioLines, Check as CheckIcon, Cloud, Cpu, Loader2, MicVocal, Play, Plus, RotateCcw, Square, TriangleAlert } from 'lucide-react';
import { Field, RangeField, Segmented, openDialog } from '../components/Dialog';
import { getProject, useDocStore } from '../doc/store';
import { cls } from '../utils/format';
import {
  CLOUD_NOTE,
  LOCAL_NOTE,
  MAX_TEXT,
  TAG_CHIPS,
  TUNE_OPTIONS,
  barError,
  buildSpeakRequest,
  tickToAt,
  charCountLabel,
  fmtSeconds,
  fmtSpeed,
  hasTags,
  insertAtCursor,
  isCloudVoice,
  placementLine,
  speakFormError,
  type Placement,
} from './logic';
import { clearJob, setSpeak, useVoice } from './store';
import { cancelJob, ensureVoiceState, replayPreview, runSpeak, stopPreview } from './actions';
import { CloudBadge, JobProgress, LocalBadge, Note, SectionTitle, VoicePicker, btn, primary, small } from './parts';
import { openRecordVoice } from './RecordVoiceDialog';

export interface OpenVoice {
  /** Prefill "Add to song" at this bar ("9" or "9.3") … */
  at?: string;
  /** … and / or on this track (id). */
  trackId?: string;
  doc?: Document | null;
}

/** Tools ▸ Krypt Voice…, Home ▸ Audio Tools ▸ Krypt Voice, the playlist "Add a voice here…" items. */
export function openKryptVoice(opts: OpenVoice = {}): void {
  if (opts.at || opts.trackId) {
    const cur = useVoice.getState().speak.placement;
    setSpeak({ placement: { mode: opts.at ? 'bar' : cur.mode, bar: opts.at ?? cur.bar, trackId: opts.trackId ?? '' } });
  }
  void ensureVoiceState(true);
  openDialog({
    key: 'kryptVoice',
    title: 'Krypt Voice',
    subtitle: 'Type it, pick a voice, drop it in your song: ad-libs, tags, intros and guide vocals.',
    icon: MicVocal,
    width: 660,
    doc: opts.doc,
    render: (close) => <VoiceView close={close} />,
    onClose: () => {
      useVoice.setState({ visible: false });
      if (useVoice.getState().previewing) void stopPreview();
      clearJob();
    },
  });
  useVoice.setState({ visible: true });
}

function TagChips({ onInsert }: { onInsert: (tag: string) => void }) {
  return (
    <div data-guide="voice.tags" className="flex flex-wrap items-center gap-1" aria-label="Fish Audio direction tags">
      {TAG_CHIPS.map((t) => (
        <button
          key={t}
          type="button"
          onMouseDown={(e) => e.preventDefault()} // keep the caret in the text box
          onClick={() => onInsert(t)}
          className="h-6 rounded-full border border-sky-400/25 bg-sky-500/[0.08] px-2 font-mono text-[10.5px] text-sky-100/90 transition hover:border-sky-300/50 hover:bg-sky-500/20"
          title={`Insert ${t} at the cursor: the words after it are said that way`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function PlacementField({ value, onChange }: { value: Placement; onChange: (p: Placement) => void }) {
  // a primitive key, so the list only re-renders when track names change
  const key = useDocStore((s) => (s.project ? s.project.playlist.trackOrder.map((id, i) => `${id}\u0001${s.project!.playlist.tracks[id]?.name ?? `Track ${i + 1}`}`).join('\u0002') : ''));
  const tracks = key ? key.split('\u0002').map((x) => ({ id: x.split('\u0001')[0], name: x.split('\u0001')[1] })) : [];
  const trackName = tracks.find((t) => t.id === value.trackId)?.name;
  const err = value.mode === 'bar' ? barError(value.bar) : null;
  return (
    <Field label="Add to song" hint={placementLine(value, trackName)} wide>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={value.mode}
          onChange={(mode) => onChange({ ...value, mode })}
          options={[
            { value: 'playhead', label: 'At the playhead' },
            { value: 'bar', label: 'At a bar' },
          ]}
        />
        {value.mode === 'bar' && (
          <label className={cls('inline-flex h-7 items-center gap-1.5 rounded-lg border bg-black/40 pl-2 pr-1', err ? 'border-rose-400/50' : 'border-white/10 focus-within:border-krypt-purple/60')} title={err ?? 'Bar, or bar.beat'}>
            <span className="text-[10px] uppercase text-krypt-muted">Bar</span>
            <input value={value.bar} onChange={(e) => onChange({ ...value, bar: e.target.value })} className="h-full w-14 bg-transparent font-mono text-[11px] text-white outline-none" spellCheck={false} />
          </label>
        )}
        <select
          value={value.trackId}
          onChange={(e) => onChange({ ...value, trackId: e.target.value })}
          className="h-7 max-w-[200px] cursor-pointer rounded-lg border border-white/10 bg-black/40 px-2 text-[11px] text-white/90 outline-none hover:border-white/20 focus:border-krypt-purple/60"
          aria-label="Track"
        >
          <option value="" className="bg-krypt-surface">
            A new track
          </option>
          {tracks.map((t) => (
            <option key={t.id} value={t.id} className="bg-krypt-surface">
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {err && <div className="mt-1 text-[10px] text-rose-300">{err}</div>}
    </Field>
  );
}

function VoiceView({ close }: { close: () => void }) {
  const state = useVoice((s) => s.state);
  const status = useVoice((s) => s.status);
  const stateError = useVoice((s) => s.stateError);
  const form = useVoice((s) => s.speak);
  const job = useVoice((s) => s.job);
  const previewing = useVoice((s) => s.previewing);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [caretTo, setCaretTo] = useState<number | null>(null);

  useEffect(() => {
    if (caretTo === null || !taRef.current) return;
    taRef.current.focus();
    taRef.current.setSelectionRange(caretTo, caretTo);
    setCaretTo(null);
  }, [caretTo]);

  const cloud = isCloudVoice(form.voiceId);
  const busy = job?.phase === 'running' || job?.phase === 'cancelling';
  const previewErr = speakFormError(form, state, true);
  const addErr = speakFormError(form, state, false);
  const tooLong = [...form.text].length > MAX_TEXT;
  const tagsIgnored = !cloud && !!form.voiceId && hasTags(form.text);

  const insertTag = (tag: string): void => {
    const ta = taRef.current;
    const r = insertAtCursor(form.text, tag, ta?.selectionStart ?? form.text.length, ta?.selectionEnd ?? form.text.length);
    setSpeak({ text: r.text });
    setCaretTo(r.caret);
  };

  const run = (preview: boolean): void => {
    const p = getProject();
    const playheadAt = p && p.transport.mode === 'song' ? tickToAt(playState.tick(), PPQ, p.transport.timeSig.num, p.transport.timeSig.den) : undefined;
    const req = buildSpeakRequest(form, preview, playheadAt);
    if (req) void runSpeak(req);
  };

  return (
    <div className="flex flex-col">
      <div className="space-y-3.5 px-4 py-3.5">
        {status === 'failed' && stateError && (
          <Note icon={TriangleAlert} tone="error">
            {stateError}
          </Note>
        )}
        <section data-guide="voice.text" aria-label="Text">
          <SectionTitle right={<span className={cls('font-mono text-[10px]', tooLong ? 'text-rose-300' : 'text-krypt-muted')}>{charCountLabel(form.text)}</span>}>What it says</SectionTitle>
          <textarea
            ref={taRef}
            value={form.text}
            onChange={(e) => setSpeak({ text: e.target.value })}
            rows={4}
            disabled={busy}
            placeholder={'Yeah, Krypt on the beat!\nOr a whole intro, line by line.'}
            className="w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[13px] leading-relaxed text-white outline-none placeholder:text-white/25 focus:border-krypt-purple/60 disabled:opacity-60"
            spellCheck
          />
          {cloud ? (
            <div className="mt-1.5">
              <TagChips onInsert={insertTag} />
            </div>
          ) : (
            tagsIgnored && <div className="mt-1 text-[10.5px] text-amber-200/90">Tags like [whisper] only work with Cloud voices: local voices skip them.</div>
          )}
        </section>

        <section data-guide="voice.voices" aria-label="Voice">
          <SectionTitle right={cloud ? <CloudBadge /> : form.voiceId ? <LocalBadge /> : null}>Voice</SectionTitle>
          <VoicePicker state={state} value={form.voiceId} onChange={(voiceId) => setSpeak({ voiceId })} onRecord={() => openRecordVoice()} />
        </section>

        <section aria-label="Options" className="space-y-2.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
          <RangeField label="Speed" value={form.speed} min={0.5} max={2} step={0.05} format={fmtSpeed} onChange={(speed) => setSpeak({ speed })} />
          <Field label="Krypt Tune" hint={form.tune === 'off' ? 'Off: the voice as rendered' : 'Tunes the clip to the song key: Hard is the robotic tuned sound'}>
            <Segmented value={form.tune} onChange={(tune) => setSpeak({ tune })} options={TUNE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} size="sm" />
          </Field>
          <PlacementField value={form.placement} onChange={(placement) => setSpeak({ placement })} />
        </section>

        {job && <JobProgressOrResult />}
        {cloud && (
          <Note icon={Cloud} tone="cloud">
            {CLOUD_NOTE} Fish Audio may use requests to improve their models.
          </Note>
        )}
      </div>

      <div className="sticky bottom-0 border-t border-white/[0.06] bg-krypt-panel px-4 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[10.5px] text-krypt-muted" title={addErr ?? undefined}>
            {addErr ? (
              addErr
            ) : cloud ? (
              <>
                <Cloud size={11} className="text-sky-300" /> Sent to Fish Audio
              </>
            ) : (
              <>
                <Cpu size={11} className="text-emerald-300" /> {LOCAL_NOTE}
              </>
            )}
          </div>
          <button type="button" className={btn} onClick={close}>
            Close
          </button>
          {previewing ? (
            <button type="button" className={btn} onClick={() => void stopPreview()}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button type="button" data-guide="voice.preview" className={btn} disabled={!!previewErr || busy} onClick={() => run(true)} title={previewErr ?? 'Render it and play it, without adding anything'}>
              <Play size={12} /> Preview
            </button>
          )}
          <button type="button" data-guide="voice.add" className={primary} disabled={!!addErr || busy} onClick={() => run(false)} title={addErr ?? placementLine(form.placement)}>
            {busy && !job?.preview ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Add to song
          </button>
        </div>
      </div>
    </div>
  );
}

function JobProgressOrResult() {
  const job = useVoice((s) => s.job);
  if (!job) return null;
  if (job.phase === 'running' || job.phase === 'cancelling') return <JobProgress job={job} onCancel={() => void cancelJob()} />;
  if (job.phase === 'failed')
    return (
      <Note icon={TriangleAlert} tone="error">
        <div className="font-semibold">{job.preview ? "The preview couldn't be made" : "The voice couldn't be added"}</div>
        <div className="mt-0.5 text-rose-100/85">{job.error}</div>
      </Note>
    );
  if (job.phase === 'cancelled')
    return (
      <Note icon={RotateCcw} tone="warn">
        Cancelled. Nothing was added to your song.
      </Note>
    );
  const o = job.outcome;
  if (!o) return null;
  return (
    <Note icon={job.preview ? AudioLines : CheckIcon} tone="ok">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          {job.preview ? `Preview: ${fmtSeconds(o.durationSec)}, ${o.engine === 'fish' ? 'Fish Audio (cloud)' : 'Kokoro (on your PC)'}.` : `Added ${fmtSeconds(o.durationSec)} to the song as an audio clip. Undo removes it in one step.`}
        </span>
        {job.preview && (
          <button type="button" className={small} onClick={() => void replayPreview()}>
            <Play size={11} /> Play again
          </button>
        )}
      </div>
      {o.notes.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-emerald-100/75">
          {o.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </Note>
  );
}
