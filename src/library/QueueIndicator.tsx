// Status-bar indicator for the reference library's analysis queue, next to
// the analyzer jobs: "Library 312/1,500 ▓▓░ 14m". Paused shows a pause
// icon. Click opens the Library panel. Hidden when the queue is idle.

import { LibraryBig, Pause } from 'lucide-react';
import { ProgressBar } from '../ears/ProgressBar';
import { fmtCount, fmtEtaShort, queueActive, queueFraction, queueHeadline, fmtEta } from './logic';
import { useLibrary } from './store';
import { openLibrary } from './actions';

export function LibraryQueueIndicator() {
  const q = useLibrary((s) => s.state?.queue ?? null);
  if (!q || !queueActive(q)) return null;
  const paused = q.paused;
  const eta = paused ? '' : fmtEtaShort(q.etaSec);
  const hint = `Reference library: ${queueHeadline(q)}${q.current && !paused ? ` · ${q.current}` : ''}${!paused && fmtEta(q.etaSec) ? ` · ${fmtEta(q.etaSec)}` : ''}. Click to open the Library.`;
  return (
    <button
      type="button"
      onClick={() => openLibrary()}
      data-hint={hint}
      className="flex h-5 flex-shrink-0 items-center gap-1.5 rounded-md px-1.5 text-white/80 transition hover:bg-white/[0.06] hover:text-white"
    >
      {paused ? <Pause className="h-3 w-3 flex-shrink-0 text-amber-300" /> : <LibraryBig className="h-3 w-3 flex-shrink-0 animate-pulse text-krypt-purple" />}
      <span className="hidden sm:inline">{paused ? 'Library paused' : 'Library'}</span>
      <span className="font-mono">
        {fmtCount(q.done)}/{fmtCount(q.total)}
      </span>
      <span className="w-12 flex-shrink-0">
        <ProgressBar fraction={queueFraction(q)} className="h-1" />
      </span>
      {eta && <span className="hidden font-mono text-krypt-muted md:inline">{eta}</span>}
    </button>
  );
}
