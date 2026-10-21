import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { Crosshair, FolderPlus, Layers, LibraryBig, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { hasFiles } from '../../app/fileDrop';
import { cls } from '../../utils/format';
import { refreshAnalyzer } from '../modelManager/store';
import { refreshLibrary, useLibrary } from '../../library/store';
import { createCollection, dropAsNewCollection } from '../../library/actions';
import { Sidebar } from './Sidebar';
import { CollectionHeader } from './Header';
import { TrackTable } from './TrackTable';
import { ProfileView } from './ProfileView';
import { SmallButton } from './ui';

function Welcome({ doc }: { doc: Document }) {
  const [hot, setHot] = useState(false);
  const onDrop = (e: DragEvent): void => {
    setHot(false);
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    void dropAsNewCollection(e.dataTransfer);
  };
  const point = (Icon: typeof Layers, title: string, text: string) => (
    <div className="flex gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-krypt-purple" />
      <div>
        <div className="text-[12px] font-semibold text-white">{title}</div>
        <div className="text-[11px] leading-snug text-krypt-muted">{text}</div>
      </div>
    </div>
  );
  return (
    <div
      className="flex h-full items-center justify-center overflow-y-auto p-6"
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setHot(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHot(false);
      }}
      onDrop={onDrop}
    >
      <div
        className={cls(
          'w-full max-w-[520px] rounded-2xl border bg-krypt-panel/80 p-5 shadow-krypt-card transition',
          hot ? 'border-krypt-purple/70 shadow-krypt-glow' : 'border-white/10',
        )}
      >
        <div className="flex items-center gap-2">
          <LibraryBig className="h-5 w-5 text-krypt-purple" />
          <h2 className="text-[16px] font-bold text-white">Teach Krypt your sound</h2>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-white/75">
          Add folders of songs you own or have licensed. Krypt analyses them on this PC and turns each collection into a style profile the AI composes from.
        </p>
        <div className="mt-4 space-y-3">
          {point(Sparkles, 'Analysis, not training', 'Tempo, key, drum patterns, chords, structure and mix targets are measured and summed up. No model is trained on your songs.')}
          {point(Crosshair, 'Make it the AI focus', 'Agents read the profile plus your own brief, and write original parts in that style.')}
          {point(ShieldCheck, 'Originality check', 'Flags melodies that land too close to a reference (needs deep analysis).')}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <SmallButton icon={FolderPlus} tone="primary" onClick={() => void createCollection(doc, { thenAddFolder: true })}>
            New collection from a folder…
          </SmallButton>
          <span className="text-[10px] text-krypt-muted">{hot ? 'Drop to make a collection' : 'or drop folders here'}</span>
        </div>
        <div className="mt-4 border-t border-white/[0.06] pt-3 text-[10px] leading-snug text-krypt-muted">
          Everything stays local. Krypt keeps the analysis and the file path, never a copy of the audio, and never deletes or moves your files.
        </div>
      </div>
    </div>
  );
}

export function LibraryPanel() {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const s = useLibrary((x) => x.state);
  const selected = useLibrary((x) => x.selected);
  const view = useLibrary((x) => x.view);

  useEffect(() => {
    void refreshLibrary();
    void refreshAnalyzer();
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!s]);

  if (!window.krypt?.library)
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-krypt-muted">
        This build has no reference library bridge. Update Krypt Studio.
      </div>
    );
  if (!s)
    return (
      <div className="flex h-full items-center justify-center text-krypt-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );

  const doc = root.current?.ownerDocument ?? document;
  const collection = selected ? (s.collections.find((c) => c.id === selected) ?? null) : null;
  const narrow = width < 640;
  const mainWidth = narrow ? width : width - 214;

  return (
    <div ref={root} className="flex h-full min-h-0 bg-[#0c0c12]">
      {!narrow && s.collections.length > 0 && <Sidebar doc={doc} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {s.collections.length === 0 ? (
          <Welcome doc={doc} />
        ) : (
          <>
            <CollectionHeader collection={collection} width={mainWidth} doc={doc} sidebar={!narrow} />
            <div className="flex min-h-0 flex-1 flex-col pt-2">
              {view === 'profile' && collection ? <ProfileView key={collection.id} collection={collection} doc={doc} /> : <TrackTable collection={collection} width={mainWidth} doc={doc} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
