import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronLeft, Compass, ExternalLink, SkipForward, WandSparkles, X } from 'lucide-react';
import { openDialog } from '../components/Dialog';
import { cls } from '../utils/format';
import { parseInline } from '../guides/markup';
import { popoutWindows } from '../workspace/WindowManager';
import { shortcutFor } from '../input/keymap';
import { useHome } from '../home/store';
import { toast } from '../app/notify';
import { TOURS, TOUR_ORDER } from './tours';
import { actOf, placeCard, recoveryFor, shouldOfferFirstTour, textOf, type AnchorState, type Rect, type Side } from './logic';
import {
  checkStep,
  chooseAi,
  ctxOf,
  currentSteps,
  doItForMe,
  markOffered,
  nextStep,
  perform,
  prevStep,
  requestCloseTour,
  startTour,
  takeSnapshot,
  tourStorageOk,
  useTours,
  type TourRun,
} from './store';
import type { TourCtx, TourId, TourStep } from './types';

const Z_DIM = 990;
const Z_CARD = 1095;
const PAD = 6;
const GRACE_MS = 700;

const BTN = 'inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-semibold transition outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/80 disabled:opacity-40';
const PRIMARY = cls(BTN, 'bg-krypt-gradient text-white shadow-krypt-glow hover:brightness-110 active:scale-[0.98]');
const GHOST = cls(BTN, 'border border-white/10 bg-white/[0.05] text-white/90 hover:border-white/20 hover:bg-white/10');
const QUIET = cls(BTN, 'px-3 text-krypt-muted hover:bg-white/5 hover:text-white');

export function KeyCaps({ keys, big = false }: { keys: string; big?: boolean }) {
  const parts = keys.split('+').filter(Boolean);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap align-baseline">
      {parts.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-krypt-muted">+</span>}
          <kbd
            className={cls(
              'rounded-lg border border-white/20 border-b-[3px] bg-white/[0.08] font-mono font-semibold text-white',
              big ? 'min-w-[3rem] px-3 py-1.5 text-center text-[22px]' : 'px-1.5 py-px text-[0.9em]',
            )}
          >
            {k}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}

function Rich({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((r, i) => {
        if (r.t === 'b') return <strong key={i} className="font-bold text-white">{r.v}</strong>;
        if (r.t === 'code') return <code key={i} className="select-text rounded-md bg-black/50 px-1.5 py-0.5 font-mono text-[0.88em] text-purple-200">{r.v}</code>;
        if (r.t === 'kbd') return <KeyCaps key={i} keys={r.v} />;
        if (r.t === 'text') return <Fragment key={i}>{r.v}</Fragment>;
        return <Fragment key={i}>{r.label}</Fragment>;
      })}
    </>
  );
}

function sized(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

function selectorsFor(step: TourStep, run: TourRun): string[] {
  const a = step.anchor;
  if (!a) return [];
  const out: string[] = [];
  try {
    const s = a.selector?.(takeSnapshot(), ctxOf(run));
    if (s) out.push(s);
  } catch {
  }
  if (a.guide) out.push(`[data-guide="${a.guide}"]`);
  return out;
}

function findIn(doc: Document, sels: string[]): HTMLElement | null {
  for (const sel of sels) {
    try {
      for (const el of doc.querySelectorAll<HTMLElement>(sel)) if (sized(el)) return el;
    } catch {
    }
  }
  return null;
}

function covered(el: HTMLElement, card: HTMLElement | null): boolean {
  const r = el.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 40), 0), window.innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return false;
  if (card && card.contains(hit)) return false;
  if (hit.closest('[data-krypt-menu], [data-krypt-dialog], [data-krypt-modal], [data-krypt-tour]')) return false;
  return true;
}

interface Located {
  state: AnchorState | 'none';
  rect: Rect | null;
}

