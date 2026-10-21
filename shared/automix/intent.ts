// ──────────────────────────────────────────────────────────────────────
// Prompt → AutoMixIntent (research/20 §2), the built-in keyword parser.
// Pure and forgiving: English mixing talk ("vocals on top, punchy, not
// harsh, streaming loud", "too much bass", "a bit brighter", "-9 LUFS")
// becomes small adjustments (-2..2) on top of a preset card. The AI path
// (electron/automix/ai.ts) returns the same shape; clampIntent() makes
// either safe.
// ──────────────────────────────────────────────────────────────────────

import type { AutoMixIntent } from './types';
import { AUTO_MIX_PRESETS, presetForGenre } from './presets';

/** The adjustable dimensions of an intent (all -2..2). */
export const INTENT_KEYS = ['louder', 'brighter', 'warmer', 'punchier', 'wider', 'bassier', 'vocalsForward', 'vocalSpace', 'lessHarsh', 'cleaner'] as const;
export type IntentKey = (typeof INTENT_KEYS)[number];

/** Loudness targets a prompt may ask for (LUFS). */
export const LUFS_RANGE = { min: -24, max: -5 } as const;

const WORDS: Record<IntentKey, { up: string; down: string }> = {
  louder: { up: 'louder', down: 'quieter' },
  brighter: { up: 'brighter', down: 'darker' },
  warmer: { up: 'warmer', down: 'cleaner top' },
  punchier: { up: 'punchier', down: 'softer' },
  wider: { up: 'wider', down: 'narrower' },
  bassier: { up: 'more bass', down: 'less bass' },
  vocalsForward: { up: 'vocals forward', down: 'vocals tucked in' },
  vocalSpace: { up: 'more reverb on the vocals', down: 'drier vocals' },
  lessHarsh: { up: 'less harsh', down: 'more bite' },
  cleaner: { up: 'clean', down: 'aggressive' },
};

const clampStep = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  const r = Math.max(-2, Math.min(2, Math.round(n)));
  return r === 0 ? undefined : r;
};

/** A safe intent from anything (the AI's JSON, a renderer payload): unknown fields dropped, values clamped. */
export function clampIntent(raw: unknown, source: AutoMixIntent['source']): AutoMixIntent {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: AutoMixIntent = { summary: '', source };
  const pid = typeof o.presetId === 'string' ? o.presetId.trim().toLowerCase() : '';
  if (pid && AUTO_MIX_PRESETS.some((p) => p.id === pid)) out.presetId = pid;
  const t = typeof o.targetLufs === 'number' ? o.targetLufs : Number.NaN;
  if (Number.isFinite(t) && t !== 0) out.targetLufs = Math.round(Math.max(LUFS_RANGE.min, Math.min(LUFS_RANGE.max, t)) * 10) / 10;
  for (const k of INTENT_KEYS) {
    const v = clampStep(o[k]);
    if (v !== undefined) out[k] = v;
  }
  const s = typeof o.summary === 'string' ? o.summary.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  out.summary = s || summarizeIntent(out);
  return out;
}

/** Plain words for what an intent asks ("louder, brighter, vocals forward"). */
export function summarizeIntent(i: Omit<AutoMixIntent, 'summary' | 'source'>): string {
  const parts: string[] = [];
  if (i.presetId) parts.push(AUTO_MIX_PRESETS.find((p) => p.id === i.presetId)?.name ?? i.presetId);
  if (typeof i.targetLufs === 'number') parts.push(`${i.targetLufs} LUFS`);
  for (const k of INTENT_KEYS) {
    const v = i[k];
    if (!v) continue;
    const w = v > 0 ? WORDS[k].up : WORDS[k].down;
    parts.push(Math.abs(v) >= 2 ? `${w} (a lot)` : w);
  }
  return parts.join(', ');
}

// ── The keyword parser ────────────────────────────────────────────────

interface Rule {
  key: IntentKey;
  /** Matched against a normalised clause (lower case, single spaces, padded with spaces). */
  re: RegExp;
  /** Direction when the word appears plainly ("brighter" +1, "dull" -1 on brighter). */
  sign: 1 | -1;
  /** A complaint word ("harsh", "muddy", "buried"): "not X" / "too X" / "X" all ask for the fix (sign). */
  complaint?: boolean;
  /** Only in a clause that talks about the vocals. */
  vocal?: boolean;
  /** Never in a clause that talks about the vocals (the word means something else there). */
  noVocal?: boolean;
}

