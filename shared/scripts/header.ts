// The Krypt Script header: `// @…` comment lines (read without running the
// code, so the dialog can show the knobs and an agent gets line-numbered
// errors before anything executes).
//
//   // @name Euclid with probability
//   // @kind generator                      (generator | transform)
//   // @description Even hits; each one plays with a probability.
//   // @param pulses number 5 1..16 step 1 "Pulses"
//   // @param style choice up up|down|upDown "Style"
//   // @param accent toggle on "Accent the one"

import { SCRIPT_KINDS, SCRIPT_LIMITS, type ScriptHeader, type ScriptIssue, type ScriptKind, type ScriptParam, type ScriptParamValues } from './types';

const DIRECTIVE = /^\s*\/\/\s*@([A-Za-z]+)\b\s*(.*)$/;
const PARAM_ID = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

export const HEADER_SYNTAX = [
  '// @name <name>',
  '// @kind generator|transform',
  '// @description <one line>',
  '// @param <id> number <default> <min>..<max> [step <step>] ["Label"]',
  '// @param <id> choice <default> <a>|<b>|<c> ["Label"]',
  '// @param <id> toggle on|off ["Label"]',
].join('\n');

function humanize(id: string): string {
  const s = id.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Split off a trailing "Label" (double or single quotes). */
function takeLabel(rest: string): { body: string; label: string | null } {
  const m = rest.match(/^(.*?)\s*(["'])(.*)\2\s*$/);
  if (!m) return { body: rest.trim(), label: null };
  return { body: m[1].trim(), label: m[3].trim().slice(0, 40) };
}

function num(s: string | undefined): number | null {
  if (s === undefined || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function parseParam(rest: string, line: number, issues: ScriptIssue[]): ScriptParam | null {
  const bad = (msg: string): null => {
    issues.push({ line, message: msg });
    return null;
  };
  const { body, label } = takeLabel(rest);
  const tok = body.split(/\s+/).filter(Boolean);
  const [id, type] = tok;
  if (!id) return bad('@param needs an id and a type, e.g. "// @param density number 0.5 0..1 step 0.05"');
  if (!PARAM_ID.test(id) || RESERVED.has(id)) return bad(`@param id "${id.slice(0, 40)}" must be a plain name (letters, digits, _; up to 32 characters)`);
  const lbl = label || humanize(id);
  if (type === 'number') {
    const def = num(tok[2]);
    const range = (tok[3] ?? '').match(/^([-+]?[\d.eE+-]+)\.\.([-+]?[\d.eE+-]+)$/);
    if (def === null || !range) return bad(`@param ${id} number needs a default and a range: "// @param ${id} number 0.5 0..1 [step 0.05]"`);
    const min = num(range[1]);
    const max = num(range[2]);
    if (min === null || max === null || !(max > min)) return bad(`@param ${id}: the range must be <min>..<max> with max above min`);
    let step = 0;
    if (tok[4] !== undefined) {
      const st = tok[4] === 'step' ? num(tok[5]) : null;
      if (st === null || !(st > 0) || st > max - min) return bad(`@param ${id}: write the step as "step <size>" (a positive number no bigger than the range)`);
      step = st;
      if (tok.length > 6) return bad(`@param ${id}: unexpected "${tok.slice(6).join(' ').slice(0, 40)}" (put the label in quotes)`);
    } else if (tok.length > 4) return bad(`@param ${id}: unexpected "${tok.slice(4).join(' ').slice(0, 40)}"`);
    if (!step) step = Number.isInteger(min) && Number.isInteger(max) && Number.isInteger(def) && max - min >= 2 ? 1 : (max - min) / 100;
    if (def < min || def > max) return bad(`@param ${id}: the default ${def} is outside ${min}..${max}`);
    return { id, type: 'number', label: lbl, default: def, min, max, step };
  }
  if (type === 'choice') {
    const def = tok[2];
    const options = (tok[3] ?? '').split('|').map((o) => o.trim()).filter(Boolean);
    if (!def || options.length < 2) return bad(`@param ${id} choice needs a default and 2 or more options: "// @param ${id} choice up up|down|random"`);
    if (tok.length > 4) return bad(`@param ${id}: unexpected "${tok.slice(4).join(' ').slice(0, 40)}" (options are separated by | with no spaces; put the label in quotes)`);
    if (options.length > SCRIPT_LIMITS.choiceOptions) return bad(`@param ${id}: at most ${SCRIPT_LIMITS.choiceOptions} options`);
    if (new Set(options).size !== options.length) return bad(`@param ${id}: an option is listed twice`);
    if (options.some((o) => o.length > 32)) return bad(`@param ${id}: options can be at most 32 characters`);
    if (!options.includes(def)) return bad(`@param ${id}: the default "${def.slice(0, 32)}" is not one of ${options.join('|')}`);
    return { id, type: 'choice', label: lbl, default: def, options };
  }
  if (type === 'toggle') {
    const v = (tok[2] ?? '').toLowerCase();
    const on = v === 'on' || v === 'true' || v === 'yes';
    const off = v === 'off' || v === 'false' || v === 'no';
    if (!on && !off) return bad(`@param ${id} toggle needs a default: "// @param ${id} toggle on" (or off)`);
    if (tok.length > 3) return bad(`@param ${id}: unexpected "${tok.slice(3).join(' ').slice(0, 40)}"`);
    return { id, type: 'toggle', label: lbl, default: on };
  }
  return bad(`@param ${id}: the type must be number, choice or toggle (got "${(type ?? '').slice(0, 20)}")`);
}

export type HeaderResult = { ok: true; header: ScriptHeader; issues: [] } | { ok: false; header: null; issues: ScriptIssue[] };

/** Parse a script's header. Pure; never runs the code. */
export function parseScriptHeader(code: string): HeaderResult {
  const issues: ScriptIssue[] = [];
  if (typeof code !== 'string' || !code.trim()) return { ok: false, header: null, issues: [{ line: 0, message: 'The script is empty' }] };
  if (code.length > SCRIPT_LIMITS.codeChars) return { ok: false, header: null, issues: [{ line: 0, message: `The script is too long (${code.length} characters; the limit is ${SCRIPT_LIMITS.codeChars})` }] };
  let name: string | null = null;
  let kind: ScriptKind | null = null;
  let description = '';
  const params: ScriptParam[] = [];
  const lines = code.split(/\r?\n/);
  lines.forEach((text, i) => {
    const m = text.match(DIRECTIVE);
    if (!m) return;
    const line = i + 1;
    const dir = m[1].toLowerCase();
    const rest = m[2].trim();
    switch (dir) {
      case 'name':
        if (name !== null) issues.push({ line, message: '@name is given twice' });
        else if (!rest) issues.push({ line, message: '@name needs a name' });
        else name = rest.slice(0, SCRIPT_LIMITS.nameChars);
        break;
      case 'kind':
        if (kind !== null) issues.push({ line, message: '@kind is given twice' });
        else if (!(SCRIPT_KINDS as readonly string[]).includes(rest)) issues.push({ line, message: `@kind must be generator (writes notes into the bars) or transform (changes the selected notes), not "${rest.slice(0, 20)}"` });
        else kind = rest as ScriptKind;
        break;
      case 'description':
        description = (description ? `${description} ` : '') + rest;
        break;
      case 'param': {
        const p = parseParam(rest, line, issues);
        if (!p) break;
        if (params.some((x) => x.id === p.id)) issues.push({ line, message: `@param ${p.id} is declared twice` });
        else if (params.length >= SCRIPT_LIMITS.params) issues.push({ line, message: `At most ${SCRIPT_LIMITS.params} params` });
        else params.push(p);
        break;
      }
      default:
        issues.push({ line, message: `Unknown header line @${m[1].slice(0, 20)} (use @name, @kind, @description or @param)` });
    }
  });
  if (name === null) issues.push({ line: 1, message: 'The header needs a name: "// @name My device"' });
  if (kind === null) issues.push({ line: 1, message: 'The header needs a kind: "// @kind generator" or "// @kind transform"' });
  if (!/\bfunction\s+run\s*\(|\b(?:const|let|var)\s+run\s*=/.test(code)) issues.push({ line: 0, message: 'The script needs a function run(ctx) { … return notes }' });
  if (issues.length) return { ok: false, header: null, issues: issues.sort((a, b) => a.line - b.line) };
  return { ok: true, header: { name: name!, kind: kind!, description: description.slice(0, SCRIPT_LIMITS.descriptionChars), params }, issues: [] };
}

/** The params' defaults. */
export function defaultParams(h: ScriptHeader): ScriptParamValues {
  const out: ScriptParamValues = {};
  for (const p of h.params) out[p.id] = p.default;
  return out;
}

const snapStep = (v: number, p: { min: number; step: number }): number => {
  const s = Math.round((v - p.min) / p.step) * p.step + p.min;
  return Math.round(s * 1e6) / 1e6;
};

/**
 * The values a run gets: defaults, overridden by `raw`. Numbers are clamped to the range; choices must be an option
 * and toggles a boolean. strict = unknown names and wrong types are errors (agents); otherwise they fall back to the
 * default (the dialog after the script changed).
 */
export function resolveParams(h: ScriptHeader, raw: Record<string, unknown> | undefined, strict: boolean): { ok: true; params: ScriptParamValues } | { ok: false; message: string } {
  const out = defaultParams(h);
  const src = raw ?? {};
  for (const [k, v] of Object.entries(src)) {
    const p = h.params.find((x) => x.id === k);
    if (!p) {
      if (strict) return { ok: false, message: `"${h.name}" has no param "${k.slice(0, 32)}"${h.params.length ? ` (it has: ${h.params.map((x) => x.id).join(', ')})` : ' (it has no params)'}` };
      continue;
    }
    if (p.type === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
      if (!Number.isFinite(n)) {
        if (strict) return { ok: false, message: `Param ${k} must be a number from ${p.min} to ${p.max}` };
        continue;
      }
      out[k] = Math.min(p.max, Math.max(p.min, snapStep(n, p)));
    } else if (p.type === 'choice') {
      if (typeof v !== 'string' || !p.options.includes(v)) {
        if (strict) return { ok: false, message: `Param ${k} must be one of ${p.options.join(', ')}` };
        continue;
      }
      out[k] = v;
    } else {
      const b = typeof v === 'boolean' ? v : v === 'on' || v === 'true' ? true : v === 'off' || v === 'false' ? false : null;
      if (b === null) {
        if (strict) return { ok: false, message: `Param ${k} must be true or false` };
        continue;
      }
      out[k] = b;
    }
  }
  return { ok: true, params: out };
}

/** One line per param for agents: "pulses number 1..16 (default 5)". */
export function describeParams(h: ScriptHeader): string {
  if (!h.params.length) return 'no params';
  return h.params
    .map((p) => (p.type === 'number' ? `${p.id} ${p.min}..${p.max} (default ${p.default})` : p.type === 'choice' ? `${p.id} ${p.options.join('|')} (default ${p.default})` : `${p.id} on|off (default ${p.default ? 'on' : 'off'})`))
    .join('; ');
}
