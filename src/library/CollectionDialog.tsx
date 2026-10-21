// New / edit collection: a name and comma-separated tags ("dark, trap, 140").

import { useState } from 'react';
import { FolderPlus, Tags } from 'lucide-react';
import { DialogForm, Field } from '../components/Dialog';
import { openDialog } from '../components/Dialog';
import { parseTags } from './logic';

interface Spec {
  doc?: Document | null;
  title: string;
  submitLabel: string;
  initial: { name: string; tags: string[] };
  /** Resolve true to close the dialog. */
  onSubmit: (name: string, tags: string[]) => Promise<boolean>;
  onCancel?: () => void;
}

export function openCollectionDialog(spec: Spec): void {
  let submitted = false;
  openDialog({
    key: 'library-collection',
    title: spec.title,
    subtitle: 'A collection groups songs whose style belongs together, like “Dark trap” or “90s R&B”.',
    icon: spec.initial.name ? Tags : FolderPlus,
    doc: spec.doc,
    width: 440,
    onClose: () => {
      if (!submitted) spec.onCancel?.();
    },
    render: (close) => (
      <CollectionForm
        spec={spec}
        onDone={() => {
          submitted = true;
          close();
        }}
        onCancel={close}
      />
    ),
  });
}

function CollectionForm({ spec, onDone, onCancel }: { spec: Spec; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(spec.initial.name);
  const [tags, setTags] = useState(spec.initial.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const error = !trimmed ? 'Give it a name' : trimmed.length > 64 ? 'At most 64 characters' : null;
  const parsed = parseTags(tags);
  const submit = async (): Promise<void> => {
    if (error || busy) return;
    setBusy(true);
    const ok = await spec.onSubmit(trimmed, parsed);
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <DialogForm onSubmit={() => void submit()} onCancel={onCancel} submitLabel={spec.submitLabel} submitDisabled={!!error} busy={busy} extra={error ?? 'Files are never moved or copied.'}>
      <Field label="Name" wide>
        <input
          data-autofocus
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dark trap"
          className="h-8 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 text-[12px] text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
        />
      </Field>
      <Field label="Tags" hint="Comma-separated. Agents see them next to the profile." wide>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="dark, trap, 140"
          className="h-8 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 text-[12px] text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
        />
        {parsed.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {parsed.map((t) => (
              <span key={t} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-px text-[10px] text-white/80">
                {t}
              </span>
            ))}
          </div>
        )}
      </Field>
    </DialogForm>
  );
}
