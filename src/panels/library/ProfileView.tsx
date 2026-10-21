import { useEffect, useState, type ReactNode } from 'react';
import {
  AudioLines,
  Braces,
  ClipboardCopy,
  Crosshair,
  Drum,
  FolderPlus,
  Hourglass,
  Gauge,
  Layers,
  LayoutList,
  Loader2,
  Music2,
  Piano,
  RefreshCw,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react';
import type { Collection, StyleProfile } from '@shared/library/types';
import { cls } from '../../utils/format';
import {
  analysedCount,
  bandBars,
  degreeBars,
  fmtAgo,
  fmtCount,
  fmtKeyLong,
  fmtPct,
  fmtTrackLength,
  plural,
  rangeText,
  romanText,
} from '../../library/logic';
import { useLibrary } from '../../library/store';
import { addFolder, chooseFocus, copyProfileText, copyText, loadProfile, setDeep } from '../../library/actions';
import { C, Card, EmptyNote, Estimated, SmallButton, Stat } from './ui';
import { Columns, DrumHeatmap, EnergyShape, FormRow, HBars, ModeSplit, RangeRow, TempoHistogram, type Hover } from './charts';

function HoverCard({ idle, children, ...rest }: Omit<Parameters<typeof Card>[0], 'readout' | 'children'> & { idle: string; children: (onHover: Hover) => ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Card {...rest} readout={<span className={text ? 'text-white/85' : undefined}>{text ?? idle}</span>}>
      {children(setText)}
    </Card>
  );
}

const db = (v: number): string => (Number.isFinite(v) ? `${v > 0.05 ? '+' : ''}${v.toFixed(1)}` : '–');

export function ProfileView({ collection, doc }: { collection: Collection; doc: Document }) {
  const entry = useLibrary((s) => s.profiles[collection.id]);
  const focus = useLibrary((s) => s.state?.focus ?? null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!entry || entry.status === 'error') void loadProfile(collection.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection.id]);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const p = entry?.profile;
  if (!p) {
    if (!entry || entry.status === 'loading')
      return (
        <div className="flex h-full items-center justify-center gap-2 text-[11px] text-krypt-muted">
          <Loader2 className="h-4 w-4 animate-spin text-krypt-purple" /> Building the style profile…
        </div>
      );
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyNote icon={TriangleAlert} title="Couldn’t build the style profile" action={<SmallButton icon={RefreshCw} onClick={() => void loadProfile(collection.id)}>Try again</SmallButton>}>
          {entry.message}
        </EmptyNote>
      </div>
    );
  }

  const analysedNow = analysedCount(collection);
  const newSince = Math.max(0, analysedNow - entry.basis.analysed) + Math.max(0, collection.counts.deep - entry.basis.deep);
  const isFocus = focus?.collectionId === collection.id;
  const refreshing = entry.status === 'loading';

  return (
    <div className="h-full overflow-y-auto px-3 pb-4 pt-1">
      <div className="mb-2.5 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            {p.name}
            <span className="font-normal text-krypt-muted">style profile</span>
            {isFocus && (
              <span className="flex items-center gap-1 rounded-full border border-krypt-purple/40 bg-krypt-purple/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-purple-100">
                <Crosshair className="h-2.5 w-2.5" /> AI focus
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[10px] text-krypt-muted">
            {plural(p.tracks, 'track')} · {fmtCount(p.analysed)} analysed · {fmtCount(p.deep)} deep · updated {fmtAgo(p.updatedAt)}
            {newSince > 0 && entry.status === 'done' && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => void loadProfile(collection.id)}
                  className="font-semibold text-purple-200 underline-offset-2 hover:underline"
                  data-hint="Rebuild the profile with the tracks analysed since"
                >
                  {fmtCount(newSince)} newer track{newSince === 1 ? '' : 's'}: refresh
                </button>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SmallButton icon={RefreshCw} spinning={refreshing} disabled={refreshing} onClick={() => void loadProfile(collection.id)} hint="Rebuild the profile from the latest analysis">
            Refresh
          </SmallButton>
          <SmallButton icon={ClipboardCopy} onClick={() => void copyProfileText(p)} hint="Copy the compact text agents read (numbers, idioms, KPN examples)">
            Copy as text
          </SmallButton>
          <SmallButton icon={Crosshair} tone={isFocus ? 'focus' : 'primary'} onClick={() => chooseFocus(collection, doc)} hint={isFocus ? 'Edit the brief or clear the focus' : 'Agents compose from this profile'}>
            {isFocus ? 'AI focus' : 'Use as AI focus'}
          </SmallButton>
        </div>
      </div>

      {entry.status === 'error' && <div className="mb-2 text-[11px] text-rose-200">Refresh failed: {entry.message}</div>}

      {p.caveats.length > 0 && (
        <div className="mb-2.5 rounded-xl border border-amber-400/30 bg-amber-500/[0.08] px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200">
            <TriangleAlert className="h-3.5 w-3.5" /> Read with care
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-amber-50/90">
            {p.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {p.analysed === 0 ? (
        collection.counts.total === 0 ? (
          <EmptyNote
            icon={FolderPlus}
            title="This collection is empty"
            action={
              <SmallButton icon={FolderPlus} onClick={() => void addFolder(collection)}>
                Add folder…
              </SmallButton>
            }
          >
            Add a folder of songs (or drop folders on the collection). The profile builds itself as they are analysed.
          </EmptyNote>
        ) : (
          <EmptyNote icon={Hourglass} title="Nothing analysed yet">
            The profile fills in as the queue analyses this collection. Tempo, keys, drums and harmony come from the light pass; bass and melody need deep analysis.
          </EmptyNote>
        )
      ) : (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' }}>
          <TempoCard p={p} />
          <KeysCard p={p} />
          <DrumsCard p={p} />
          <BassCard p={p} collection={collection} doc={doc} />
          <HarmonyCard p={p} />
          <StructureCard p={p} />
          <MixCard p={p} />
          <ExamplesCard p={p} />
        </div>
      )}
    </div>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return <div className="py-3 text-center text-[10px] leading-snug text-krypt-muted">{children}</div>;
}

function TempoCard({ p }: { p: StyleProfile }) {
  const t = p.tempo;
  return (
    <HoverCard title="Tempo & feel" icon={Gauge} badge={<Estimated />} idle={t ? 'Tracks per 4-BPM bin · line = median, shade = typical range' : ''}>
      {(hover) =>
        t ? (
          <div>
            <TempoHistogram hist={t.histogram} bpm={t.bpm} onHover={hover} />
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Stat label="Median" value={`${Math.round(t.bpm.median)} BPM`} hint="Half the tracks are slower, half faster" />
              <Stat label="Typical" value={rangeText({ ...t.bpm, p10: t.bpm.p25, p90: t.bpm.p75 })} hint="The middle half of the tracks (p25–p75)" />
              <Stat
                label="Half-time?"
                value={fmtPct(t.halfTimeShare)}
                hint="Share of tracks whose tempo could be read at half or double speed (common in trap: 140 vs 70)"
              />
            </div>
            <div className="mt-2 border-t border-white/[0.06] pt-2">
              {p.swing ? (
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Swing" value={p.swing.median < 0.04 ? 'Straight' : fmtPct(p.swing.median)} hint="Median 16th-note swing (0% = straight, 67% ≈ triplet feel)" />
                  <Stat label="Swung tracks" value={fmtPct(p.swing.share)} hint="Share of tracks with noticeable swing" />
                </div>
              ) : (
                <div className="text-[10px] text-krypt-muted">Swing: not enough off-beat hits to measure</div>
              )}
            </div>
          </div>
        ) : (
          <Missing>No steady tempo detected in enough tracks yet.</Missing>
        )
      }
    </HoverCard>
  );
}

function KeysCard({ p }: { p: StyleProfile }) {
  const k = p.keys;
  const total = k ? k.top.reduce((a, b) => a + b.count, 0) : 0;
  const max = k ? Math.max(1, ...k.top.map((x) => x.count)) : 1;
  return (
    <HoverCard title="Keys" icon={Music2} badge={<Estimated />} idle={k ? 'Most common keys (relative to all keyed tracks)' : ''}>
      {(hover) =>
        k ? (
          <div className="space-y-2.5">
            <ModeSplit minorShare={k.minorShare} onHover={hover} />
            <HBars
              onHover={hover}
              items={k.top.slice(0, 8).map((x) => ({
                label: x.key.replace(/m$/, ' min').replace(/^([A-G][#b]?)$/, '$1 maj'),
                value: x.count,
                frac: x.count / max,
                text: fmtCount(x.count),
                hint: `${fmtKeyLong(x.key)} · ${plural(x.count, 'track')}${total ? ` (${fmtPct(x.count / total)} of the top keys)` : ''}`,
              }))}
            />
          </div>
        ) : (
          <Missing>No clear keys detected yet.</Missing>
        )
      }
    </HoverCard>
  );
}

const DRUM_SOURCE: Record<NonNullable<StyleProfile['drums']>['source'], string> = {
  mix: 'From hits detected on the full mix (light pass): kick and snare are solid, hats rougher. Deep analysis reads the drum stem instead.',
  stem: 'From the separated drum stems (deep pass).',
  mixed: 'Mix of drum-stem tracks (deep) and full-mix detection (light).',
};

function DrumsCard({ p }: { p: StyleProfile }) {
  const d = p.drums;
  return (
    <HoverCard
      title="Drum grid"
      icon={Drum}
      badge={<Estimated />}
      className="col-span-full"
      idle={d ? 'Chance of a hit on each 32nd of a bar · hover a cell for details' : ''}
      right={d ? <span className="text-[10px] text-krypt-muted">{plural(d.tracks, 'track')}</span> : undefined}
    >
      {(hover) =>
        d ? (
          <div>
            <DrumHeatmap roles={d.roles} onHover={hover} />
            <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2 border-t border-white/[0.06] pt-2">
              <Stat label="Hat rolls" value={`${d.rollsPerBar.toFixed(2)} / bar`} hint="Runs of 3+ consecutive 32nd hat hits per bar" />
              <Stat label="Source" value={d.source === 'mix' ? 'Full mix' : d.source === 'stem' ? 'Drum stems' : 'Mixed'} />
              <div className="min-w-[200px] flex-1 text-[10px] leading-snug text-krypt-muted">{DRUM_SOURCE[d.source]}</div>
            </div>
          </div>
        ) : (
          <Missing>No drum hits measured yet. Drums come from the light pass, so this fills in as tracks are analysed.</Missing>
        )
      }
    </HoverCard>
  );
}

function BassCard({ p, collection, doc }: { p: StyleProfile; collection: Collection; doc: Document }) {
  const b = p.bass;
  return (
    <HoverCard
      title="Bass & 808"
      icon={AudioLines}
      badge={b ? <Estimated /> : undefined}
      idle={b ? 'Bass notes per interval from the key root' : ''}
      right={b ? <span className="text-[10px] text-krypt-muted">{plural(b.tracks, 'track')}</span> : undefined}
    >
      {(hover) =>
        b ? (
          <div>
            <Columns onHover={hover} items={degreeBars(b.degrees).map((x) => ({ label: x.label, frac: x.frac, hint: `Degree ${x.label} · ${fmtPct(x.share)} of bass notes` }))} />
            <div className="mt-2 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-2">
              <Stat label="Note length" value={`${b.length.median.toFixed(2)} b`} sub={`${b.length.p25.toFixed(2)}–${b.length.p75.toFixed(2)} beats`} hint="Median bass note length in beats" />
              <Stat label="On the kick" value={fmtPct(b.kickAlign)} hint="Share of bass notes starting within a 32nd of a kick" />
              <Stat label="Glides" value={fmtPct(b.glide)} hint="Share of notes that slide into the next one (808 glide)" />
            </div>
          </div>
        ) : (
          <EmptyNote
            icon={Layers}
            title="Bass and melody statistics need deep analysis"
            action={
              collection.deep ? undefined : (
                <SmallButton icon={Layers} onClick={() => void setDeep(collection, true, doc)}>
                  Turn on deep analysis…
                </SmallButton>
              )
            }
          >
            {collection.deep
              ? 'Deep analysis is on: lengths, degrees, kick alignment and glides appear as tracks finish.'
              : 'They come from the bass stem, so this collection needs the deep pass (stems + transcription).'}
          </EmptyNote>
        )
      }
    </HoverCard>
  );
}

function HarmonyCard({ p }: { p: StyleProfile }) {
  const h = p.harmony;
  const max = h ? Math.max(1, ...h.progressions.map((x) => x.count)) : 1;
  return (
    <HoverCard title="Harmony" icon={Piano} badge={h ? <Estimated /> : undefined} idle={h ? 'Most common progressions, relative to each track’s key' : ''}>
      {(hover) =>
        h ? (
          <div>
            {h.progressions.length ? (
              <div className="space-y-1">
                {h.progressions.slice(0, 6).map((pr, i) => (
                  <div
                    key={i}
                    className="group flex items-center gap-2"
                    onPointerEnter={() => hover(`${romanText(pr.degrees)} · ${plural(pr.count, 'track')}`)}
                    onPointerLeave={() => hover(null)}
                  >
                    <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                      {pr.degrees.map((d, j) => (
                        <span key={j} className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-px font-mono text-[11px] font-semibold text-white group-hover:border-white/25">
                          {d}
                        </span>
                      ))}
                    </div>
                    <div className="h-1 w-10 flex-shrink-0 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full" style={{ width: `${(pr.count / max) * 100}%`, background: C.series }} />
                    </div>
                    <span className="w-6 flex-shrink-0 text-right font-mono text-[10px] text-krypt-muted">{fmtCount(pr.count)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Missing>No repeating progressions yet.</Missing>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-2">
              <Stat label="Chord changes" value={`${h.changesPerBar.toFixed(2)} / bar`} hint="Harmonic rhythm: how often the chord changes" />
              <Stat label="From" value={plural(h.tracks, 'track')} />
            </div>
          </div>
        ) : (
          <Missing>No chord estimates yet (atonal or drum-only tracks have none).</Missing>
        )
      }
    </HoverCard>
  );
}

function StructureCard({ p }: { p: StyleProfile }) {
  const s = p.structure;
  const total = s ? s.forms.reduce((a, b) => a + b.count, 0) : 0;
  return (
    <HoverCard title="Structure" icon={LayoutList} badge={s ? <Estimated /> : undefined} idle={s ? 'Common section orders (same letter = similar material)' : ''}>
      {(hover) =>
        s ? (
          <div className="space-y-2">
            {s.forms.length ? (
              <div className="space-y-1">
                {s.forms.slice(0, 4).map((f, i) => (
                  <FormRow key={i} form={f.form} count={f.count} total={total} onHover={hover} />
                ))}
              </div>
            ) : (
              <Missing>No repeating forms yet.</Missing>
            )}
            <div>
              <div className="mb-0.5 text-[9px] uppercase tracking-[0.14em] text-krypt-muted">Energy across a track</div>
              <EnergyShape values={s.energyShape} onHover={hover} />
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-2">
              <Stat label="Section length" value={`${Math.round(s.sectionBars.median)} bars`} sub={`typically ${Math.round(s.sectionBars.p25)}–${Math.round(s.sectionBars.p75)}`} />
              <Stat label="Track length" value={fmtTrackLength(s.lengthSec.median)} sub={`${fmtTrackLength(s.lengthSec.p25)}–${fmtTrackLength(s.lengthSec.p75)}`} />
            </div>
          </div>
        ) : (
          <Missing>Not enough sections detected yet.</Missing>
        )
      }
    </HoverCard>
  );
}

function MixCard({ p }: { p: StyleProfile }) {
  const m = p.mix;
  return (
    <HoverCard title="Mix targets" icon={SlidersHorizontal} idle={m ? 'Line = p10–p90, bar = typical, tick = median' : ''}>
      {(hover) =>
        m ? (
          <div className="space-y-2.5">
            <div className="space-y-1">
              <RangeRow label="Loudness" p={m.lufs} domain={[-30, -3]} fmt={(v) => v.toFixed(1)} unit="LUFS" onHover={hover} />
              <RangeRow label="True peak" p={m.truePeakDb} domain={[-12, 2]} fmt={db} unit="dBTP" onHover={hover} />
              <RangeRow label="Width" p={m.width} domain={[0, 1]} fmt={(v) => fmtPct(v)} onHover={hover} />
            </div>
            <div>
              <div className="mb-0.5 text-[9px] uppercase tracking-[0.14em] text-krypt-muted">Band balance (dB below the loudest band)</div>
              <Columns
                height={48}
                onHover={hover}
                items={bandBars(m.bands).map((b) => ({ label: b.label, frac: b.frac, hint: `${b.label}: ${b.db === 0 ? 'loudest band' : `${b.db.toFixed(1)} dB below the loudest band`}` }))}
              />
            </div>
          </div>
        ) : (
          <Missing>No loudness data yet.</Missing>
        )
      }
    </HoverCard>
  );
}

function CodeBlock({ title, code, empty }: { title: string; code: string | null; empty: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-krypt-muted">{title}</span>
        {code && (
          <button
            type="button"
            onClick={() => void copyText(code, `${title} example`)}
            className="ml-auto flex h-5 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[10px] font-semibold text-white/85 hover:border-white/20"
            data-hint="Copy this KPN (paste it to an agent, or into a KPN-aware tool)"
          >
            <ClipboardCopy className="h-3 w-3" /> Copy
          </button>
        )}
      </div>
      {code ? (
        <pre className="max-h-48 overflow-auto rounded-lg border border-white/[0.06] bg-black/50 p-2 font-mono text-[10px] leading-relaxed text-white/85">{code}</pre>
      ) : (
        <div className="rounded-lg border border-dashed border-white/10 px-2 py-3 text-center text-[10px] text-krypt-muted">{empty}</div>
      )}
    </div>
  );
}

function ExamplesCard({ p }: { p: StyleProfile }) {
  return (
    <Card title="Example patterns (KPN)" icon={Braces} className="col-span-full">
      <div className="mb-2 text-[10px] leading-snug text-krypt-muted">
        Sampled from the probabilities above, never copied from one track. This is the kind of starting point agents get.
      </div>
      <div className={cls('flex flex-wrap gap-2.5')}>
        <CodeBlock title="Drums" code={p.examples.drums} empty="No drum example yet" />
        <CodeBlock title="Bass" code={p.examples.bass} empty="Needs bass statistics (deep analysis)" />
      </div>
    </Card>
  );
}
