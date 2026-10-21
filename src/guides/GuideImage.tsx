// ──────────────────────────────────────────────────────────────────────
// {{image:<file>|<caption>}} in a guide: an annotated screenshot from
// resources/guides/images (served read-only from app://bundle/guide-images/,
// shared/guides/images.ts). The caption is the alt text; a click enlarges
// it (Esc, the × or a click outside closes); a file that can't be loaded
// becomes a visible "picture missing" note, never a broken image.
// ──────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageOff, Maximize2, X } from 'lucide-react';
import { guideImageUrl } from '@shared/guides/images';
import { cls } from '../utils/format';
import { FOCUS_RING } from '../home/ui';

function Lightbox({ src, caption, doc, onClose }: { src: string; caption: string; doc: Document; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = doc.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // preventDefault: Home's Esc ("one level back") skips handled keys.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    doc.addEventListener('keydown', onKey, true);
    return () => {
      doc.removeEventListener('keydown', onKey, true);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [doc, onClose]);
  return createPortal(
    <div
      data-krypt-modal=""
      role="dialog"
      aria-modal="true"
      aria-label={caption}
      onClick={onClose}
      className="fixed inset-0 z-[1100] flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-[#05050c]/90 p-6 font-sans backdrop-blur-sm animate-fade-in"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close the picture (Esc)"
        className={cls('absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.06] text-white/80 transition hover:border-white/25 hover:text-white', FOCUS_RING)}
      >
        <X className="h-4 w-4" />
      </button>
      <img src={src} alt={caption} draggable={false} className="max-h-[84vh] max-w-full rounded-xl border border-white/10 object-contain shadow-krypt-card" />
      <p className="max-w-[900px] text-center text-[13px] text-white/75">{caption}</p>
    </div>,
    doc.body,
  );
}

export function GuideImage({ file, caption }: { file: string; caption: string }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const src = guideImageUrl(file);
  if (failed) {
    return (
      <div role="note" className="mt-4 flex gap-2.5 rounded-xl border border-amber-400/25 bg-amber-500/[0.07] px-3.5 py-3 text-[13px] leading-relaxed text-amber-100/90">
        <ImageOff className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" aria-hidden="true" />
        <span>
          The picture for this step is missing ({file}). It showed: {caption}. Reinstalling Krypt Studio puts it back.
        </span>
      </div>
    );
  }
  return (
    <figure ref={ref} className="mt-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Enlarge the picture: ${caption}`}
        title="Click to enlarge"
        className={cls('group relative block w-full cursor-zoom-in overflow-hidden rounded-xl border border-white/10 bg-black/40 transition hover:border-white/20', FOCUS_RING)}
      >
        <img src={src} alt={caption} loading="lazy" draggable={false} onError={() => setFailed(true)} className="block h-auto w-full" />
        <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/70 text-white/80 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">
          <Maximize2 className="h-3.5 w-3.5" />
        </span>
      </button>
      <figcaption className="mt-1.5 text-[12px] leading-snug text-krypt-muted">{caption}</figcaption>
      {open && <Lightbox src={src} caption={caption} doc={ref.current?.ownerDocument ?? document} onClose={close} />}
    </figure>
  );
}
