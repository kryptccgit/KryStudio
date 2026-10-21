// ──────────────────────────────────────────────────────────────────────
// The Krypt Script sandbox: QuickJS compiled to WebAssembly
// (quickjs-emscripten, MIT; the single-file variant embeds the .wasm so the
// bundled main process needs no extra file). Scripts are untrusted (an AI or
// a downloaded file may have written them), so each run gets:
//   - its own QuickJS runtime + context, created and destroyed per run;
//   - NO host functions at all: no require / import, no process, no fetch,
//     no timers, no Date, no Promise; JSON in, a JSON string out;
//   - a memory limit (32 MB), a stack limit and a CPU deadline (200 ms,
//     QuickJS interrupt handler), so an infinite loop is killed and a huge
//     allocation is refused;
//   - an output cap; the result is then validated strictly in shared/scripts/output.ts.
// WebAssembly memory is isolated from the host: the script can only touch
// the QuickJS heap. Runs in main, synchronously, never in a renderer.
// ──────────────────────────────────────────────────────────────────────

import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import variantImport from '@jitl/quickjs-singlefile-cjs-release-sync';
import { SCRIPT_LIMITS, type ScriptIssue } from '@shared/scripts/types';
import { PRELUDE, PRELUDE_FILE, RUNNER_FILE, SCRIPT_FILE } from './prelude';

