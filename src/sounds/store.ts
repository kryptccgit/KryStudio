// ──────────────────────────────────────────────────────────────────────
// Renderer state for presets and the factory sound library:
//   - the SoundsState from window.krypt.sounds (live via onState), with the
//     factory presets from shared data as a fallback when main can't answer;
//   - the factory sample index (sounds.factorySamples());
//   - full presets fetched by id (user presets) for the "modified" dot;
//   - the preset browser's "With effects" choice (localStorage convenience);
//   - "show the Presets in the Browser" requests from Home / toasts.
// ──────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';
import { create } from 'zustand';
import type { ActionResult, SoundsState } from '@shared/types';
import type { FactorySample, Preset, PresetSummary } from '@shared/sounds/types';
import { summarizePreset } from '@shared/sounds/types';
import { FACTORY_PRESETS, factoryPreset } from '@shared/sounds/factory';

interface SoundsStore {
  state: SoundsState | null;
  /** Why state() failed (the factory fallback is shown meanwhile). */
  error: string | null;
  samples: FactorySample[] | null;
  samplesError: string | null;
  /** Full presets by id (user presets fetched with sounds.get). Cleared when the preset list changes. */
  cache: Record<string, Preset>;
  /** Preset browser: also load the preset's insert effects. */
  withFx: boolean;
  /** Bumped to ask the Browser to open + scroll to a section. */
  reveal: { section: 'presets' | 'sounds'; nonce: number } | null;
}

const WITH_FX_KEY = 'krypt.studio.presets.withFx.v1';

function readWithFx(): boolean {
  try {
    return localStorage.getItem(WITH_FX_KEY) !== '0';
  } catch {
    return true;
  }
}

export const useSounds = create<SoundsStore>(() => ({
  state: null,
  error: null,
  samples: null,
  samplesError: null,
  cache: {},
  withFx: readWithFx(),
  reveal: null,
}));

export function setWithFx(withFx: boolean): void {
  useSounds.setState({ withFx });
  try {
    localStorage.setItem(WITH_FX_KEY, withFx ? '1' : '0');
  } catch {
    /* best effort */
  }
}

const FACTORY_SUMMARIES: PresetSummary[] = FACTORY_PRESETS.map(summarizePreset);

/** Every preset summary we know: main's list, or the bundled factory presets until it answers. */
export function presetList(state: SoundsState | null = useSounds.getState().state): readonly PresetSummary[] {
  return state?.presets ?? FACTORY_SUMMARIES;
}

let started = false;

export async function refreshSounds(): Promise<void> {
  try {
    const s = await window.krypt.sounds.state();
    useSounds.setState({ state: s, error: null, cache: {} });
  } catch (err) {
    useSounds.setState({ error: (err as Error)?.message ?? String(err) });
  }
}

export async function loadFactorySamples(): Promise<void> {
  try {
    const samples = await window.krypt.sounds.factorySamples();
    useSounds.setState({ samples: Array.isArray(samples) ? samples : [], samplesError: null });
  } catch (err) {
    useSounds.setState({ samples: [], samplesError: (err as Error)?.message ?? String(err) });
  }
}

/** Start loading + following the sounds state (idempotent). */
export function ensureSounds(): void {
  if (started) return;
  started = true;
  try {
    window.krypt.sounds.onState((s) => useSounds.setState({ state: s, error: null, cache: {} }));
  } catch (err) {
    useSounds.setState({ error: (err as Error)?.message ?? String(err) });
  }
  void refreshSounds();
  void loadFactorySamples();
}

/** Components that show presets or factory samples call this once. */
export function useEnsureSounds(): void {
  useEffect(() => ensureSounds(), []);
}

/** The full preset for an id: factory data straight from the bundle, user presets from main (cached). */
export async function fetchPreset(id: string): Promise<ActionResult<Preset>> {
  const cached = useSounds.getState().cache[id] ?? (id.startsWith('factory:') ? factoryPreset(id) : undefined);
  if (cached) return { ok: true, data: cached };
  try {
    const r = await window.krypt.sounds.get(id);
    if (r.ok && r.data) {
      const p = r.data;
      useSounds.setState((s) => ({ cache: { ...s.cache, [id]: p } }));
      return { ok: true, data: p };
    }
    return { ok: false, message: r.message || `The preset ${id} wasn't found` };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? String(err) };
  }
}

/** The full preset for the preset bar's "modified" dot (null while loading or when unknown; never toasts). */
export function usePresetObject(id: string | null | undefined): Preset | null {
  const cached = useSounds((s) => (id ? s.cache[id] : undefined));
  const factory = id && id.startsWith('factory:') ? factoryPreset(id) : undefined;
  useEffect(() => {
    if (!id || factory || cached) return;
    void fetchPreset(id);
  }, [id, factory, cached]);
  return factory ?? cached ?? null;
}

/** Ask the Browser to open a section and scroll to it. */
export function requestBrowserReveal(section: 'presets' | 'sounds'): void {
  useSounds.setState({ reveal: { section, nonce: Date.now() } });
}