const VOCAL_WORDS = /\b(vocals?|vox|voice|voices|singer|singing|rap|rapper|rapping|lyrics|acapella|a cappella|verse vocals?|lead vocals?|ad ?libs?)\b/;

const RULES: Rule[] = [
  // vocals (checked first: "vocals louder" is not "louder")
  { key: 'vocalsForward', vocal: true, sign: 1, re: /\b(louder|up|forward|on top|in front|upfront|up front|front|clear|clearer|audible|hear|stand out|pop out|cut through|present|presence)\b/ },
  { key: 'vocalsForward', vocal: true, sign: 1, complaint: true, re: /\b(buried|drowned|lost|hidden|too quiet|too low|too soft|can ?t hear|cannot hear|hard to hear)\b/ },
  { key: 'vocalsForward', vocal: true, sign: -1, re: /\b(quieter|down|back|tuck|tucked|behind|sit in|sits in|blend|blended|softer|lower)\b/ },
  { key: 'vocalsForward', vocal: true, sign: -1, complaint: true, re: /\b(too loud|too hot|too much|on top of everything|sticks? out)\b/ },
  { key: 'vocalSpace', sign: 1, re: /\b(reverb|reverby|verb|wet|wetter|space|spacious|ambient|ambience|echo|echoes|echoey|delay|delays|lush|hall|plate|atmospheric|dreamy|big room sound)\b/ },
  { key: 'vocalSpace', sign: -1, re: /\b(dry|drier|dryer|intimate|close|in your face|no reverb|no delay)\b/ },
  // loudness
  { key: 'louder', noVocal: true, sign: 1, re: /\b(louder|loud|loudness|slam|slammed|hot|hotter|maximi[sz]ed?|competitive|push it|pushed|volume up|crank)\b/ },
  { key: 'louder', noVocal: true, sign: -1, re: /\b(quieter|quiet|softer overall|dynamic|dynamics|breathe|breathing|turn it down|volume down|not squashed|less squashed)\b/ },
  // tone
  { key: 'brighter', sign: 1, re: /\b(brighter|bright|crisp|crisper|airy|air|sparkle|sparkly|shine|shiny|open|clarity|sizzle|top end)\b/ },
  { key: 'brighter', sign: -1, re: /\b(darker|dark|dull|duller|mellow|muffled|rolled off|vintage top)\b/ },
  { key: 'warmer', sign: 1, re: /\b(warmer|warm|warmth|analog|analogue|tape|tube|saturated|saturation|rich|fat|fatter|body)\b/ },
  { key: 'warmer', sign: -1, re: /\b(cold|colder|clinical|sterile|thin|thinner)\b/ },
  { key: 'punchier', sign: 1, re: /\b(punchy|punchier|punch|hard hitting|hits? hard|knock|knocks|slap|slaps|snappy|tight|tighter|impact|bang|banging)\b/ },
  { key: 'punchier', noVocal: true, sign: -1, re: /\b(soft|gentle|smooth dynamics|laid back|relaxed|chill|mellow drums|round|rounded)\b/ },
  { key: 'wider', sign: 1, re: /\b(wide|wider|width|stereo|spread|bigger stereo|immersive)\b/ },
  { key: 'wider', sign: -1, re: /\b(mono|narrow|narrower|centered|centred|focused|phase)\b/ },
  { key: 'bassier', sign: 1, re: /\b(bass|bassy|bassier|low end|lows|sub|subs|808s?|boomy|boom|heavy|heavier|thump|thumping|weight)\b/ },
  { key: 'bassier', sign: -1, complaint: true, re: /\b(boomy bass|woofy|bloated|too much bass|too boomy)\b/ },
  { key: 'warmer', sign: -1, complaint: true, re: /\b(muddy|mud|boxy|cloudy)\b/ },
  { key: 'lessHarsh', sign: 1, complaint: true, re: /\b(harsh|harshness|sibilant|sibilance|esses|ess|s sounds|piercing|shrill|brittle|fatiguing|ear ?piercing|tinny|de ?ess|deess)\b/ },
  { key: 'lessHarsh', sign: 1, re: /\b(smooth|smoother|silky|soft top|easy on the ears)\b/ },
  { key: 'lessHarsh', sign: -1, re: /\b(bite|edge|edgy|aggressive top)\b/ },
  { key: 'cleaner', sign: 1, re: /\b(clean|cleaner|natural|transparent|pristine|polished|hi ?fi|subtle|gentle master)\b/ },
  { key: 'cleaner', sign: -1, re: /\b(aggressive|crushed|crush|distorted|distortion|dirty|gritty|grit|grimy|slammed|smashed|raw|lo ?fi grit)\b/ },
];

