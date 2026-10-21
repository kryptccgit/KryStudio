import fs from 'node:fs';

const NOTE_RE = /^([A-Ga-g])(#|b)?(-?\d)$/;
const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const CHORDS = { '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  dim: [0, 3, 6], sus2: [0, 2, 7], sus4: [0, 5, 7], m9: [0, 3, 7, 10, 14], add9: [0, 4, 7, 14]};
const SCALES = { maj: [0, 2, 4, 5, 7, 9, 11], m: [0, 2, 3, 5, 7, 8, 10] };

function midi(tok) {
  const m = NOTE_RE.exec(tok); if (!m) return null;
  return 12 * (Number(m[3]) + 1) + PC[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
function parseOpts(s) { const o = {}; if (!s) return o; for (const kv of s.trim().split(/\s+/)) { const [k, v] = kv.split('='); o[k] = v; } return o; }
function expandRepeats(s) {
  let prev; do { prev = s; s = s.replace(/\(([^()]*)\)\*(\d+)/g, (_, body, n) => Array(Number(n)).fill(body).join(' ')); } while (s !== prev);
  return s;
}
function keyInfo(key) {
  if (!key) return null; const m = /^([A-G])(#|b)?(m?)$/.exec(key); if (!m) throw new Error(`bad key ${key}`);
  return { root: PC[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0), scale: m[3] ? SCALES.m : SCALES.maj };
}

export function parse(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '').trimEnd()).filter(l => l.trim());
  const out = { header: null, tracks: [], errors: [] };
  let H = null;
  for (const line of lines) {
    const hm = /^pattern\s+"([^"]+)"(.*)$/.exec(line.trim());
    if (hm) { H = { name: hm[1], bars: 1, grid: 16, ...parseOpts(hm[2]) }; H.bars = Number(H.bars); H.grid = Number(H.grid); out.header = H; continue; }
    const tm = /^\s*([\w-]+)(?:\/(\d+))?\s*(?:\{([^}]*)\})?\s*:\s*(.*)$/.exec(line);
    if (!tm || !H) { out.errors.push(`unparsed line: ${line}`); continue; }
    const [, name, gridOverride, optStr, rawBody] = tm;
    const opts = parseOpts(optStr); const grid = Number(gridOverride || H.grid);
    const barLen = grid;
    const total = barLen * H.bars;
    const body = expandRepeats(rawBody);
    const notes = []; const errs = [];
    const isGrid = /^[xXo.\-|\s1-9]+$/.test(body);
    if (isGrid) {
      const pitch = opts.pitch ? midi(opts.pitch) : 60; let pos = 0; let bar = 1;
      for (const ch of body) {
        if (ch === ' ') continue;
        if (ch === '|') { if (pos !== bar * barLen) errs.push(`${name}: bar ${bar} has ${pos - (bar - 1) * barLen} steps, expected ${barLen}`); bar = Math.floor(pos / barLen) + 1; continue; }
        if (ch === '-') { if (notes.length) notes[notes.length - 1].len += 1; pos++; continue; }
        if (ch === '.') { pos++; continue; }
        const vel = ch === 'X' ? 127 : ch === 'x' ? Number(opts.vel || 100) : ch === 'o' ? 50 : Math.round(Number(ch) * 14);
        notes.push({ pos, len: 1, pitch, vel }); pos++;
      }
      if (pos !== total) errs.push(`${name}: ${pos} steps total, expected ${total}`);
    } else {
      const k = keyInfo(H.key); let oct = Number(opts.oct || 4); let len = 4; let pos = 0; let bar = 1;
      const toks = body.match(/\[[^\]]*\](?::\d+)?(?:v\d+)?~?|\S+/g) || [];
      for (const t of toks) {
        if (t === '|') { if (pos % barLen !== 0) errs.push(`${name}: bar line at step ${pos} not on a bar boundary (bar ${bar} is ${pos - (bar - 1) * barLen}/${barLen} steps)`); bar = Math.floor(pos / barLen) + 1; continue; }
        const am = /^@(\d+)\.(\d+)$/.exec(t); if (am) { pos = (Number(am[1]) - 1) * barLen + Number(am[2]) - 1; continue; }
        const m = /^(\[[^\]]*\]|[^:v~!?]+)(?::(\d+))?(?:v(\d+))?([!?])?(~)?$/.exec(t);
        if (!m) { errs.push(`${name}: bad token ${t}`); continue; }
        const [, head, l, v, acc, slide] = m; if (l) len = Number(l);
        let vel = v ? Number(v) : Number(opts.vel || 100); if (acc === '!') vel = 120; if (acc === '?') vel = 60;
        let pitches = [];
        if (head === 'r') { pos += len; continue; }
        if (head.startsWith('[')) pitches = head.slice(1, -1).trim().split(/\s+/).map(midi);
        else if (head.startsWith('^')) {
          const dm = /^\^([b#]?)([1-7])(['",]*)$/.exec(head); if (!dm || !k) { errs.push(`${name}: bad degree ${head}`); continue; }
          let p = 12 * (oct + 1) + k.root + k.scale[Number(dm[2]) - 1] + (dm[1] === '#' ? 1 : dm[1] === 'b' ? -1 : 0);
          for (const c of dm[3]) p += c === "'" ? 12 : -12; pitches = [p];
        } else if (midi(head) !== null) pitches = [midi(head)];
        else {
          const cm = /^([A-G](?:#|b)?)(m9|maj7|m7|7|m|dim|sus2|sus4|add9)?(?:\/([A-G](?:#|b)?))?$/.exec(head);
          if (!cm) { errs.push(`${name}: bad token ${t}`); continue; }
          const root = midi(cm[1] + oct); pitches = CHORDS[cm[2] || ''].map(i => root + i);
          if (cm[3]) { let b = midi(cm[3] + (oct - 1)); pitches.unshift(b); }
        }
        if (pitches.some(p => p === null)) { errs.push(`${name}: bad pitch in ${t}`); continue; }
        for (const p of pitches) notes.push({ pos, len, pitch: p, vel, slide: !!slide });
        pos += len;
      }
      if (pos > total) errs.push(`${name}: content is ${pos} steps, pattern is ${total}`);
    }
    out.tracks.push({ name, grid, notes, isGrid });
    out.errors.push(...errs);
  }
  return out;
}

if (process.argv[2]) {
  const text = fs.readFileSync(process.argv[2], 'utf8');
  const r = parse(text);
  const nNotes = r.tracks.reduce((a, t) => a + t.notes.length, 0);
  const json = JSON.stringify(r.tracks.map(t => ({ channel: t.name, notes: t.notes.map(n => ({ pitch: n.pitch, start_beat: +(n.pos * 4 / t.grid).toFixed(4), length_beats: +(n.len * 4 / t.grid).toFixed(4), velocity: n.vel })) })));
  console.log(JSON.stringify({ header: r.header, tracks: r.tracks.map(t => ({ name: t.name, notes: t.notes.length })), errors: r.errors, notes: nNotes, kpnChars: text.length, jsonChars: json.length, ratio: +(json.length / text.length).toFixed(1) }, null, 1));
}
