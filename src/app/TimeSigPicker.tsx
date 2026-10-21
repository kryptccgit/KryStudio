import { useRef, useState } from 'react';
import { formatTimeSig, sameTimeSig, timeSigProblem, TIME_SIG_DENOMINATORS, TIME_SIG_MAX_NUM, TIME_SIG_PRESETS } from '@shared/schema/meter';
import type { TimeSig } from '@shared/schema/time';
import { dispatch, getProject, useProject } from '../doc/store';
import { closeMenu, toggleMenuAt, type MenuItem } from '../components/Menu';
import { toast } from './notify';
import { cls } from '../utils/format';

export async function setTimeSig(ts: TimeSig): Promise<boolean> {
  const cur = getProject()?.transport.timeSig;
  if (cur && sameTimeSig(cur, ts)) {
    toast.info(`Already in ${formatTimeSig(ts)}`);
    return false;
  }
  const problem = timeSigProblem(ts.num, ts.den);
  if (problem) {
    toast.error(problem);
    return false;
  }
  const r = await dispatch('transport.set', { timeSig: { num: ts.num, den: ts.den } }, { label: `Time signature ${formatTimeSig(ts)}` });
  if (r.ok) toast.success(`Time signature ${formatTimeSig(ts)} · clips keep their beats, bars re-count`);
  return r.ok;
}

function CustomForm({ current }: { current: TimeSig }) {
  const [num, setNum] = useState(String(current.num));
  const [den, setDen] = useState(current.den);
  const n = Number(num);
  const problem = num.trim() === '' ? 'Type the top number' : timeSigProblem(n, den);
  const apply = () => {
    if (problem) {
      toast.error(problem);
      return;
    }
    closeMenu();
    void setTimeSig({ num: n, den });
  };
  return (
    <div className="w-[230px] px-3 py-2" onKeyDown={(e) => e.stopPropagation()}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Custom</div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          type="number"
          min={1}
          max={TIME_SIG_MAX_NUM}
          value={num}
          aria-label="Beats per bar (top number)"
          onChange={(e) => setNum(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
          className="h-7 w-14 rounded-lg border border-white/10 bg-black/40 px-2 font-mono text-[12px] text-white outline-none focus:border-krypt-purple/60"
        />
        <span className="text-krypt-muted">/</span>
        <select
          value={den}
          aria-label="Beat unit (bottom number)"
          onChange={(e) => setDen(Number(e.target.value))}
          className="h-7 rounded-lg border border-white/10 bg-black/40 px-1.5 font-mono text-[12px] text-white outline-none focus:border-krypt-purple/60"
        >
          {TIME_SIG_DENOMINATORS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={apply}
          disabled={!!problem}
          className="ml-auto h-7 rounded-lg bg-krypt-gradient px-2.5 text-[11px] font-semibold text-white transition disabled:opacity-40"
        >
          Apply
        </button>
      </div>
      <div className={cls('mt-1 text-[10px] leading-snug', problem ? 'text-amber-300' : 'text-krypt-muted')}>{problem ?? 'Top: beats in a bar. Bottom: the note that gets a beat.'}</div>
    </div>
  );
}

export function TimeSigPicker() {
  const ts = useProject((p) => p.transport.timeSig);
  const ref = useRef<HTMLButtonElement>(null);
  const items = (): MenuItem[] => {
    const cur = getProject()?.transport.timeSig ?? ts;
    return [
      { type: 'header', label: 'Time signature' },
      ...TIME_SIG_PRESETS.map(
        (p): MenuItem => ({
          label: `${p.num}/${p.den}`,
          detail: p.hint,
          checked: sameTimeSig(cur, p),
          onSelect: () => void setTimeSig({ num: p.num, den: p.den }),
        }),
      ),
      { type: 'separator' },
      { type: 'custom', render: () => <CustomForm current={cur} /> },
    ];
  };
  return (
    <button
      ref={ref}
      type="button"
      data-guide="transport.timeSig"
      onClick={() => ref.current && toggleMenuAt(ref.current, items)}
      className="flex flex-col items-center rounded-md border border-transparent px-1 leading-none transition hover:border-white/10 hover:bg-white/[0.04]"
      data-hint={`Time signature ${formatTimeSig(ts)}: click to change it (3/4, 6/8, 7/8 …)`}
    >
      <span className="h-6 font-mono text-[14px] font-semibold leading-6 tabular-nums text-white">{formatTimeSig(ts)}</span>
      <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-[0.2em] text-krypt-muted">Meter</span>
    </button>
  );
}
