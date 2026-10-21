// Analyzer state in the renderer: the Model Manager snapshot from main
// (models, jobs, devices) and the actions behind the Model Manager buttons.
// Every action ends in visible feedback; cancelled downloads are reported by
// the Cancel click, not again when the install promise settles.

import { create } from 'zustand';
import type { ActionResult, AnalyzerState } from '@shared/types';
import type { ModelDef } from '@shared/analyzer/models';
import { modal, report, toast } from '../../app/notify';
import { isCancelMessage, modelBytes } from '../../ears/logic';
import { fmtBytes } from '../../utils/format';
import { openLicenceConfirm } from './LicenceConfirm';

interface AnalyzerStore {
  state: AnalyzerState | null;
  /** Model id → action in flight (Install / Import / Remove), for button spinners. */
  busy: Record<string, string>;
}

export const useAnalyzer = create<AnalyzerStore>(() => ({ state: null, busy: {} }));

export function getAnalyzerState(): AnalyzerState | null {
  return useAnalyzer.getState().state;
}

function apply(s: AnalyzerState | null | undefined): void {
  if (!s || !Array.isArray(s.models)) return;
  useAnalyzer.setState({ state: s });
}

function setBusy(id: string, label: string | null): void {
  useAnalyzer.setState((st) => {
    const busy = { ...st.busy };
    if (label) busy[id] = label;
    else delete busy[id];
    return { busy };
  });
}

let installed = false;

/** Boot: fetch the analyzer snapshot and follow every change from main. */
export function installAnalyzerSync(): void {
  if (installed) return;
  installed = true;
  const api = window.krypt?.analyzer;
  if (!api) return;
  void refreshAnalyzer();
  api.onState(apply);
}

export async function refreshAnalyzer(): Promise<void> {
  try {
    apply(await window.krypt.analyzer.state());
  } catch {
    /* main not ready yet: onState will deliver it */
  }
}

/** The analyzer is missing: say so (plus how to fix it in development). */
export function analyzerMissingMessage(): string {
  return "The analyzer (krypt-studio-analyzer.exe) wasn't found, so audio analysis can't run. Reinstall Krypt Studio; in development run “npm run engine:build:debug”.";
}

async function call<T>(label: string, fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, message: `${label} failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

/** Install: licence + notice confirm first, then download + verify. */
export async function installModel(def: ModelDef, doc?: Document | null): Promise<boolean> {
  if (!(await openLicenceConfirm(def, 'download', doc))) return false;
  setBusy(def.id, 'Installing');
  toast.info(`Downloading ${def.name}${modelBytes(def) ? ` (${fmtBytes(modelBytes(def))})` : ''}. Progress shows in the status bar.`);
  const r = await call('Install', () => window.krypt.analyzer.installModel(def.id));
  setBusy(def.id, null);
  if (r.data) apply(r.data);
  if (!r.ok && isCancelMessage(r.message)) return false; // the Cancel click already said so
  return report(r, `${def.name} installed`);
}

export async function cancelInstall(def: Pick<ModelDef, 'id' | 'name'>): Promise<void> {
  const r = await call('Cancel', () => window.krypt.analyzer.cancelInstall(def.id));
  if (report(r)) toast.info(`Download of ${def.name} cancelled`);
}

/** Install from a folder the user picks (offline installs, no published download). */
export async function importModel(def: ModelDef, doc?: Document | null): Promise<boolean> {
  if (!(await openLicenceConfirm(def, 'folder', doc))) return false;
  setBusy(def.id, 'Importing');
  const r = await call('Install from folder', () => window.krypt.analyzer.importModel(def.id));
  setBusy(def.id, null);
  if (r.data) apply(r.data);
  if (!r.ok && isCancelMessage(r.message)) return false; // folder picker dismissed
  return report(r, r.message || `${def.name} installed from folder`);
}

export async function removeModel(def: ModelDef): Promise<boolean> {
  if (def.bundled) {
    toast.warn(`${def.name} ships with Krypt Studio and can't be removed`);
    return false;
  }
  const size = modelBytes(def);
  const ok = await modal.confirm({
    title: `Remove ${def.name}?`,
    message: `Deletes its files${size ? ` (${fmtBytes(size)})` : ''} from the models folder. Stems and patterns you already made stay in your projects. You can install it again later.`,
    confirmLabel: 'Remove model',
    destructive: true,
  });
  if (!ok) return false;
  setBusy(def.id, 'Removing');
  const r = await call('Remove', () => window.krypt.analyzer.removeModel(def.id));
  setBusy(def.id, null);
  if (r.data) apply(r.data);
  return report(r, `${def.name} removed`);
}

export async function showModelsFolder(path: string): Promise<void> {
  const r = await call('Open folder', () => window.krypt.app.showItemInFolder(path));
  report(r);
}

export async function openLicence(url: string): Promise<void> {
  const r = await call('Open link', () => window.krypt.app.openExternal(url));
  report(r);
}
