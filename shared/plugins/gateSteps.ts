// ──────────────────────────────────────────────────────────────────────
// Krypt Gate/Time custom steps (krypt.gate pattern "Custom steps"). The
// engine (engine/crates/dsp/src/effects/gate.rs) reads them from plain
// params: stepDiv, stepCount, s1..s16 (time mode) and g1..g16 (level).
// This module is the one place that knows the mapping, plus a compact
// text form for agents and the factory step presets. Pure: no I/O.
//
// Step text:  [division] step step step …      (1 to 16 steps)
//   division  1/32 | 1/16 | 1/8 | 1/4 (optional; default 1/16)
//   step      CODE or CODE:LEVEL (LEVEL 0..100 %, default 100)
//   CODE      P play · R2 R3 R4 roll ×2/×3/×4 · RP repeat the previous step
//             H half speed · V reverse · S tape stop · U tape start (spin up)
//             . a muted step (same as P:0)
//   `|` may separate beats or bars for readability; it is ignored.
//   Consecutive steps with the same code form one run: half speed,
//   reverse, repeat and the tape curves span the whole run.
//   e.g. "1/16 P P P P | P P . P | R2 R2 R4 R4 | V V S S"
// ──────────────────────────────────────────────────────────────────────

/** Index of "Custom steps" in the krypt.gate `pattern` options. */
export const GATE_CUSTOM_PATTERN = 10;
export const GATE_MAX_STEPS = 16;
/** Mirrors STEP_MODES in gate.rs (the `s1`..`s16` options). */
export const GATE_STEP_MODES = ['Play', 'Roll x2', 'Roll x3', 'Roll x4', 'Repeat prev', 'Half speed', 'Reverse', 'Tape stop', 'Tape start'] as const;
export const GATE_STEP_CODES = ['P', 'R2', 'R3', 'R4', 'RP', 'H', 'V', 'S', 'U'] as const;
/** The `stepDiv` options. */
export const GATE_STEP_DIVS = ['1/32', '1/16', '1/8', '1/4'] as const;
const DEFAULT_DIV = 1;
/** Every custom-step param id (drawn by the step editor, not as knobs). */
export const GATE_STEP_PARAM_IDS: readonly string[] = ['stepDiv', 'stepCount', ...Array.from({ length: GATE_MAX_STEPS }, (_, i) => `s${i + 1}`), ...Array.from({ length: GATE_MAX_STEPS }, (_, i) => `g${i + 1}`)];

export interface GateStep {
  /** GATE_STEP_MODES index. */
  mode: number;
  /** 0..1 */
  level: number;
}

export interface GateSteps {
  /** GATE_STEP_DIVS index. */
  div: number;
  /** 1..16 steps. */
  steps: GateStep[];
}

export type GateStepsResult = { ok: true; value: GateSteps } | { ok: false; message: string };

/** Parse step text (syntax above). Never throws; the message names the bad token. */
export function parseGateSteps(text: string): GateStepsResult {
  const tokens = text.split(/[\s,|]+/).filter(Boolean);
  let div = DEFAULT_DIV;
  if (tokens.length && tokens[0].includes('/')) {
    const d = GATE_STEP_DIVS.indexOf(tokens[0] as (typeof GATE_STEP_DIVS)[number]);
    if (d < 0) return { ok: false, message: `Unknown step length "${tokens[0]}": use ${GATE_STEP_DIVS.join(', ')}` };
    div = d;
    tokens.shift();
  }
  if (!tokens.length) return { ok: false, message: 'No steps: write 1 to 16 steps like "P P R2 R2 V V S S"' };
  if (tokens.length > GATE_MAX_STEPS) return { ok: false, message: `${tokens.length} steps is too many: Gate/Time holds at most ${GATE_MAX_STEPS}` };
  const steps: GateStep[] = [];
  for (const [i, tok] of tokens.entries()) {
    if (tok === '.') {
      steps.push({ mode: 0, level: 0 });
      continue;
    }
    const m = /^([a-z]+\d?)(?::(\d+(?:\.\d+)?))?$/i.exec(tok);
    const mode = m ? GATE_STEP_CODES.indexOf(m[1].toUpperCase() as (typeof GATE_STEP_CODES)[number]) : -1;
    if (!m || mode < 0) return { ok: false, message: `Step ${i + 1} "${tok}" isn't a step: use ${GATE_STEP_CODES.join(' ')} or . (muted), optionally with :level, e.g. R4:80` };
    const level = m[2] === undefined ? 100 : Number(m[2]);
    if (!(level >= 0 && level <= 100)) return { ok: false, message: `Step ${i + 1} "${tok}": the level must be 0 to 100` };
    steps.push({ mode, level: level / 100 });
  }
  return { ok: true, value: { div, steps } };
}

