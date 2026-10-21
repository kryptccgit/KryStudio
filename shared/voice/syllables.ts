export interface LyricSyllable {
  text: string;
  word: string;
  wordIndex: number;
  wordInLine: number;
  line: number;
  hold: number;
  wordStart: boolean;
  wordEnd: boolean;
}

export interface LyricLine {
  text: string;
  words: string[];
  syllables: LyricSyllable[];
}

export interface ParsedLyrics {
  lines: LyricLine[];
  syllables: LyricSyllable[];
  notes: string[];
}

const EXCEPTIONS: Record<string, string[]> = {
  people: ['peo', 'ple'],
  every: ['ev', 'ery'],
  everything: ['ev', 'ery', 'thing'],
  everybody: ['ev', 'ery', 'bod', 'y'],
  everyone: ['ev', 'ery', 'one'],
  everywhere: ['ev', 'ery', 'where'],
  evening: ['eve', 'ning'],
  business: ['bus', 'ness'],
  being: ['be', 'ing'],
  seeing: ['see', 'ing'],
  going: ['go', 'ing'],
  doing: ['do', 'ing'],
  create: ['cre', 'ate'],
  idea: ['i', 'de', 'a'],
  real: ['real'],
  really: ['real', 'ly'],
  quiet: ['qui', 'et'],
  poem: ['po', 'em'],
  science: ['sci', 'ence'],
  eye: ['eye'],
  eyes: ['eyes'],
  one: ['one'],
  once: ['once'],
  someone: ['some', 'one'],
  somebody: ['some', 'bod', 'y'],
  something: ['some', 'thing'],
  sometimes: ['some', 'times'],
  heaven: ['heav', 'en'],
  area: ['ar', 'e', 'a'],
  argue: ['ar', 'gue'],
  forever: ['for', 'ev', 'er'],
  whatever: ['what', 'ev', 'er'],
  whenever: ['when', 'ev', 'er'],
  recipe: ['rec', 'i', 'pe'],
  maybe: ['may', 'be'],
  lonely: ['lone', 'ly'],
  lovely: ['love', 'ly'],
  baby: ['ba', 'by'],
  tonight: ['to', 'night'],
};

const ONSET2 = new Set(['th', 'sh', 'ch', 'ph', 'wh', 'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'tr', 'wr', 'qu', 'gu']);
const ONSET3 = new Set(['str', 'spr', 'scr', 'thr', 'shr', 'sch', 'spl']);
const CODA2 = new Set(['ck', 'ng', 'nk', 'gh']);

const isAeiou = (c: string | undefined): boolean => c !== undefined && 'aeiou'.includes(c);

function vowelMask(w: string): boolean[] {
  const m: boolean[] = [];
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === 'y') m.push(i > 0 && !(isAeiou(w[i - 1]) && isAeiou(w[i + 1])));
    else if (c === 'u' && i > 0 && (w[i - 1] === 'q' || (w[i - 1] === 'g' && isAeiou(w[i + 1])))) m.push(false);
    else m.push(isAeiou(c));
  }
  return m;
}

function splitRun(w: string, s: number, e: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = s;
  for (let i = s; i < e - 1; i++) {
    const pair = w.slice(i, i + 2);
    const before = w[i - 1] ?? '';
    let split = false;
    if (pair === 'io') split = !/[ctsxg]/.test(before);
    else if (pair === 'ia') split = !/[ctsxg]/.test(before);
    else if (pair === 'iu') split = !/[ctsx]/.test(before);
    else if (pair === 'eo') split = true;
    else if (pair === 'ua' || pair === 'uo') split = true;
    else if (pair === 'yi') split = true;
    if (split) {
      out.push([start, i + 1]);
      start = i + 1;
    }
  }
  out.push([start, e]);
  return out;
}

function nuclei(w: string): Array<[number, number]> {
  const mask = vowelMask(w);
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < w.length; ) {
    if (!mask[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < w.length && mask[j]) j++;
    runs.push(...splitRun(w, i, j));
    i = j;
  }
  if (runs.length < 2) return runs;
  const last = runs[runs.length - 1];
  const lone = (ch: string, at: number) => last[0] === at && last[1] === at + 1 && w[at] === ch;
  const n = w.length;
  const cons = (c: string | undefined) => c !== undefined && /[a-z]/.test(c) && !isAeiou(c) && c !== 'y';
  if (lone('e', n - 1) && !(w[n - 2] === 'l' && cons(w[n - 3]))) runs.pop();
  else if (n >= 3 && w.endsWith('es') && lone('e', n - 2)) {
    const pre = w.slice(0, n - 2);
    const sib = /(s|x|z|ch|sh|ce|ge|se)$/.test(pre) || /[cg]$/.test(pre);
    const le = w[n - 3] === 'l' && cons(w[n - 4]);
    if (!sib && !le) runs.pop();
  }
  else if (n >= 3 && w.endsWith('ed') && lone('e', n - 2) && !/[td]/.test(w[n - 3])) runs.pop();
  return runs;
}

