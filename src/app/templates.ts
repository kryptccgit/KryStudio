// ──────────────────────────────────────────────────────────────────────
// User project templates in the renderer (Wave 12.2b): the list (Home ▸
// Projects, File ▸ New from template), Save as template…, rename, delete.
// Files live in main (userData/templates, electron/project/templates.ts);
// every action ends in a toast.
// ──────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { cleanTemplateName, findTemplate, type ProjectTemplate } from '@shared/templates';
import type { ActionResult } from '@shared/types';
import { getProject } from '../doc/store';
import { refreshProjectStatus, useProjectStatus } from '../state/status';
import { onProjectPicked } from '../home/store';
import { confirmDiscard } from './actions';
import { modal, report, toast } from './notify';
import { newTab, tabsAvailable } from './tabs/store';

interface TemplatesState {
  list: ProjectTemplate[] | null;
  error: string | null;
}

export const useTemplates = create<TemplatesState>(() => ({ list: null, error: null }));

async function call<T extends ActionResult<unknown>>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, message: `${what}: ${(err as Error)?.message ?? String(err)}` } as T;
  }
}

/** Re-read the template list from main. */
export async function refreshTemplates(): Promise<void> {
  const r = await call(() => window.krypt.project.templates(), 'Templates');
  if (r.ok) useTemplates.setState({ list: r.data ?? [], error: null });
  else useTemplates.setState((s) => ({ list: s.list ?? [], error: r.message ?? 'Couldn’t read the templates' }));
}

let started = false;
/** Load once (menus read the list synchronously). */
export function ensureTemplates(): void {
  if (started) return;
  started = true;
  void refreshTemplates();
}

const nameRule = (v: string): string | null => {
  const c = cleanTemplateName(v);
  return c.ok ? null : c.message;
};

/** File ▸ Save as template…: asks for a name (the project's by default). Same name = replace, after asking. */
export async function saveAsTemplate(): Promise<boolean> {
  const status = useProjectStatus.getState().status;
  const suggested = status?.path ? status.name : getProject()?.meta.name && getProject().meta.name !== 'Untitled' ? getProject().meta.name : 'My template';
  const name = await modal.prompt({
    title: 'Save as template',
    message: 'Keeps this project’s sounds, mixer, patterns and arrangement. Start a new project from it on Home or in File ▸ New from template.',
    initialValue: suggested,
    confirmLabel: 'Save template',
    validate: nameRule,
  });
  if (name === null) return false;
  const clean = cleanTemplateName(name);
  if (!clean.ok) {
    toast.error(clean.message);
    return false;
  }
  const existing = findTemplate(useTemplates.getState().list ?? [], clean.name);
  if (existing && existing.name.toLowerCase() === clean.name.toLowerCase()) {
    const ok = await modal.confirm({ title: `Replace "${existing.name}"?`, message: 'A template with this name exists. Replace it with the open project?', confirmLabel: 'Replace template', destructive: true });
    if (!ok) return false;
  }
  const r = await call(() => window.krypt.project.saveAsTemplate(clean.name), 'Save as template');
  if (!report(r, r.message)) return false;
  await refreshTemplates();
  return true;
}

/** A new, unsaved project from a template, in a new tab (the browser mock replaces the project, asking first). */
export async function newFromTemplate(t: Pick<ProjectTemplate, 'id' | 'name'>): Promise<boolean> {
  if (tabsAvailable()) {
    const ok = await newTab(t);
    if (!ok) void refreshTemplates(); // a template deleted meanwhile drops out of the list
    return ok;
  }
  if (!(await confirmDiscard(`Start a new project from "${t.name}"`))) return false;
  const r = await call(() => window.krypt.project.newFromTemplate(t.id), 'New from template');
  if (!report(r, r.message)) {
    void refreshTemplates();
    return false;
  }
  void refreshProjectStatus();
  onProjectPicked();
  return true;
}

export async function renameTemplate(t: ProjectTemplate): Promise<boolean> {
  const name = await modal.prompt({ title: 'Rename template', initialValue: t.name, confirmLabel: 'Rename', validate: nameRule });
  if (name === null || name.trim() === t.name) return false;
  const r = await call(() => window.krypt.project.renameTemplate(t.id, name), 'Rename template');
  const ok = report(r, r.message);
  await refreshTemplates();
  return ok;
}

export async function deleteTemplate(t: ProjectTemplate): Promise<boolean> {
  const ok = await modal.confirm({ title: `Delete "${t.name}"?`, message: 'Projects you started from it stay as they are. This can’t be undone.', confirmLabel: 'Delete template', destructive: true });
  if (!ok) return false;
  const r = await call(() => window.krypt.project.deleteTemplate(t.id), 'Delete template');
  const done = report(r, r.message);
  await refreshTemplates();
  return done;
}
