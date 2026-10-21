import { toast } from '../app/notify';
import { popoutWindows, revealWorkspace, wm } from '../workspace/WindowManager';
import { runCommand } from '../input/commands';
import { requestBrowserReveal } from '../sounds/store';
import { showHome } from '../home/store';
import { openMashup } from '../mashup/actions';
import { getMashup } from '../mashup/store';
import { openAutoMix, openMasterSong, unfoldMasterPart } from '../automix/actions';
import { getAutoMix } from '../automix/store';
import { openKryptVoice } from '../voice/VoiceDialog';
import { getVoice } from '../voice/store';
import { openRecordVoice } from '../voice/RecordVoiceDialog';
import { GUIDE_ANCHORS, isGuideAnchor, type GuideAnchor, type GuideAnchorId } from './anchors';

const WAIT_MS = 1500;
const RING_MS = 2600;
const RING_ID = 'krypt-guide-ring';

function docs(): Document[] {
  const out: Document[] = [document];
  for (const w of popoutWindows()) {
    try {
      out.push(w.document);
    } catch {
    }
  }
  return out;
}

function sized(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findAnchor(id: string): HTMLElement | null {
  const sel = `[data-guide="${id}"]`;
  for (const d of docs()) {
    for (const el of d.querySelectorAll<HTMLElement>(sel)) if (sized(el)) return el;
  }
  return null;
}

function covered(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const hit = el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
}

const nextFrame = (): Promise<void> => new Promise((res) => requestAnimationFrame(() => res()));

async function waitForAnchor(id: string, ms: number): Promise<HTMLElement | null> {
  const until = performance.now() + ms;
  for (;;) {
    const el = findAnchor(id);
    if (el) return el;
    if (performance.now() > until) return null;
    await nextFrame();
  }
}

function reducedMotion(win: Window): boolean {
  try {
    return win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

let stopRing: (() => void) | null = null;

export function pulseRing(el: HTMLElement): void {
  stopRing?.();
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const reduce = reducedMotion(win);
  const ring = doc.createElement('div');
  ring.id = RING_ID;
  ring.setAttribute('aria-hidden', 'true');
  const pad = 4;
  ring.style.cssText =
    'position:fixed;z-index:2147483000;pointer-events:none;border-radius:10px;padding:2px;' +
    'background:linear-gradient(135deg,#6366F1,#A855F7,#EC4899);' +
    '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;';
  const glow = doc.createElement('div');
  glow.setAttribute('aria-hidden', 'true');
  glow.style.cssText =
    'position:fixed;z-index:2147482999;pointer-events:none;border-radius:12px;' +
    'box-shadow:0 0 0 3px rgba(168,85,247,0.22),0 0 26px rgba(168,85,247,0.45);';
  doc.body.append(glow, ring);

  const anims: Animation[] = [];
  let timer = 0;
  let raf = 0;
  let alive = true;
  const place = (): void => {
    if (!alive) return;
    if (!el.isConnected) return stop();
    const r = el.getBoundingClientRect();
    const box = { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` };
    Object.assign(ring.style, box);
    Object.assign(glow.style, box);
    raf = win.requestAnimationFrame(place);
  };
  place();

  try {
    if (reduce) {
      for (const n of [ring, glow]) anims.push(n.animate([{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: RING_MS, fill: 'forwards' }));
    } else {
      anims.push(ring.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: RING_MS, fill: 'forwards' }));
      anims.push(
        glow.animate(
          [
            { opacity: 0, transform: 'scale(1.06)' },
            { opacity: 1, transform: 'scale(1)', offset: 0.1 },
            { opacity: 0.35, transform: 'scale(1.03)', offset: 0.32 },
            { opacity: 1, transform: 'scale(1)', offset: 0.54 },
            { opacity: 0.35, transform: 'scale(1.03)', offset: 0.76 },
            { opacity: 0 },
          ],
          { duration: RING_MS, fill: 'forwards' },
        ),
      );
    }
  } catch {
  }

  function stop(): void {
    if (!alive) return;
    alive = false;
    win.cancelAnimationFrame(raf);
    win.clearTimeout(timer);
    for (const a of anims) a.cancel();
    ring.remove();
    glow.remove();
    if (stopRing === stop) stopRing = null;
  }
  timer = win.setTimeout(stop, RING_MS + 50);
  stopRing = stop;
}

const BEFORE: Partial<Record<GuideAnchorId, () => void>> = {
  'agent.chat': () => runCommand('tools.agentChat'),
  'agent.connect': () => runCommand('tools.connections'),
  'agent.apiKey': () => runCommand('tools.agentChat'),
  'browser.presets': () => requestBrowserReveal('presets'),
  'browser.factory': () => requestBrowserReveal('sounds'),
};

const openMashupForm = (): void => {
  if (getMashup().phase === 'idle') openMashup();
};
const openAutoMixForm = (): void => {
  const s = getAutoMix();
  if (s.visible && s.target === 'file') return;
  if (s.phase === 'idle' || !s.visible) openAutoMix();
};
const openMasterSongForm = (): void => {
  const s = getAutoMix();
  if (!(s.visible && s.target === 'file')) openMasterSong();
};
const unfoldOr = (part: 'reference' | 'more') => (): void => {
  const s = getAutoMix();
  if (s.visible && s.target === 'file') unfoldMasterPart(part);
  else openAutoMixForm();
};
const openVoiceForm = (): void => {
  if (!getVoice().visible) openKryptVoice();
};
const OPEN: Partial<Record<GuideAnchorId, () => void>> = {
  'home.kryptVoice': () => showHome('audio'),
  'voice.text': openVoiceForm,
  'voice.voices': openVoiceForm,
  'voice.tags': openVoiceForm,
  'voice.preview': openVoiceForm,
  'voice.add': openVoiceForm,
  'sing.lyrics': () => runCommand('pianoRoll.sing'),
  'sing.add': () => runCommand('pianoRoll.sing'),
  'voice.record': () => openRecordVoice(),
  'home.autoMashup': () => showHome('audio'),
  'home.masterSong': () => showHome('audio'),
  'home.audioTools': () => showHome('home'),
  'automix.modes': openAutoMixForm,
  'automix.song': openMasterSongForm,
  'automix.reference': unfoldOr('reference'),
  'automix.presets': openAutoMixForm,
  'automix.prompt': unfoldOr('more'),
  'automix.options': unfoldOr('more'),
  'automix.run': openAutoMixForm,
  'automix.ab': () => openAutoMix(),
  'mashup.songs': openMashupForm,
  'mashup.score': openMashupForm,
  'mashup.style': openMashupForm,
  'mashup.stems': openMashupForm,
  'mashup.options': openMashupForm,
  'mashup.plan': openMashupForm,
  'mashup.build': openMashupForm,
};

function cannotShow(a: GuideAnchor, why?: string): void {
  toast.warn(`Couldn't show ${a.label}: ${why ?? a.missing ?? "it isn't on screen right now"}.`);
}

export async function showGuideAnchor(id: string): Promise<void> {
  if (!isGuideAnchor(id)) {
    toast.error(`This guide points at something that doesn't exist ("${id}").`);
    return;
  }
  const a: GuideAnchor = GUIDE_ANCHORS[id];
  try {
    if (a.panel) {
      if (!wm.ready) return cannotShow(a, 'the Studio is still starting');
      wm.open(a.panel);
      BEFORE[id]?.();
    } else if (OPEN[id]) {
      OPEN[id]!();
    } else {
      const now = findAnchor(id);
      if (!now || covered(now)) revealWorkspace();
    }
    const el = await waitForAnchor(id, WAIT_MS);
    if (!el) return cannotShow(a);
    const reduce = reducedMotion(el.ownerDocument.defaultView ?? window);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    pulseRing(el);
  } catch (err) {
    toast.error(`Couldn't show ${a.label}: ${(err as Error)?.message ?? String(err)}`);
  }
}
