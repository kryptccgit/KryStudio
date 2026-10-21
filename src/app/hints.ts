// ──────────────────────────────────────────────────────────────────────
// The hint bar (FL's top-left hint panel, here in the status bar).
// Any element with `data-hint="..."` shows its hint on hover. Controls push
// live values while dragging; actions can flash a confirmation. All writes go
// straight to the DOM, so hovering never re-renders React.
// ──────────────────────────────────────────────────────────────────────

type Tone = 'info' | 'ok' | 'warn' | 'error' | 'agent';

let el: HTMLElement | null = null;
let hover = '';
let live = '';
let flash: { text: string; tone: Tone; until: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const docs = new WeakSet<Document>();

const TONE_CLASS: Record<Tone, string> = {
  info: 'text-white/80',
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  error: 'text-rose-300',
  agent: 'text-purple-200',
};

function render(): void {
  if (!el) return;
  const now = Date.now();
  let text: string;
  let tone: Tone = 'info';
  if (live) text = live;
  else if (flash && flash.until > now) {
    text = flash.text;
    tone = flash.tone;
  } else text = hover;
  if (el.textContent !== text) el.textContent = text;
  const want = `truncate ${TONE_CLASS[tone]}`;
  if (el.className !== want) el.className = want;
}

export function bindHintElement(node: HTMLElement | null): void {
  el = node;
  render();
}

/** Live text while a gesture runs (knob drag). Pass '' to clear. */
export function setLiveHint(text: string): void {
  live = text;
  render();
}

export function flashHint(text: string, tone: Tone = 'info', ms = 2600): void {
  flash = { text, tone, until: Date.now() + ms };
  render();
  if (timer) clearTimeout(timer);
  timer = setTimeout(render, ms + 20);
}

/** Track `[data-hint]` hovers in a document (main window + every popout). */
export function installHintTracking(doc: Document): void {
  if (docs.has(doc)) return;
  docs.add(doc);
  doc.addEventListener(
    'mouseover',
    (e) => {
      const t = e.target as Element | null;
      const h = t && typeof t.closest === 'function' ? t.closest('[data-hint]') : null;
      const next = h?.getAttribute('data-hint') ?? '';
      if (next !== hover) {
        hover = next;
        render();
      }
    },
    { passive: true },
  );
}