/** Step text in the canonical form, e.g. "1/16 P P R2 R2:50 . V". */
export function printGateSteps(s: GateSteps): string {
  const step = ({ mode, level }: GateStep): string => {
    if (mode === 0 && level === 0) return '.';
    const code = GATE_STEP_CODES[mode] ?? 'P';
    const pct = Math.round(level * 100);
    return pct >= 100 ? code : `${code}:${pct}`;
  };
  return [GATE_STEP_DIVS[s.div] ?? GATE_STEP_DIVS[DEFAULT_DIV], ...s.steps.map(step)].join(' ');
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);
const clamp01 = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : dflt);

/** The steps stored in a krypt.gate slot's (sparse) params; missing keys use the catalog defaults. */
export function readGateSteps(params: Readonly<Record<string, number>>): GateSteps {
  const count = clampInt(params.stepCount, 1, GATE_MAX_STEPS, GATE_MAX_STEPS);
  return {
    div: clampInt(params.stepDiv, 0, GATE_STEP_DIVS.length - 1, DEFAULT_DIV),
    steps: Array.from({ length: count }, (_, i) => ({ mode: clampInt(params[`s${i + 1}`], 0, GATE_STEP_MODES.length - 1, 0), level: clamp01(params[`g${i + 1}`], 1) })),
  };
}

/**
 * Params for mixer.setSlotParams: switches the slot to Custom steps and writes ALL 16 steps (those past the
 * count back to Play at full level), so nothing stale survives a preset.
 */
export function gateStepParams(s: GateSteps): Record<string, number> {
  const out: Record<string, number> = { pattern: GATE_CUSTOM_PATTERN, stepDiv: s.div, stepCount: Math.min(GATE_MAX_STEPS, Math.max(1, s.steps.length)) };
  for (let i = 0; i < GATE_MAX_STEPS; i++) {
    const st = s.steps[i];
    out[`s${i + 1}`] = st ? st.mode : 0;
    out[`g${i + 1}`] = st ? st.level : 1;
  }
  return out;
}

export interface GateStepPreset {
  id: string;
  name: string;
  description: string;
  text: string;
}

/** Factory step patterns (original names). */
export const GATE_STEP_PRESETS: readonly GateStepPreset[] = [
  { id: 'build-roll', name: 'Build roll', description: 'Straight for two beats, then 1/32 and 1/64 rolls into the drop', text: '1/16 P P P P P P P P R2 R2 R2 R2 R4 R4 R4 R4' },
  { id: 'half-time-tail', name: 'Half-time tail', description: 'The bar plays normally, then the back half drops to half speed', text: '1/16 P P P P P P P P H H H H H H H H' },
  { id: 'reverse-fill', name: 'Reverse fill', description: 'Three beats as played, the last beat runs backwards', text: '1/16 P P P P P P P P P P P P V V V V' },
  { id: 'tape-stop-end', name: 'Tape stop end', description: 'The last beat of the bar winds down like a stopped tape', text: '1/16 P P P P P P P P P P P P S S S S' },
  { id: 'spin-up', name: 'Spin-up start', description: 'The first beat speeds up from a standstill', text: '1/16 U U U U P P P P P P P P P P P P' },
  { id: 'offbeat-chop', name: 'Offbeat chop', description: 'Mutes every other 1/16 for a choppy, pumping gate', text: '1/16 P . P . P . P . P . P . P . P .' },
  { id: 'triplet-roll', name: 'Triplet roll', description: 'Three beats straight, then triplet rolls on the last beat', text: '1/16 P P P P P P P P P P P P R3 R3 R3 R3' },
  { id: 'echo-repeats', name: 'Echo repeats', description: 'Two-bar 1/8 pattern: each half bar is answered by a repeat of its last step', text: '1/8 P P P RP P P P RP P P P RP P P R4 R4' },
  { id: 'glitch-mix', name: 'Glitch mix', description: 'A busy bar of rolls, reverses, repeats and a tape stop', text: '1/16 P R4 P V P P RP . P R2 P V H H S S' },
];

export function findGateStepPreset(ref: string): GateStepPreset | undefined {
  const n = ref.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return GATE_STEP_PRESETS.find((p) => p.id.replace(/-/g, '') === n || p.name.toLowerCase().replace(/[\s_-]+/g, '') === n);
}

/** Preset params (parse cannot fail for the factory text; the test checks it). */
export function gateStepPresetParams(p: GateStepPreset): Record<string, number> {
  const r = parseGateSteps(p.text);
  if (!r.ok) throw new Error(`Bad factory step preset ${p.id}: ${r.message}`);
  return gateStepParams(r.value);
}
