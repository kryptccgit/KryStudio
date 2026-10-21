import { useId, useState } from 'react';
import { FileText } from 'lucide-react';
import { dispatch, getProject } from '../doc/store';
import { openDialog, DialogForm, Field } from '../components/Dialog';
import { flashHint } from './hints';

export const GENRES = [
  'Trap',
  'Hip-hop',
  'Boom bap',
  'Drill',
  'Lo-fi',
  'R&B',
  'Pop',
  'House',
  'Tech house',
  'Techno',
  'Drum & bass',
  'Dubstep',
  'Future bass',
  'Synthwave',
  'Ambient',
  'Afrobeats',
  'Reggaeton',
  'Phonk',
  'Hyperpop',
  'Cinematic',
];

const input =
  'h-8 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 text-[12px] text-white placeholder-krypt-muted/50 outline-none transition focus:border-krypt-purple/60';

function ProjectInfoForm({ close }: { close: () => void }) {
  const p = getProject();
  const meta = p.meta;
  const listId = useId();
  const [name, setName] = useState(meta.name);
  const [author, setAuthor] = useState(meta.author);
  const [genre, setGenre] = useState(meta.genre);
  const [notes, setNotes] = useState(meta.notes);
  const [busy, setBusy] = useState(false);
  const nameErr = !name.trim() ? 'The project needs a name' : name.length > 128 ? 'At most 128 characters' : null;

  const created = (() => {
    const d = new Date(meta.createdAt);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  })();
  const stats = [
    created && `Created ${created}`,
    `${p.transport.bpm} BPM`,
    `${p.transport.timeSig.num}/${p.transport.timeSig.den}`,
    `${p.channelOrder.length} channels`,
    `${p.patternOrder.length} patterns`,
  ]
    .filter(Boolean)
    .join(' · ');

  const submit = async (): Promise<void> => {
    const patch: Record<string, string> = {};
    if (name.trim() !== meta.name) patch.name = name.trim();
    if (author.trim() !== meta.author) patch.author = author.trim();
    if (genre.trim() !== meta.genre) patch.genre = genre.trim();
    if (notes !== meta.notes) patch.notes = notes;
    if (!Object.keys(patch).length) {
      close();
      flashHint('Project info unchanged', 'info');
      return;
    }
    setBusy(true);
    const r = await dispatch('project.setMeta', patch, { label: 'Edit project info' });
    setBusy(false);
    if (r.ok) {
      close();
      flashHint('Project info saved', 'ok');
    }
  };

  return (
    <DialogForm onSubmit={() => void submit()} onCancel={close} submitLabel="Save" submitDisabled={!!nameErr} busy={busy} extra={stats}>
      <Field label="Name" wide>
        <input data-autofocus value={name} maxLength={128} onChange={(e) => setName(e.target.value)} className={input} />
        {nameErr && <div className="mt-1 text-[10px] text-rose-300">{nameErr}</div>}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Author" wide>
          <input value={author} maxLength={128} placeholder="Your artist name" onChange={(e) => setAuthor(e.target.value)} className={input} />
        </Field>
        <Field label="Genre" wide>
          <input value={genre} maxLength={64} list={listId} placeholder="e.g. Trap" onChange={(e) => setGenre(e.target.value)} className={input} />
          <datalist id={listId}>
            {GENRES.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field label="Notes" hint="Lyrics, ideas, references. Agents can read these too." wide>
        <textarea
          value={notes}
          maxLength={20000}
          rows={6}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          className="w-full resize-y rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[12px] leading-relaxed text-white placeholder-krypt-muted/50 outline-none transition focus:border-krypt-purple/60"
          placeholder="Anything about this project…"
        />
      </Field>
    </DialogForm>
  );
}

export function openProjectInfo(doc?: Document | null): void {
  openDialog({
    title: 'Project info',
    subtitle: 'Saved with the project. Undo reverts it in one step.',
    icon: FileText,
    width: 480,
    doc,
    render: (close) => <ProjectInfoForm close={close} />,
  });
}