function onsetLength(cluster: string, nextIsLe: boolean): number {
  const len = cluster.length;
  if (len === 0) return 0;
  if (nextIsLe) return Math.min(len, 2);
  if (len === 1) return cluster === 'x' ? 0 : 1;
  if (/[qg]u$/.test(cluster)) return 2;
  if (len === 2 && CODA2.has(cluster)) return 0;
  if (len >= 3 && CODA2.has(cluster.slice(0, 2))) return len - 2 >= 2 && ONSET2.has(cluster.slice(2, 4)) ? len - 2 : Math.min(1, len - 2);
  if (len >= 3 && ONSET3.has(cluster.slice(-3))) return 3;
  if (ONSET2.has(cluster.slice(-2))) return 2;
  return 1;
}

export function syllabifyWord(word: string): string[] {
  const raw = String(word ?? '');
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const key = lower.replace(/[^a-z]/g, '');
  const ex = EXCEPTIONS[key];
  if (ex && key.length === lower.length) {
    const out: string[] = [];
    let at = 0;
    for (const piece of ex) {
      out.push(raw.slice(at, at + piece.length));
      at += piece.length;
    }
    return out;
  }
  if (!/[a-z]/.test(lower)) return [raw];
  const nu = nuclei(lower);
  if (nu.length <= 1) return [raw];
  const cuts: number[] = [];
  for (let k = 0; k < nu.length - 1; k++) {
    const end = nu[k][1];
    const nextStart = nu[k + 1][0];
    const cluster = lower.slice(end, nextStart).replace(/'/g, '');
    const nextIsLe = k + 1 === nu.length - 1 && nextStart === lower.length - 1 && lower.endsWith('le');
    const take = onsetLength(cluster, nextIsLe);
    cuts.push(Math.max(end, nextStart - take));
  }
  const out: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    if (c > prev) out.push(raw.slice(prev, c));
    prev = Math.max(prev, c);
  }
  out.push(raw.slice(prev));
  return out.filter((s) => s.length > 0);
}

export function countSyllables(word: string): number {
  return Math.max(1, syllabifyWord(word).length);
}

const LETTER = /[\p{L}\p{N}]/u;

export function parseLyrics(lyrics: string): ParsedLyrics {
  const notes: string[] = [];
  const lines: LyricLine[] = [];
  const all: LyricSyllable[] = [];
  let wordIndex = 0;
  const rawLines = String(lyrics ?? '')
    .replace(/\s+\/\s+/g, '\n')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let strayHold = false;
  for (const rawLine of rawLines) {
    const lineIdx = lines.length;
    const line: LyricLine = { text: '', words: [], syllables: [] };
    const spoken: string[] = [];
    for (const token of rawLine.split(/\s+/)) {
      if (/^_+$/.test(token)) {
        const prev = line.syllables[line.syllables.length - 1] ?? all[all.length - 1];
        if (prev) prev.hold += token.length;
        else strayHold = true;
        continue;
      }
      const core = token.replace(/[^\p{L}\p{N}'_-]/gu, '').replace(/^['-]+|['-]+$/g, '');
      if (!LETTER.test(core)) {
        if (/[_]/.test(core)) {
          const prev = line.syllables[line.syllables.length - 1] ?? all[all.length - 1];
          if (prev) prev.hold += (core.match(/_/g) ?? []).length;
        }
        continue;
      }
      const trailing = (/_+$/.exec(core)?.[0].length ?? 0);
      const body = core.slice(0, core.length - trailing);
      const pieces: Array<{ text: string; hold: number }> = [];
      if (/[-_]/.test(body)) {
        let cur = '';
        let hold = 0;
        const flush = () => {
          if (cur) pieces.push({ text: cur, hold });
          else if (hold && pieces.length) pieces[pieces.length - 1].hold += hold;
          cur = '';
          hold = 0;
        };
        for (const ch of body) {
          if (ch === '-') flush();
          else if (ch === '_') {
            hold++;
            flush();
          } else cur += ch;
        }
        flush();
      } else for (const s of syllabifyWord(body)) pieces.push({ text: s, hold: 0 });
      const real = pieces.filter((p) => LETTER.test(p.text));
      if (!real.length) continue;
      real[real.length - 1].hold += trailing;
      const word = body.replace(/[-_]/g, '');
      const wordInLine = line.words.length;
      line.words.push(word);
      real.forEach((p, i) => {
        const syl: LyricSyllable = { text: p.text.replace(/'/g, '') || p.text, word, wordIndex, wordInLine, line: lineIdx, hold: p.hold, wordStart: i === 0, wordEnd: i === real.length - 1 };
        line.syllables.push(syl);
        all.push(syl);
      });
      wordIndex++;
      spoken.push(token.replace(/[-_]/g, (m, at: number, s: string) => (m === '-' && !(LETTER.test(s[at - 1] ?? '') && LETTER.test(s[at + 1] ?? '')) ? ' ' : '')).trim());
    }
    line.text = spoken.filter(Boolean).join(' ');
    if (line.syllables.length) lines.push(line);
  }
  if (strayHold) notes.push('A "_" at the very start holds nothing (it holds the syllable before it), so it was ignored.');
  return { lines, syllables: all, notes };
}
