// ──────────────────────────────────────────────────────────────────────
// A tutorial video (shared/guides/videos.ts) in the Krypt UI kit: the poster
// with a play button until first play, then the native controls; captions
// on by default with a toggle; 1× / 1.25× / 1.5× speed. A video that fails
// to load says so in place, with Try again (never a silent black box), and
// so do captions that fail. Only one tutorial plays at a time. Used by the
// {{video:…}} and {{videos}} guide blocks and the Home quickstart card.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Captions, CaptionsOff, Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { PLAYBACK_RATES, fmtVideoDuration, videoUrls, type ReadyGuideVideo } from '@shared/guides/videos';
import { cls } from '../utils/format';
import { FOCUS_RING } from '../home/ui';
import { mediaErrorMessage } from './videos';

// The viewer's choices hold for the session (every player starts with them).
let captionsPref = true;
let ratePref = 1;

const CHIP = cls(
  'inline-flex h-7 items-center justify-center gap-1 rounded-lg px-2 text-[11.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
  FOCUS_RING,
);

const rateLabel = (r: number): string => `${r}×`;

export function VideoPlayer({
  video,
  autoPlay = false,
  onEnded,
  extra,
  className,
}: {
  video: ReadyGuideVideo;
  /** Start playing as soon as it mounts (the viewer just asked for it). */
  autoPlay?: boolean;
  onEnded?: () => void;
  /** More controls at the right end of the caption bar (e.g. "Read the guide"). */
  extra?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const [started, setStarted] = useState(autoPlay);
  const [captions, setCaptions] = useState(captionsPref);
  const [rate, setRate] = useState(ratePref);
  const [error, setError] = useState<string | null>(null);
  const [captionsError, setCaptionsError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const urls = videoUrls(video.id);
  const duration = fmtVideoDuration(video.durationSec);

  const play = (): void => {
    const el = ref.current;
    if (!el) return;
    setStarted(true);
    el.play().catch((err: unknown) => {
      const name = (err as DOMException)?.name;
      if (name === 'AbortError') return; // a new load or a pause got in first
      if (name === 'NotAllowedError') {
        setStarted(false); // autoplay refused: show the play button again
        return;
      }
      // A load failure also fires 'error' (with a better message); this covers the rest.
      if (!el.error) setError(`The video couldn't start (${(err as Error)?.message ?? String(err)}).`);
    });
  };

  // A different video (or Try again): back to the poster, unless it should play right away.
  useEffect(() => {
    setError(null);
    setCaptionsError(false);
    setStarted(autoPlay);
    if (autoPlay) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id, attempt]);

  // Captions on / off: the track's mode (re-applied once the track is known).
  const applyCaptions = (): void => {
    const el = ref.current;
    if (!el) return;
    for (const t of Array.from(el.textTracks)) if (t.kind === 'captions' || t.kind === 'subtitles') t.mode = captions ? 'showing' : 'hidden';
  };
  useEffect(applyCaptions, [captions, video.id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  }, [rate, video.id, attempt]);

  // <track> errors aren't a React event everywhere: listen directly.
  useEffect(() => {
    const t = trackRef.current;
    if (!t) return;
    const onErr = (): void => setCaptionsError(true);
    t.addEventListener('error', onErr);
    return () => t.removeEventListener('error', onErr);
  }, [video.id, attempt, error]);

  const toggleCaptions = (): void => {
    captionsPref = !captions;
    setCaptions(!captions);
  };
  const pickRate = (r: number): void => {
    ratePref = r;
    setRate(r);
  };

  return (
    <figure className={cls('mt-5 overflow-hidden rounded-2xl border border-white/10 bg-[#07070b] shadow-krypt-card', className)} aria-label={`Video: ${video.title}`}>
      <div className="relative aspect-video w-full bg-black">
        {error ? (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <TriangleAlert className="h-6 w-6 text-amber-300" aria-hidden="true" />
            <p className="max-w-sm text-[13px] leading-relaxed text-amber-100/90">
              {error} Reinstalling Krypt Studio puts the tutorial videos back.
            </p>
            <button type="button" onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }} className={cls(CHIP, 'border border-white/10 bg-white/[0.06] text-white/90 hover:border-white/20 hover:bg-white/10')}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </button>
          </div>
        ) : (
          <video
            key={`${video.id}:${attempt}`}
            ref={ref}
            data-guide-video=""
            className="absolute inset-0 h-full w-full"
            src={urls.src}
            poster={urls.poster}
            preload="metadata"
            crossOrigin="anonymous"
            playsInline
            controls={started}
            controlsList="nodownload noremoteplayback"
            disablePictureInPicture
            onLoadedMetadata={() => {
              applyCaptions();
              const el = ref.current;
              if (el) el.playbackRate = rate;
            }}
            onPlay={(e) => {
              setStarted(true);
              // one tutorial at a time
              for (const other of Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-guide-video]'))) if (other !== e.currentTarget && !other.paused) other.pause();
            }}
            onEnded={onEnded}
            onError={() => setError(mediaErrorMessage(ref.current?.error?.code))}
          >
            <track ref={trackRef} kind="captions" src={urls.captions} srcLang="en" label="English" default />
          </video>
        )}
        {!started && !error && (
          <button
            type="button"
            onClick={play}
            aria-label={`Play “${video.title}”${duration ? ` (${duration})` : ''}`}
            className={cls('group absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/0 via-black/10 to-black/55', FOCUS_RING)}
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-krypt-gradient text-white shadow-krypt-glow transition group-hover:scale-105 motion-reduce:transition-none">
              <Play className="ml-0.5 h-6 w-6" fill="currentColor" aria-hidden="true" />
            </span>
            {duration && <span className="absolute bottom-2.5 right-2.5 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white/90">{duration}</span>}
          </button>
        )}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-white/10 px-3 py-2">
        <span className="min-w-0 flex-1 basis-40">
          <span className="block truncate text-[12.5px] font-semibold text-white">{video.title}</span>
          <span className="block truncate text-[11.5px] text-krypt-muted">
            {duration}
            {duration && ' · '}
            {video.description}
          </span>
        </span>
        <button
          type="button"
          onClick={toggleCaptions}
          aria-pressed={captions}
          disabled={!!error}
          title={captions ? 'Captions on: click to hide them' : 'Captions off: click to show them'}
          className={cls(CHIP, captions ? 'border border-krypt-purple/40 bg-krypt-purple/[0.14] text-purple-200' : 'border border-white/10 bg-white/[0.04] text-white/70 hover:text-white')}
        >
          {captions ? <Captions className="h-3.5 w-3.5" aria-hidden="true" /> : <CaptionsOff className="h-3.5 w-3.5" aria-hidden="true" />}
          CC
        </button>
        <div role="group" aria-label="Playback speed" className="flex items-center rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
          {PLAYBACK_RATES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => pickRate(r)}
              aria-pressed={rate === r}
              disabled={!!error}
              title={`Play at ${rateLabel(r)} speed`}
              className={cls(CHIP, 'h-6 px-1.5 font-mono', rate === r ? 'bg-white/10 text-white' : 'text-krypt-muted hover:text-white')}
            >
              {rateLabel(r)}
            </button>
          ))}
        </div>
        {extra}
      </figcaption>
      {captionsError && !error && (
        <p role="status" className="flex items-center gap-1.5 border-t border-white/10 bg-amber-500/[0.06] px-3 py-1.5 text-[11.5px] text-amber-100/90">
          <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0 text-amber-300" aria-hidden="true" /> The captions for this video couldn't be loaded. The video still plays.
        </p>
      )}
    </figure>
  );
}
