// Thin gradient progress bar; fraction < 0 = indeterminate (sweeping).

import { cls } from '../utils/format';

export function ProgressBar({ fraction, className }: { fraction: number; className?: string }) {
  const indeterminate = !(fraction >= 0);
  return (
    <div className={cls('relative h-1.5 overflow-hidden rounded-full bg-white/10', className)}>
      {indeterminate ? (
        <div className="krypt-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-krypt-gradient" />
      ) : (
        <div className="h-full rounded-full bg-krypt-gradient transition-[width] duration-200" style={{ width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` }} />
      )}
    </div>
  );
}
