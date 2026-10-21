import { useEffect } from 'react';
import { create } from 'zustand';
import type { ActionResult, SoundsState } from '@shared/types';
import type { FactorySample, Preset, PresetSummary } from '@shared/sounds/types';
import { summarizePreset } from '@shared/sounds/types';
import { FACTORY_PRESETS, factoryPreset } from '@shared/sounds/factory';

interface SoundsStore {
  state: SoundsState | null;
  error: string | null;
  samples: FactorySample[] | null;
  samplesError: string | null;
  cache: Record<string, Preset>;
  withFx: boolean;
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
  }
}

const FACTORY_SUMMARIES: PresetSummary[] = FACTORY_PRESETS.map(summarizePreset);

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

export function useEnsureSounds(): void {
  useEffect(() => ensureSounds(), []);
}

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

export function usePresetObject(id: string | null | undefined): Preset | null {
  const cached = useSounds((s) => (id ? s.cache[id] : undefined));
  const factory = id && id.startsWith('factory:') ? factoryPreset(id) : undefined;
  useEffect(() => {
    if (!id || factory || cached) return;
    void fetchPreset(id);
  }, [id, factory, cached]);
  return factory ?? cached ?? null;
}

export function requestBrowserReveal(section: 'presets' | 'sounds'): void {
  useSounds.setState({ reveal: { section, nonce: Date.now() } });
}