function locate(step: TourStep, sels: string[], card: HTMLElement | null): Located {
  if (!step.anchor) return { state: 'none', rect: null };
  const el = findIn(document, sels);
  if (el) {
    const r = el.getBoundingClientRect();
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    return { state: covered(el, card) ? 'covered' : 'ok', rect };
  }
  for (const w of popoutWindows()) {
    try {
      if (findIn(w.document, sels)) return { state: 'elsewhere', rect: null };
    } catch {
    }
  }
  return { state: 'missing', rect: null };
}

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b || (!!a && !!b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

function useLocated(step: TourStep | null, run: TourRun | null, cardRef: React.RefObject<HTMLDivElement | null>): Located {
  const [loc, setLoc] = useState<Located>({ state: 'none', rect: null });
  useEffect(() => {
    if (!step || !run) return;
    let raf = 0;
    let last: Located | null = null;
    let sels: string[] = [];
    let selsAt = -Infinity;
    const tick = (): void => {
      const t = performance.now();
      if (t - selsAt > 250) {
        sels = selectorsFor(step, run);
        selsAt = t;
      }
      const now = locate(step, sels, cardRef.current);
      if (!last || now.state !== last.state || !sameRect(now.rect, last.rect)) {
        last = now;
        setLoc(now);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, run?.tourId, run?.index, run?.choice]);
  return loc;
}

function useViewport(): { width: number; height: number } {
  const [v, setV] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const on = (): void => setV({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

function Highlight({ rect, side }: { rect: Rect; side: Side | null }) {
  const box: CSSProperties = { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
  const Arrow = side === 'below' ? ArrowUp : side === 'above' ? ArrowDown : side === 'right' ? ArrowLeft : side === 'left' ? ArrowRight : null;
  const arrowPos: CSSProperties =
    side === 'below'
      ? { left: rect.left + rect.width / 2 - 18, top: rect.top + rect.height + PAD + 2 }
      : side === 'above'
        ? { left: rect.left + rect.width / 2 - 18, top: rect.top - PAD - 38 }
        : side === 'right'
          ? { left: rect.left + rect.width + PAD + 2, top: rect.top + rect.height / 2 - 18 }
          : { left: rect.left - PAD - 38, top: rect.top + rect.height / 2 - 18 };
  return (
    <>
      <div aria-hidden="true" className="pointer-events-none fixed rounded-xl transition-all duration-200 motion-reduce:transition-none" style={{ ...box, zIndex: Z_DIM, boxShadow: '0 0 0 200vmax rgba(4,4,10,0.64)' }} />
      <div aria-hidden="true" className="pointer-events-none fixed animate-pulse rounded-xl motion-reduce:animate-none" style={{ ...box, zIndex: Z_DIM + 1, boxShadow: '0 0 0 4px rgba(168,85,247,0.28), 0 0 32px rgba(168,85,247,0.55)' }} />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed rounded-xl"
        style={{
          ...box,
          zIndex: Z_DIM + 2,
          padding: 3,
          background: 'linear-gradient(135deg,#6366F1,#A855F7,#EC4899)',
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
        }}
      />
      {Arrow && (
        <div
          aria-hidden="true"
          className={cls('pointer-events-none fixed flex h-9 w-9 items-center justify-center rounded-full bg-krypt-gradient text-white shadow-krypt-glow motion-reduce:animate-none', side === 'below' || side === 'above' ? 'animate-bounce' : 'animate-pulse')}
          style={{ ...arrowPos, zIndex: Z_DIM + 3 }}
        >
          <Arrow className="h-5 w-5" strokeWidth={2.5} />
        </div>
      )}
    </>
  );
}

function Dots({ count, index }: { count: number; index: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={`Step ${index + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={cls('h-2 rounded-full transition-all', i === index ? 'w-5 bg-krypt-gradient' : i < index ? 'w-2 bg-krypt-purple/70' : 'w-2 bg-white/15')} />
      ))}
    </div>
  );
}

function TourCardBody({ step, run, steps, located, searching }: { step: TourStep; run: TourRun; steps: TourStep[]; located: Located; searching: boolean }) {
  const c: TourCtx = ctxOf(run);
  const tour = TOURS[run.tourId];
  const last = run.index === steps.length - 1;
  const act = actOf(step, c);
  const [snap, setSnap] = useState(() => takeSnapshot({ keys: run.keys, assisted: run.assisted }));
  useEffect(() => {
    const t = setInterval(() => setSnap(takeSnapshot({ keys: run.keys, assisted: run.assisted })), 300);
    return () => clearInterval(t);
  }, [run.keys, run.assisted]);
  const progress = step.progress?.(snap, run.base, c) ?? null;
  const recovery = !searching && located.state !== 'ok' && located.state !== 'none' ? recoveryFor(step, located.state, snap, c) : null;
  const keys = step.do === 'key' && step.keys ? (step.command ? shortcutFor(step.command) : undefined) ?? step.keys : null;

  return (
    <>
      <div className="h-px w-full bg-krypt-gradient opacity-80" aria-hidden="true" />
      <div className="p-5">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 flex-shrink-0 text-krypt-purple" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">
            {tour.title} · {run.index + 1} / {steps.length}
          </span>
          <button type="button" onClick={() => void requestCloseTour()} aria-label="Close the tour (Esc)" title="Close the tour (Esc)" className="flex h-8 w-8 items-center justify-center rounded-lg text-krypt-muted transition hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <h2 className="mt-2 text-[22px] font-bold leading-tight tracking-tight text-white">{textOf(step.title, c)}</h2>
        <p className="mt-2 text-[16px] leading-relaxed text-white/85">
          <Rich text={textOf(step.text, c)} />
        </p>

        {keys && (
          <div className="mt-4 flex items-center gap-3">
            <span className="text-[13px] font-semibold text-krypt-muted">Press</span>
            <KeyCaps keys={keys} big />
          </div>
        )}

        {progress && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[13px] font-semibold text-white/85">
            <span className="h-2 w-2 rounded-full bg-krypt-purple" aria-hidden="true" />
            {progress}
          </div>
        )}

        {run.completing && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[14px] font-semibold text-emerald-200" role="status">
            <Check className="h-4 w-4" /> Nice! That's it.
          </div>
        )}

        {step.choices && (
          <div className="mt-4 grid gap-2">
            {step.choices.map((ch) => (
              <button
                key={ch.id}
                type="button"
                onClick={() => chooseAi(ch.id)}
                className="group flex w-full flex-col items-start rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-left transition hover:border-krypt-purple/50 hover:bg-krypt-purple/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/80"
              >
                <span className="text-[15px] font-bold text-white">{ch.label}</span>
                <span className="text-[12.5px] text-krypt-muted group-hover:text-white/75">{ch.detail}</span>
              </button>
            ))}
          </div>
        )}

        {step.links && (
          <div className="mt-4 flex flex-wrap gap-2">
            {step.links.map((l) => (
              <button key={l.url} type="button" className={PRIMARY} onClick={() => void perform({ kind: 'external', url: l.url }, c)}>
                <ExternalLink className="h-4 w-4" /> {l.label}
              </button>
            ))}
          </div>
        )}

        {!!step.notes?.length && (
          <ul className="mt-3 space-y-1.5">
            {step.notes.map((n, i) => (
              <li key={i} className="flex gap-2 text-[13px] leading-snug text-krypt-muted">
                <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-krypt-purple" aria-hidden="true" />
                <span>
                  <Rich text={textOf(n, c)} />
                </span>
              </li>
            ))}
          </ul>
        )}

        {recovery && (
          <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3" role="alert">
            <p className="text-[14px] leading-snug text-amber-100">
              <Rich text={recovery.message} />
            </p>
            <button type="button" className={cls(GHOST, 'mt-2.5 h-9 border-amber-300/30')} onClick={() => void perform(recovery.action, c)}>
              {recovery.label}
            </button>
          </div>
        )}

        {last && step.next && (
          <div className="mt-4 grid gap-2">
            {step.next.map((id) => (
              <button key={id} type="button" className={cls(GHOST, 'h-auto justify-start py-2.5 text-left')} onClick={() => startTour(id)}>
                <Compass className="h-4 w-4 flex-shrink-0 text-krypt-purple" />
                <span>
                  Next tour: {TOURS[id].title}
                  <span className="block text-[12px] font-normal text-krypt-muted">{TOURS[id].blurb}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-3">
          <Dots count={steps.length} index={run.index} />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {run.index > 0 && (
              <button type="button" className={QUIET} onClick={prevStep}>
                <ChevronLeft className="h-4 w-4" /> Back
              </button>
            )}
            {step.do !== 'read' && step.do !== 'choose' && (
              <button type="button" className={QUIET} onClick={nextStep} title="Go on without doing this step">
                <SkipForward className="h-4 w-4" /> Skip
              </button>
            )}
            {act && !run.completing && (
              <button type="button" className={GHOST} onClick={() => void doItForMe()}>
                <WandSparkles className="h-4 w-4" /> {step.actLabel ?? 'Do it for me'}
              </button>
            )}
            {step.do === 'read' && (
              <button type="button" className={PRIMARY} onClick={nextStep}>
                {last ? 'Finish' : 'Next'} {!last && <ArrowRight className="h-4 w-4" />}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const CARD_W = 460;

function TourOverlay({ run }: { run: TourRun }) {
  const steps = currentSteps(run);
  const step = steps[run.index] ?? null;
  const cardRef = useRef<HTMLDivElement>(null);
  const view = useViewport();
  const located = useLocated(step, run, cardRef);
  const [cardH, setCardH] = useState(320);
  const [searching, setSearching] = useState(true);

  useEffect(() => {
    setSearching(true);
    const t = setTimeout(() => setSearching(false), GRACE_MS);
    return () => clearTimeout(t);
  }, [run.tourId, run.index, run.choice]);

  useEffect(() => {
    const t = setInterval(checkStep, 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented) return;
      if (document.querySelector('[data-krypt-menu], [data-krypt-dialog], [data-krypt-modal]')) return;
      const s = currentSteps(useTours.getState().run)[useTours.getState().run?.index ?? 0];
      if (s?.keepEsc) return;
      e.preventDefault();
      e.stopPropagation();
      void requestCloseTour();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = (): void => setCardH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [step]);

  if (!step) return null;
  const cardW = Math.min(CARD_W, view.width - 24);
  const target = located.state === 'ok' || located.state === 'covered' ? located.rect : null;
  let pos: { left: number; top: number; side: Side | null };
  if (target) pos = placeCard(target, { width: cardW, height: cardH }, view);
  else if (step.place === 'corner') pos = { left: Math.max(12, view.width - cardW - 20), top: Math.max(12, view.height - cardH - 48), side: null };
  else pos = { left: Math.max(12, (view.width - cardW) / 2), top: Math.max(12, (view.height - cardH) / 2), side: null };

  return (
    <div data-krypt-tour="" className="font-sans">
      {target && located.state === 'ok' ? (
        <Highlight rect={target} side={pos.side === 'over' ? null : pos.side} />
      ) : (
        step.place !== 'corner' && <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-[rgba(4,4,10,0.55)]" style={{ zIndex: Z_DIM }} />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-label={`Tour: ${TOURS[run.tourId].title}`}
        aria-live="polite"
        className="fixed overflow-y-auto rounded-2xl border border-white/10 bg-[#0e0e17]/[0.97] text-white shadow-[0_18px_60px_rgba(0,0,0,0.65),0_0_30px_rgba(168,85,247,0.18)] transition-[left,top] duration-200 ease-out motion-reduce:transition-none"
        style={{ left: pos.left, top: pos.top, width: cardW, maxHeight: view.height - 24, zIndex: Z_CARD }}
      >
        <TourCardBody step={step} run={run} steps={steps} located={located} searching={searching} />
      </div>
    </div>
  );
}

const OFFER_DELAY_MS = 1500;

function FirstTourOffer() {
  const later = (): void => {
    useTours.setState({ offer: false });
    toast.info('Start a tour any time from Help ▸ Tours, or from the Home screen.');
  };
  return (
    <div
      data-krypt-tour=""
      role="dialog"
      aria-label="Take the tour?"
      className="fixed bottom-6 left-1/2 w-[min(480px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/10 bg-[#0e0e17]/[0.97] font-sans text-white shadow-[0_18px_60px_rgba(0,0,0,0.65),0_0_30px_rgba(168,85,247,0.18)] animate-pop-in"
      style={{ zIndex: Z_CARD }}
    >
      <div className="h-px w-full bg-krypt-gradient opacity-80" aria-hidden="true" />
      <div className="p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">New here?</div>
        <div className="mt-1 text-[20px] font-bold leading-tight tracking-tight">Make your first beat, step by step</div>
        <p className="mt-1.5 text-[14px] leading-relaxed text-white/75">A short tour points at the exact buttons to click. About {TOURS['first-beat'].minutes} minutes; you can stop any time.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={PRIMARY} onClick={() => startTour('first-beat')}>
            <Compass className="h-4 w-4" /> Start the tour
          </button>
          <button type="button" className={QUIET} onClick={later}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

export function TourHost() {
  const run = useTours((s) => s.run);
  const offer = useTours((s) => s.offer);
  const homeReady = useHome((s) => s.phase === 'ready');
  const homeOpen = useHome((s) => s.open);

  useEffect(() => {
    if (!homeReady || homeOpen) return;
    let t = 0;
    const tryOffer = (): void => {
      const s = useTours.getState();
      if (!shouldOfferFirstTour(s.memory, { storageOk: tourStorageOk(), active: !!s.run })) return;
      if (useHome.getState().open || s.memory.cardHidden) return;
      if (document.querySelector('[data-krypt-dialog], [role="dialog"][aria-modal="true"], [role="alertdialog"]')) {
        t = window.setTimeout(tryOffer, 2000);
        return;
      }
      markOffered();
      useTours.setState({ offer: true });
    };
    t = window.setTimeout(tryOffer, OFFER_DELAY_MS);
    return () => clearTimeout(t);
  }, [homeReady, homeOpen]);

  if (run) return <TourOverlay run={run} />;
  if (offer && !homeOpen) return <FirstTourOffer />;
  return null;
}

function TourList({ close }: { close: () => void }): ReactNode {
  const finished = useTours((s) => s.memory.finished);
  return (
    <div className="space-y-2 p-4">
      {TOUR_ORDER.map((id: TourId) => {
        const t = TOURS[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              close();
              startTour(id);
            }}
            className="flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left transition hover:border-krypt-purple/50 hover:bg-krypt-purple/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/80"
          >
            <Compass className="mt-0.5 h-5 w-5 flex-shrink-0 text-krypt-purple" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-[14px] font-bold text-white">{t.title}</span>
                {finished.includes(id) && <Check className="h-3.5 w-3.5 text-emerald-300" aria-label="done before" />}
              </span>
              <span className="block text-[12.5px] leading-snug text-krypt-muted">{t.blurb}</span>
            </span>
            <span className="flex-shrink-0 font-mono text-[11px] text-krypt-muted">~{t.minutes} min</span>
          </button>
        );
      })}
    </div>
  );
}

export function openTourPicker(doc?: Document | null): void {
  openDialog({
    title: 'Tours',
    subtitle: 'Step-by-step help that points at the real buttons. Stop any time with Esc.',
    icon: Compass,
    width: 520,
    doc,
    render: (close) => <TourList close={close} />,
  });
}
