import { useEffect, useState } from 'react';
import { LayoutTemplate, Pencil, Plus, Trash2 } from 'lucide-react';
import { describeTemplate } from '@shared/templates';
import { deleteTemplate, newFromTemplate, refreshTemplates, renameTemplate, saveAsTemplate, useTemplates } from '../../app/templates';
import { fmtAgo } from '../logic';
import { Eyebrow, GlassPanel, HomeButton } from '../ui';

export function TemplatesPanel() {
  const list = useTemplates((s) => s.list);
  const error = useTemplates((s) => s.error);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void refreshTemplates();
  }, []);
  const now = Date.now();
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <GlassPanel className="mt-6 p-5" label="Your templates">
      <div data-guide="home.templates" className="flex flex-wrap items-center gap-2">
        <Eyebrow>Your templates</Eyebrow>
        <HomeButton kind="quiet" icon={Plus} className="ml-auto" onClick={() => void run('save', saveAsTemplate)} busy={busy === 'save'} title="Save the open project as a template">
          Save the open project as a template
        </HomeButton>
      </div>
      {error && <p className="mt-2 text-[12px] text-amber-300">{error}</p>}
      {!list || list.length === 0 ? (
        <p className="mt-3 text-[13px] text-krypt-muted">
          {list === null ? 'Loading…' : 'None yet. Set up a project the way you like to start (sounds, mixer, tempo), then File ▸ Save as template… and it shows up here.'}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-white/[0.06]">
          {list.map((t) => {
            const at = Date.parse(t.updatedAt);
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <LayoutTemplate className="h-4 w-4 flex-shrink-0 text-krypt-purple" aria-hidden />
                <div className="min-w-0 flex-1 basis-56">
                  <div className="truncate text-[13.5px] font-semibold text-white">{t.name}</div>
                  <div className="truncate text-[11px] text-krypt-muted">{describeTemplate(t)}</div>
                </div>
                <span className="w-28 flex-shrink-0 text-right text-[11px] text-krypt-muted">{Number.isFinite(at) ? `Saved ${fmtAgo(at, now)}` : ''}</span>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <HomeButton kind="quiet" icon={Pencil} onClick={() => void run(`rename:${t.id}`, () => renameTemplate(t))} ariaLabel={`Rename ${t.name}`} title="Rename">
                    <span className="sr-only">Rename</span>
                  </HomeButton>
                  <HomeButton kind="quiet" icon={Trash2} onClick={() => void run(`delete:${t.id}`, () => deleteTemplate(t))} ariaLabel={`Delete ${t.name}`} title="Delete">
                    <span className="sr-only">Delete</span>
                  </HomeButton>
                  <HomeButton kind="ghost" onClick={() => void run(`new:${t.id}`, () => newFromTemplate(t))} busy={busy === `new:${t.id}`} ariaLabel={`New project from ${t.name}`}>
                    New project
                  </HomeButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </GlassPanel>
  );
}