export interface SandboxLimits {
  timeMs: number;
  memoryBytes: number;
  stackBytes: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { timeMs: SCRIPT_LIMITS.timeMs, memoryBytes: SCRIPT_LIMITS.memoryBytes, stackBytes: SCRIPT_LIMITS.stackBytes };

export type SandboxErrorKind = 'syntax' | 'runtime' | 'timeout' | 'memory' | 'output' | 'internal';

export type SandboxResult =
  | { ok: true; value: unknown; logs: string[]; ms: number }
  | { ok: false; kind: SandboxErrorKind; message: string; line: number; logs: string[]; ms: number };

// The variant is CommonJS: depending on the bundler the default export may sit under .default.
const variant = ((variantImport as unknown as { default?: unknown }).default ?? variantImport) as typeof variantImport;

let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** Load (once) the QuickJS WebAssembly module. */
export function loadQuickJS(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(variant);
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

/** After an abort inside the WASM module, start from a fresh one next time. */
function dropModule(): void {
  modulePromise = null;
}

const prelude = PRELUDE.replace('__LOG_LINES__', String(SCRIPT_LIMITS.logLines)).replace('__LOG_CHARS__', String(SCRIPT_LIMITS.logChars)).replace('__OUT_CHARS__', String(SCRIPT_LIMITS.outputChars));

interface VmError {
  name?: string;
  message?: string;
  stack?: string;
  lineNumber?: number;
  fileName?: string;
}

/** The 1-based line in the user's script an error points at (0 = unknown). */
function lineOf(err: VmError): number {
  if (err.fileName === SCRIPT_FILE && typeof err.lineNumber === 'number') return err.lineNumber;
  const m = typeof err.stack === 'string' ? err.stack.match(new RegExp(`${SCRIPT_FILE.replace('.', '\\.')}:(\\d+)`)) : null;
  return m ? Number(m[1]) : 0;
}

function classify(err: VmError, phase: 'compile' | 'run'): { kind: SandboxErrorKind; message: string } {
  const name = String(err.name ?? 'Error');
  const msg = String(err.message ?? err ?? 'error').slice(0, 300);
  if (name === 'InternalError' && /interrupted/.test(msg)) return { kind: 'timeout', message: `The script ran longer than ${DEFAULT_LIMITS.timeMs} ms and was stopped (an endless loop?)` };
  if ((name === 'InternalError' || name === 'RangeError') && /out of memory|string too long|invalid array length|array buffer/i.test(msg)) return { kind: 'memory', message: `The script used too much memory and was stopped (${msg})` };
  if (name === 'InternalError' && /stack overflow/.test(msg)) return { kind: 'memory', message: 'Stack overflow: a function calls itself without end' };
  if (name === 'SyntaxError') return { kind: 'syntax', message: `Syntax error: ${msg}` };
  return { kind: phase === 'compile' ? 'runtime' : 'runtime', message: `${name}: ${msg}` };
}

function dumpError(vm: QuickJSContext, h: QuickJSHandle): VmError {
  try {
    const v = vm.dump(h) as unknown;
    if (v && typeof v === 'object') return v as VmError;
    return { name: 'Error', message: String(v) };
  } catch {
    return { name: 'Error', message: 'unknown error' };
  }
}

/**
 * Run `code` in a fresh sandbox: evaluate it, then call its run(ctx) with `input` (JSON-serialisable). Never throws:
 * every failure is a result with a human message and, when known, the line in the script.
 */
export async function runSandboxed(code: string, input: unknown, opts: { limits?: Partial<SandboxLimits>; compileOnly?: boolean } = {}): Promise<SandboxResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const t0 = Date.now();
  const elapsed = (): number => Date.now() - t0;
  let Q: QuickJSWASMModule;
  try {
    Q = await loadQuickJS();
  } catch (e) {
    return { ok: false, kind: 'internal', message: `The script sandbox couldn't start: ${(e as Error)?.message ?? String(e)}`, line: 0, logs: [], ms: elapsed() };
  }
  let json: string;
  try {
    json = JSON.stringify(input ?? null);
  } catch (e) {
    return { ok: false, kind: 'internal', message: `Couldn't pass the notes to the script: ${(e as Error).message}`, line: 0, logs: [], ms: elapsed() };
  }

  let rt: QuickJSRuntime | null = null;
  let vm: QuickJSContext | null = null;
  let result: SandboxResult;
  const start = Date.now();
  try {
    rt = Q.newRuntime();
    rt.setMemoryLimit(limits.memoryBytes);
    rt.setMaxStackSize(limits.stackBytes);
    const deadline = start + limits.timeMs;
    rt.setInterruptHandler(() => Date.now() > deadline);
    // No Date (determinism), no Promise / Proxy (no async, no traps), no typed arrays: a plain language core.
    vm = rt.newContext({ intrinsics: { BaseObjects: true, Eval: true, JSON: true, RegExp: true, MapSet: true, StringNormalize: true } });
    result = evaluate(vm, code, json, opts.compileOnly === true, start);
  } catch (e) {
    // The host's own stack ran out first (deep recursion inside the interpreter): same answer as QuickJS's limit.
    const msg = (e as Error)?.message ?? String(e);
    result = /call stack/i.test(msg)
      ? { ok: false, kind: 'memory', message: 'Stack overflow: a function calls itself without end', line: 0, logs: [], ms: Date.now() - start }
      : { ok: false, kind: 'internal', message: `The script sandbox failed: ${msg}`, line: 0, logs: [], ms: Date.now() - start };
    dropModule();
  }
  try {
    vm?.dispose();
    rt?.dispose();
  } catch {
    // A leaked object after an exception can trip QuickJS's teardown assertion, which aborts the WASM instance:
    // the result stands, the next run gets a fresh module.
    dropModule();
  }
  return result;
}

function evaluate(vm: QuickJSContext, code: string, json: string, compileOnly: boolean, start: number): SandboxResult {
  const fail = (phase: 'compile' | 'run', h: QuickJSHandle): SandboxResult => {
    const err = dumpError(vm, h);
    h.dispose();
    const c = classify(err, phase);
    return { ok: false, kind: c.kind, message: c.message, line: lineOf(err), logs: [], ms: Date.now() - start };
  };
  const p = vm.evalCode(prelude, PRELUDE_FILE);
  if (p.error) return fail('compile', p.error);
  p.value.dispose();

  const s = vm.evalCode(code, SCRIPT_FILE);
  if (s.error) return fail('compile', s.error);
  s.value.dispose();

  const typeH = vm.evalCode('typeof run', RUNNER_FILE);
  if (typeH.error) return fail('compile', typeH.error);
  const type = vm.dump(typeH.value);
  typeH.value.dispose();
  if (type !== 'function') return { ok: false, kind: 'runtime', message: 'The script needs a function run(ctx) { … return notes }', line: 0, logs: [], ms: Date.now() - start };
  if (compileOnly) return { ok: true, value: null, logs: [], ms: Date.now() - start };

  const input = vm.newString(json);
  vm.setProp(vm.global, '__kryptInput', input);
  input.dispose();
  const r = vm.evalCode('__kryptInvoke(__kryptInput)', RUNNER_FILE);
  if (r.error) return fail('run', r.error);
  const out = vm.dump(r.value);
  r.value.dispose();
  if (typeof out !== 'string' || out.length > SCRIPT_LIMITS.outputChars) return { ok: false, kind: 'output', message: 'run() returned too much data', line: 0, logs: [], ms: Date.now() - start };
  let parsed: { notes: unknown; logs: unknown };
  try {
    parsed = JSON.parse(out) as { notes: unknown; logs: unknown };
  } catch {
    return { ok: false, kind: 'output', message: 'run() returned data that is not JSON', line: 0, logs: [], ms: Date.now() - start };
  }
  const logs = Array.isArray(parsed.logs) ? parsed.logs.filter((l): l is string => typeof l === 'string').slice(0, SCRIPT_LIMITS.logLines) : [];
  return { ok: true, value: parsed.notes, logs, ms: Date.now() - start };
}

/** Compile a script (no run): syntax errors and a missing run() with their lines. */
export async function compileCheck(code: string): Promise<ScriptIssue[]> {
  const r = await runSandboxed(code, null, { compileOnly: true });
  return r.ok ? [] : [{ line: r.line, message: r.message }];
}