/** Intensity words before / around a match. */
const STRONG = /\b(very|much|way|really|super|lots|a lot|extremely|heavily|massively|seriously|a ton|tons|way more)\b/;
const MILD = /\b(a bit|a little|slightly|bit|little|touch|tad|somewhat|kinda|kind of)\b/;
/** "less X", "not X", "no X", "without X", "reduce X", "lower X", "tame X", "cut X", "fewer X". */
const NEGATE = /\b(less|not|no|without|reduce|reduced|lower|tame|cut|fewer|don ?t|dont|never|remove|kill|lose|minus|turn down)\b/;
/** "too X", "too much X", "overly X" (X is the problem, so the fix goes the other way). */
const TOO = /\b(too|overly|excessively|too much|so much)\b/;

function norm(s: string): string {
  return ` ${s
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[^a-z0-9.+\-& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

/** "-9 LUFS", "lufs -9", "−9", "streaming", "spotify", "club" → a LUFS target. */
export function lufsInText(text: string): number | null {
  const t = text.toLowerCase().replace(/[−–—]/g, '-');
  const m = t.match(/(-?\d{1,2}(?:\.\d)?)\s*(?:lufs|lu\b|db ?lufs)/) ?? t.match(/lufs\s*(?:of|at|to|=|:)?\s*(-?\d{1,2}(?:\.\d)?)/);
  if (m) {
    let v = Number(m[1]);
    if (v > 0) v = -v; // "9 LUFS" means -9
    if (Number.isFinite(v)) return Math.max(LUFS_RANGE.min, Math.min(LUFS_RANGE.max, v));
  }
  const n = norm(text);
  if (/\b(spotify|apple music|tidal|youtube|streaming|deezer|amazon music)\b/.test(n) && !/\bloud\b/.test(n.replace(/streaming loud/, ''))) return -14;
  if (/\b(podcast|audiobook|spoken word|voice ?over)\b/.test(n)) return -16;
  if (/\b(broadcast|tv|television|ebu|r128)\b/.test(n)) return -23;
  if (/\bsoundcloud\b/.test(n)) return -9;
  return null;
}

/** Does the prompt ask for pitch correction (Krypt Tune)? Returns the style or null. */
export function tuneInText(text: string): 'natural' | 'pop' | 'hard' | null {
  const n = norm(text);
  const hit = n.match(/\b(no|without|don ?t|not)\s+(?:\w+\s+){0,2}(tune|tuning|pitch correction|autotune|auto tune)\b/);
  if (hit) return null;
  if (/\b(hard tune|hard tuned|robotic|t ?pain|heavy tune|heavily tuned|stepped)\b/.test(n)) return 'hard';
  if (/\b(tune|tuned|tuning|autotune|auto tune|pitch correct|pitch correction|pitch corrected|in key|in tune|krypt tune)\b/.test(n)) return /\b(pop|obvious|modern)\b/.test(n) ? 'pop' : 'natural';
  return null;
}

/** Does the prompt name a card? (a genre, or a card's own name: "lofi", "podcast", "club"). */
export function presetInText(text: string): string | null {
  const n = norm(text);
  const named: Array<[RegExp, string]> = [
    [/\b(podcast|voice ?over|spoken|talk|speech|audiobook)\b/, 'podcast-voice'],
    [/\b(rock|live band|band|live take|indie|punk|metal|acoustic)\b/, 'rock-live'],
    [/\b(club|edm|festival|rave|dance floor|dancefloor)\b/, 'club-edm'],
    [/\b(lo ?fi|lofi|chillhop|study beats?)\b/, 'lofi'],
    [/\b(phonk)\b/, 'phonk-slam'],
    [/\b(trap|drill)\b/, 'loud-trap'],
    [/\b(r ?(&|and|n) ?b|rnb|neo soul|soul)\b/, 'warm-rnb'],
    [/\b(boom ?bap|hip ?hop|old school)\b/, 'hiphop-punch'],
    [/\b(pop|radio|top 40|polished pop)\b/, 'pop-polish'],
    [/\b(streaming clean|spotify ready)\b/, 'streaming-clean'],
    [/\b(balanced)\b/, 'balanced'],
  ];
  for (const [re, id] of named) if (re.test(n)) return id;
  const g = presetForGenre(text);
  return g?.id ?? null;
}

/**
 * The keyword parser. Clauses are split on , ; . "and" "but" "with"; within a clause a negation ("less", "not",
 * "no", "reduce") flips a plain word, "too X" asks for the opposite of X, and complaint words ("harsh", "muddy",
 * "buried") always ask for their fix. "very / much / a lot" doubles, "a bit / slightly" keeps 1.
 */
export function parseIntent(prompt: string): AutoMixIntent {
  const text = String(prompt ?? '').slice(0, 2000);
  const acc: Partial<Record<IntentKey, number>> = {};
  const clauses = text
    .split(/[,;!?\n]|\.(?!\d)/)
    .flatMap((part) => norm(part).split(/\s*(?:\band\b|\bbut\b|\bwith\b|\bplus\b|\balso\b|\bthen\b)\s*/))
    .map((c) => ` ${c.trim()} `)
    .filter((c) => c.trim());
  for (const clause of clauses) {
    const vocal = VOCAL_WORDS.test(clause);
    const seen = new Set<IntentKey>();
    for (const r of RULES) {
      if (seen.has(r.key)) continue;
      if (r.vocal && !vocal) continue;
      if (r.noVocal && vocal) continue;
      const m = clause.match(r.re);
      if (!m) continue;
      // The words before the match decide its direction.
      const before = clause.slice(0, m.index ?? 0);
      let sign: number = r.sign;
      if (r.complaint) sign = r.sign;
      else if (TOO.test(before) || / too$/.test(before.trim()) || /\btoo much\b/.test(clause)) sign = -r.sign;
      else if (NEGATE.test(before)) sign = -r.sign;
      // "louder" in a "vocals louder" clause was taken by vocalsForward; "loud" in "too loud" is a complaint.
      const plain = clause.replace(/\b(too|so) much\b/g, ' ');
      const strong = STRONG.test(plain) && !MILD.test(plain);
      const mag = strong ? 2 : 1;
      const v = sign * mag;
      acc[r.key] = (acc[r.key] ?? 0) + v;
      seen.add(r.key);
    }
  }
  const out: AutoMixIntent = { summary: '', source: 'keywords' };
  const preset = presetInText(text);
  if (preset) out.presetId = preset;
  const lufs = lufsInText(text);
  if (lufs !== null) out.targetLufs = lufs;
  for (const k of INTENT_KEYS) {
    const v = clampStep(acc[k]);
    if (v !== undefined) out[k] = v;
  }
  // "club" / "streaming" set the target; don't also read them as louder / quieter.
  if (out.targetLufs !== undefined && out.louder !== undefined && /\b(streaming|spotify|club|lufs)\b/.test(norm(text)) && !/\b(louder|slam|maximi)/.test(norm(text))) delete out.louder;
  out.summary = summarizeIntent(out) || (text.trim() ? 'nothing specific: the preset as it is' : '');
  return out;
}

/** Intent adjustments merged onto a request's overrides: the explicit LUFS wins over the prompt's. */
export function mergeIntents(a: AutoMixIntent | null, b: AutoMixIntent | null): AutoMixIntent | null {
  if (!a) return b;
  if (!b) return a;
  const out: AutoMixIntent = { ...a, source: a.source };
  if (b.presetId && !out.presetId) out.presetId = b.presetId;
  if (b.targetLufs !== undefined && out.targetLufs === undefined) out.targetLufs = b.targetLufs;
  for (const k of INTENT_KEYS) if (out[k] === undefined && b[k] !== undefined) out[k] = b[k];
  out.summary = summarizeIntent(out);
  return out;
}
