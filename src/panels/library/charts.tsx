import { useMemo, useState } from 'react';
import type { DrumRole } from '@shared/analyzer/protocol';
import type { Percentiles } from '@shared/library/types';
import { cls } from '../../utils/format';
import { sectionColor } from '../../ears/logic';
import { DRUM_ROLES, ROLE_LABEL, fmtCount, fmtPct, heatAlpha, histPosition, histogramBars, shapePath, stepPosition } from '../../library/logic';
import { C } from './ui';

export type Hover = (text: string | null) => void;

export function TempoHistogram({ hist, bpm, onHover }: { hist: Array<{ bpm: number; count: number }>; bpm: Percentiles; onHover: Hover }) {
  const bars = useMemo(() => histogramBars(hist), [hist]);
  if (!bars.length) return <div className="py-6 text-center text-[10px] text-krypt-muted">No tempo data</div>;
  const pos = (v: number): number => histPosition(bars, v) * 100;
  const last = bars[bars.length - 1].bpm + 4;
  return (
    <div>
      <div className="relative h-[84px]">
        <div className="absolute inset-y-0 rounded-sm bg-white/[0.04]" style={{ left: `${pos(bpm.p25)}%`, width: `${Math.max(0.5, pos(bpm.p75) - pos(bpm.p25))}%` }} />
        <div className="absolute inset-x-0 bottom-0 h-px bg-white/10" />
        <div className="relative flex h-full items-end gap-[2px]">
          {bars.map((b) => (
            <div
              key={b.bpm}
              className="group flex h-full min-w-0 flex-1 items-end justify-center"
              onPointerEnter={() => onHover(`${b.bpm}–${b.bpm + 3} BPM · ${fmtCount(b.count)} track${b.count === 1 ? '' : 's'} (${fmtPct(b.share)})`)}
              onPointerLeave={() => onHover(null)}
            >
              <div
                className="w-full max-w-[24px] rounded-t-[4px] transition group-hover:brightness-125"
                style={{ height: `${b.count ? Math.max(3, b.frac * 100) : 0}%`, background: C.series }}
              />
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 w-px bg-white/80" style={{ left: `${pos(bpm.median)}%` }}>
          <span className="absolute -top-px left-1 whitespace-nowrap rounded bg-black/60 px-1 font-mono text-[9px] text-white">{Math.round(bpm.median)}</span>
        </div>
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-krypt-muted">
        <span>{bars[0].bpm}</span>
        <span>BPM</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

export function ModeSplit({ minorShare, onHover }: { minorShare: number; onHover: Hover }) {
  const minor = Math.max(0, Math.min(1, minorShare));
  const major = 1 - minor;
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full">
        {minor > 0 && (
          <div
            className="h-full rounded-l-full transition hover:brightness-125"
            style={{ width: `${minor * 100}%`, background: C.minor, borderRadius: major > 0 ? undefined : '9999px' }}
            onPointerEnter={() => onHover(`Minor keys · ${fmtPct(minor)} of tracks`)}
            onPointerLeave={() => onHover(null)}
          />
        )}
        {major > 0 && (
          <div
            className="h-full rounded-r-full transition hover:brightness-125"
            style={{ width: `${major * 100}%`, background: C.major, borderRadius: minor > 0 ? undefined : '9999px' }}
            onPointerEnter={() => onHover(`Major keys · ${fmtPct(major)} of tracks`)}
            onPointerLeave={() => onHover(null)}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px]">
        <span className="flex items-center gap-1 text-white/80">
          <span className="h-2 w-2 rounded-sm" style={{ background: C.minor }} /> Minor <span className="font-mono text-white">{fmtPct(minor)}</span>
        </span>
        <span className="flex items-center gap-1 text-white/80">
          Major <span className="font-mono text-white">{fmtPct(major)}</span> <span className="h-2 w-2 rounded-sm" style={{ background: C.major }} />
        </span>
      </div>
    </div>
  );
}

export function HBars({ items, onHover }: { items: Array<{ label: string; value: number; frac: number; text: string; hint: string }>; onHover: Hover }) {
  return (
    <div className="space-y-[3px]">
      {items.map((it) => (
        <div key={it.label} className="group flex items-center gap-2" onPointerEnter={() => onHover(it.hint)} onPointerLeave={() => onHover(null)}>
          <span className="w-[62px] flex-shrink-0 truncate font-mono text-[10px] text-white/85">{it.label}</span>
          <div className="relative h-3 min-w-0 flex-1">
            <div className="h-full rounded-r-[4px] transition group-hover:brightness-125" style={{ width: `${Math.max(1.5, it.frac * 100)}%`, background: C.series }} />
          </div>
          <span className="w-9 flex-shrink-0 text-right font-mono text-[10px] text-krypt-muted">{it.text}</span>
        </div>
      ))}
    </div>
  );
}

export function Columns({ items, height = 64, onHover }: { items: Array<{ label: string; frac: number; hint: string; dim?: boolean }>; height?: number; onHover: Hover }) {
  return (
    <div>
      <div className="relative flex items-end gap-[2px]" style={{ height }}>
        <div className="absolute inset-x-0 bottom-0 h-px bg-white/10" />
        {items.map((it) => (
          <div
            key={it.label}
            className="group relative flex h-full min-w-0 flex-1 items-end justify-center"
            onPointerEnter={() => onHover(it.hint)}
            onPointerLeave={() => onHover(null)}
          >
            <div
              className={cls('w-full max-w-[24px] rounded-t-[4px] transition group-hover:brightness-125', it.dim && 'opacity-50')}
              style={{ height: `${it.frac > 0 ? Math.max(3, it.frac * 100) : 0}%`, background: C.series }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px]">
        {items.map((it) => (
          <span key={it.label} className="min-w-0 flex-1 truncate text-center font-mono text-[9px] text-krypt-muted">
            {it.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DrumHeatmap({ roles, onHover }: { roles: Partial<Record<DrumRole, { prob: number[]; vel: number[] }>>; onHover: Hover }) {
  const [hot, setHot] = useState<string | null>(null);
  const present = DRUM_ROLES.filter((r) => roles[r]);
  if (!present.length) return <div className="py-6 text-center text-[10px] text-krypt-muted">No drum hits measured</div>;
  const beats = [0, 1, 2, 3];
  return (
    <div className="select-none">
      <div className="flex items-end pb-1">
        <span className="w-[76px] flex-shrink-0" />
        <div className="flex min-w-0 flex-1 gap-[5px]">
          {beats.map((b) => (
            <span key={b} className="min-w-0 flex-1 font-mono text-[9px] text-krypt-muted">
              {b + 1}
            </span>
          ))}
        </div>
      </div>
      <div className="space-y-[3px]">
        {present.map((role) => {
          const r = roles[role]!;
          return (
            <div key={role} className="flex items-center">
              <span className="w-[76px] flex-shrink-0 truncate pr-2 text-[10px] font-semibold text-white/85">{ROLE_LABEL[role]}</span>
              <div className="flex min-w-0 flex-1 gap-[5px]">
                {beats.map((b) => (
                  <div key={b} className="flex min-w-0 flex-1 gap-[1px]">
                    {Array.from({ length: 8 }, (_, i) => {
                      const step = b * 8 + i;
                      const p = r.prob[step] ?? 0;
                      const v = r.vel[step] ?? 0;
                      const id = `${role}:${step}`;
                      return (
                        <div
                          key={step}
                          className={cls('h-4 min-w-0 flex-1 rounded-[2px]', i === 4 && 'ml-[2px]', hot === id && 'ring-1 ring-white/80')}
                          style={{ background: p > 0 ? `rgba(${C.heat}, ${0.08 + 0.92 * heatAlpha(p)})` : 'rgba(255,255,255,0.035)' }}
                          onPointerEnter={() => {
                            setHot(id);
                            onHover(
                              `${ROLE_LABEL[role]} · ${stepPosition(step)} · hit in ${fmtPct(p)} of bars${p > 0 && v > 0 ? ` · velocity ${Math.round(v * 100)}%` : ''}`,
                            );
                          }}
                          onPointerLeave={() => {
                            setHot(null);
                            onHover(null);
                          }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5 text-[9px] text-krypt-muted">
        <span>Rare</span>
        {[0.05, 0.2, 0.4, 0.7, 1].map((p) => (
          <span key={p} className="h-2.5 w-4 rounded-[2px]" style={{ background: `rgba(${C.heat}, ${0.08 + 0.92 * heatAlpha(p)})` }} />
        ))}
        <span>Every bar</span>
      </div>
    </div>
  );
}

export function RangeRow({
  label,
  p,
  domain,
  fmt,
  unit,
  onHover,
}: {
  label: string;
  p: Percentiles;
  domain: [number, number];
  fmt: (v: number) => string;
  unit?: string;
  onHover: Hover;
}) {
  const [lo, hi] = domain;
  const x = (v: number): number => Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100));
  const u = unit ? ` ${unit}` : '';
  const hint = `${label}: median ${fmt(p.median)}${u} · typical ${fmt(p.p25)} to ${fmt(p.p75)}${u} · range ${fmt(p.p10)} to ${fmt(p.p90)}${u} (p10–p90)`;
  return (
    <div className="flex items-center gap-2" onPointerEnter={() => onHover(hint)} onPointerLeave={() => onHover(null)}>
      <span className="w-[68px] flex-shrink-0 truncate text-[10px] text-white/80">{label}</span>
      <div className="relative h-4 min-w-0 flex-1">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10" />
        <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full opacity-45" style={{ left: `${x(p.p10)}%`, width: `${Math.max(0.5, x(p.p90) - x(p.p10))}%`, background: C.series }} />
        <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-[3px]" style={{ left: `${x(p.p25)}%`, width: `${Math.max(0.8, x(p.p75) - x(p.p25))}%`, background: C.series }} />
        <div className="absolute top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-full bg-white" style={{ left: `calc(${x(p.median)}% - 1px)` }} />
      </div>
      <span className="w-[74px] flex-shrink-0 text-right font-mono text-[10px] text-white">
        {fmt(p.median)}
        <span className="text-krypt-muted">{u}</span>
      </span>
    </div>
  );
}

export function EnergyShape({ values, onHover }: { values: number[]; onHover: Hover }) {
  const W = 300;
  const H = 54;
  const line = useMemo(() => shapePath(values, W, H), [values]);
  const [at, setAt] = useState<number | null>(null);
  if (!line) return <div className="py-4 text-center text-[10px] text-krypt-muted">No energy curve</div>;
  const n = values.length;
  const area = `${line} L${W},${H} L0,${H} Z`;
  const px = (i: number): number => (i / (n - 1)) * W;
  const py = (v: number): number => 2 + (1 - Math.max(0, Math.min(1, v))) * (H - 4);
  return (
    <div>
      <div
        className="relative"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / (r.width || 1)) * (n - 1))));
          setAt(i);
          onHover(`${Math.round((i / (n - 1)) * 100)}% into a typical track · energy ${fmtPct(values[i])} of its loudest point`);
        }}
        onPointerLeave={() => {
          setAt(null);
          onHover(null);
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[54px] w-full overflow-visible">
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="rgba(255,255,255,0.1)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={area} fill={C.series} fillOpacity="0.12" />
          <path d={line} fill="none" stroke={C.series} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {at !== null && <line x1={px(at)} y1="0" x2={px(at)} y2={H} stroke="rgba(255,255,255,0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        </svg>
        {at !== null && (
          <span
            className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#11111A]"
            style={{ left: `${(at / (n - 1)) * 100}%`, top: `${(py(values[at]) / H) * 100}%`, background: C.series }}
          />
        )}
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-krypt-muted">
        <span>Start</span>
        <span>End</span>
      </div>
    </div>
  );
}

export function FormRow({ form, count, total, onHover }: { form: string[]; count: number; total: number; onHover: Hover }) {
  return (
    <div
      className="flex items-center gap-2"
      onPointerEnter={() => onHover(`${form.join(' ')} · ${fmtCount(count)} track${count === 1 ? '' : 's'}${total ? ` (${fmtPct(count / total)})` : ''}`)}
      onPointerLeave={() => onHover(null)}
    >
      <div className="flex min-w-0 flex-1 gap-[2px]">
        {form.map((l, i) => (
          <span
            key={i}
            className="flex h-4 min-w-[14px] flex-1 items-center justify-center rounded-[3px] text-[9px] font-bold text-white"
            style={{ background: sectionColor(l), maxWidth: 34 }}
          >
            {l}
          </span>
        ))}
      </div>
      <span className="w-8 flex-shrink-0 text-right font-mono text-[10px] text-krypt-muted">{fmtCount(count)}</span>
    </div>
  );
}
