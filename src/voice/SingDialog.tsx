import { useEffect, useMemo } from 'react';
import { AudioLines, Check as CheckIcon, Cloud, Loader2, MicVocal, Play, Plus, RotateCcw, Square, TriangleAlert } from 'lucide-react';
import { noteName } from '@shared/music/theory';
import { Field, RangeField, Segmented, openDialog } from '../components/Dialog';
import { useDocStore } from '../doc/store';
import { flashHint } from '../app/hints';
import { resolveChannel, useEditorSelection } from '../editors/selection';
import { cls } from '../utils/format';
import type { PianoRollController } from '../panels/pianoRoll/controller';
import { CLOUD_NOTE, OCTAVE_OPTIONS, TUNE_OPTIONS, buildSingRequest, engineOfId, fmtSeconds, isCloudVoice, singFormError } from './logic';
import { labelsFromOutcome, mapSyllables, mappingLine, melodyNotes, parseBarRange, parseLyrics } from './sing';
import { clearJob, setSing, useVoice } from './store';
import { cancelJob, ensureVoiceState, replayPreview, runSing, stopPreview } from './actions';
import { CloudBadge, JobProgress, LocalBadge, NeedKey, NeedModel, Note, SectionTitle, VoiceSelect, btn, primary, small } from './parts';

export function openSingDialog(ctl: PianoRollController): void {
  if (!ctl.getTarget()) {
    flashHint('Select a pattern and a channel with a melody first', 'warn');
    return;
  }
  void ensureVoiceState(true);
  useVoice.setState({ lastMapping: null });
  openDialog({
    key: 'pianoRoll.tool',
    title: 'Sing my notes',
    subtitle: 'Type lyrics: a voice sings them on this channel’s notes, one syllable per note.',
    icon: MicVocal,
    width: 520,
    doc: ctl.rootDocument(),
    near: ctl.rootRect() ?? undefined,
    render: (close) => <SingBody ctl={ctl} close={close} />,
    onClose: () => {
      ctl.showSyllables(null);
      if (useVoice.getState().previewing) void stopPreview();
      clearJob();
    },
  });
}

function useTarget() {
  const selected = useEditorSelection((s) => s.channelId);
  const patternId = useDocStore((s) => s.project?.transport.activePatternId ?? null);
  const channelId = useDocStore((s) => (s.project ? resolveChannel(s.project, selected) : null) ?? null);
  const notesRec = useDocStore((s) => (patternId && channelId ? s.project?.patterns[patternId]?.notes[channelId] : undefined));
  const ts = useDocStore((s) => s.project?.transport.timeSig);
  const names = useDocStore((s) => `${(patternId && s.project?.patterns[patternId]?.name) || 'Pattern'}\u0001${(channelId && s.project?.channels[channelId]?.name) || 'Channel'}`);
  const [patternName, channelName] = names.split('\u0001');
  return { patternId, channelId, notesRec, ts, patternName, channelName };
}

function SingBody({ ctl, close }: { ctl: PianoRollController; close: () => void }) {
  const state = useVoice((s) => s.state);
  const form = useVoice((s) => s.sing);
  const job = useVoice((s) => s.job);
  const previewing = useVoice((s) => s.previewing);
  const lastMapping = useVoice((s) => s.lastMapping);
  const t = useTarget();

  const range = parseBarRange(form.bars);
  const melody = useMemo(() => (t.ts ? melodyNotes(Object.values(t.notesRec ?? {}), range === 'invalid' ? null : range, t.ts) : []), [t.notesRec, t.ts, form.bars]); // eslint-disable-line react-hooks/exhaustive-deps
  const tokens = useMemo(() => parseLyrics(form.lyrics), [form.lyrics]);
  const mapping = useMemo(() => mapSyllables(tokens, melody), [tokens, melody]);
  const rendered = useMemo(() => (lastMapping?.length ? labelsFromOutcome(lastMapping, melody) : null), [lastMapping, melody]);

  useEffect(() => {
    ctl.showSyllables(rendered ?? mapping.labels);
  }, [ctl, rendered, mapping]);
  useEffect(() => {
    if (useVoice.getState().lastMapping) useVoice.setState({ lastMapping: null });
  }, [form.lyrics, t.patternId, t.channelId, form.bars]);

  const busy = job?.phase === 'running' || job?.phase === 'cancelling';
  const err = singFormError(form, state, melody.length);
  const cloud = isCloudVoice(form.voiceId);
  const engine = form.voiceId ? engineOfId(form.voiceId) : null;

  const run = (preview: boolean): void => {
    if (!t.patternId || !t.channelId) {
      flashHint('Select a pattern and a channel first', 'warn');
      return;
    }
    const req = buildSingRequest(form, { patternId: t.patternId, channelId: t.channelId }, preview);
    if (req) void runSing(req);
  };

  return (
    <div className="flex flex-col">
      <div className="space-y-3 px-4 py-3.5">
        <div className="flex items-center gap-2 text-[11px] text-krypt-muted">
          <MicVocal size={12} className="text-krypt-purple" />
          <span className="truncate">
            <b className="text-white/85">{t.channelName}</b> in <b className="text-white/85">{t.patternName}</b> · {melody.length} note{melody.length === 1 ? '' : 's'} to sing
          </span>
        </div>

        <section data-guide="sing.lyrics" aria-label="Lyrics">
          <SectionTitle right={<span className="font-mono text-[10px] text-krypt-muted">{mappingLine(mapping)}</span>}>Lyrics</SectionTitle>
          <textarea
            value={form.lyrics}
            onChange={(e) => setSing({ lyrics: e.target.value })}
            rows={3}
            disabled={busy}
            autoFocus
            placeholder={'Hold me close to-night\nfly_ a-way'}
            className="w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[13px] leading-relaxed text-white outline-none placeholder:text-white/25 focus:border-krypt-purple/60 disabled:opacity-60"
            spellCheck
          />
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-krypt-muted">
            <span>
              <code className="rounded bg-white/10 px-1 font-mono text-white/85">to-night</code> splits a word by hand
            </span>
            <span>
              <code className="rounded bg-white/10 px-1 font-mono text-white/85">fly_</code> or a lone <code className="rounded bg-white/10 px-1 font-mono text-white/85">_</code> holds a syllable over one more note
            </span>
          </div>
          {mapping.messages.map((m) => (
            <div key={m} className="mt-1 text-[10.5px] text-amber-200/90">
              {m}
            </div>
          ))}
        </section>

        <section aria-label="Voice and sound" className="space-y-2.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-3">
          <Field label="Voice" hint={cloud ? 'Fish Audio, cloud' : engine === 'local' ? 'Kokoro, on your PC' : undefined}>
            <div className="flex items-center gap-1.5">
              {cloud ? <CloudBadge /> : engine ? <LocalBadge /> : null}
              <VoiceSelect state={state} value={form.voiceId} onChange={(voiceId) => setSing({ voiceId })} width={210} />
            </div>
          </Field>
          {state && !state.local.installed && engine !== 'fish' && <NeedModel message={state.local.message} />}
          {state && !state.fish.keySet && engine === 'fish' && <NeedKey message={state.fish.message} />}
          <Field label="Octave" hint="Move the melody for the voice: −1 for a low voice on a high lead">
            <Segmented value={form.octave} onChange={(octave) => setSing({ octave })} options={OCTAVE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} size="sm" />
          </Field>
          <RangeField label="Vibrato" value={form.vibrato} min={0} max={1} step={0.05} format={(v) => (v ? `${Math.round(v * 100)}%` : 'Off')} onChange={(vibrato) => setSing({ vibrato })} />
          <RangeField label="Glide" hint="Slide between notes" value={form.glideMs} min={0} max={200} step={5} format={(v) => (v ? `${v} ms` : 'Off')} onChange={(glideMs) => setSing({ glideMs })} />
          <Field label="Krypt Tune" hint="Hard is the tuned sound; Natural keeps more of the voice">
            <Segmented value={form.tune} onChange={(tune) => setSing({ tune })} options={TUNE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} size="sm" />
          </Field>
          <Field label="Bars" hint="Empty = the whole pattern, or a range like 1-4">
            <input
              value={form.bars}
              onChange={(e) => setSing({ bars: e.target.value })}
              placeholder="All"
              spellCheck={false}
              className={cls('h-7 w-20 rounded-lg border bg-black/40 px-2 font-mono text-[11px] text-white outline-none', range === 'invalid' ? 'border-rose-400/50' : 'border-white/10 focus:border-krypt-purple/60')}
            />
          </Field>
        </section>

        {job && <SingJobState />}
        {lastMapping && lastMapping.length > 0 && (
          <section aria-label="Where the syllables landed">
            <SectionTitle>Where the syllables landed</SectionTitle>
            <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
              {lastMapping.map((m, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md border border-krypt-pink/30 bg-krypt-pink/10 px-1.5 py-0.5 text-[10.5px]">
                  <b className="text-white">{m.syllable}</b>
                  <span className="font-mono text-pink-200/80">{noteName(m.key)}</span>
                </span>
              ))}
            </div>
          </section>
        )}
        {cloud && (
          <Note icon={Cloud} tone="cloud">
            {CLOUD_NOTE} Fish Audio may use requests to improve their models.
          </Note>
        )}
        <p className="text-[10px] leading-snug text-krypt-muted/80">Speech voices aren't trained singers: Krypt speaks the lyrics, then stretches and pitches each syllable onto your notes. Krypt Tune gives it the tuned vocal sound.</p>
      </div>

      <div className="sticky bottom-0 border-t border-white/[0.06] bg-krypt-panel px-4 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[10.5px] text-krypt-muted" title={err ?? undefined}>
            {err ?? 'One audio clip, lined up with the first note.'}
          </div>
          <button type="button" className={btn} onClick={close}>
            Close
          </button>
          {previewing ? (
            <button type="button" className={btn} onClick={() => void stopPreview()}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button type="button" className={btn} disabled={!!err || busy} onClick={() => run(true)}>
              <Play size={12} /> Preview
            </button>
          )}
          <button type="button" data-guide="sing.add" className={primary} disabled={!!err || busy} onClick={() => run(false)}>
            {busy && !job?.preview ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Add to song
          </button>
        </div>
      </div>
    </div>
  );
}

function SingJobState() {
  const job = useVoice((s) => s.job);
  const tune = useVoice((s) => s.sing.tune);
  if (!job) return null;
  if (job.phase === 'running' || job.phase === 'cancelling') return <JobProgress job={job} onCancel={() => void cancelJob()} />;
  if (job.phase === 'failed')
    return (
      <Note icon={TriangleAlert} tone="error">
        <div className="font-semibold">{job.preview ? "The preview couldn't be sung" : "The vocal couldn't be added"}</div>
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
        <span className="min-w-0 flex-1">{job.preview ? `Preview: ${fmtSeconds(o.durationSec)} sung.` : `Added the sung vocal (${fmtSeconds(o.durationSec)}) to the song${tune !== 'off' ? ', with Krypt Tune on its insert' : ''}. Undo removes it in one step.`}</span>
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
