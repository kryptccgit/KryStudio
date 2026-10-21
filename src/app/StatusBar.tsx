// Bottom status bar: the hint bar (hover help, live values, confirmations),
// render progress, the last document change, telemetry state.

import { useEffect, useRef, useState } from 'react';
import { Bot, User } from 'lucide-react';
import { useDocStore } from '../doc/store';
import { bindHintElement } from './hints';
import { useRender, useSettings } from '../state/status';
import { onFrame } from '../render/frameLoop';
import { telemetry } from '../live/telemetry';
import { cls } from '../utils/format';
import { JobsIndicator } from '../ears/JobsIndicator';
import { LibraryQueueIndicator } from '../library/QueueIndicator';

function TelemetryDot() {
  const dot = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let last: boolean | null = null;
    let acc = 0;
    return onFrame((dt) => {
      acc += dt;
      if (acc < 0.5 && last !== null) return;
      acc = 0;
      const c = telemetry.connected;
      if (c === last) return;
      last = c;
      if (dot.current) dot.current.className = cls('h-1.5 w-1.5 rounded-full', c ? 'bg-emerald-400' : 'bg-white/20');
      if (label.current) label.current.textContent = c ? 'Live' : 'No telemetry';
    });
  }, []);
  return (
    <span className="flex items-center gap-1" data-hint="Meters and playhead stream straight from the audio engine">
      <span ref={dot} className="h-1.5 w-1.5 rounded-full bg-white/20" />
      <span ref={label}>No telemetry</span>
    </span>
  );
}

function LastChange() {
  const last = useDocStore((s) => s.lastChange);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10000);
    return () => clearInterval(t);
  }, []);
  if (!last) return null;
  const agent = last.actorKind === 'agent';
  const Icon = agent ? Bot : User;
  return (
    <span className={cls('flex max-w-[320px] items-center gap-1 truncate', agent ? 'text-purple-200' : 'text-krypt-muted')} data-hint="The last change to the project (see History for all of them)">
      <Icon className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">
        {last.actorName}: {last.label}
      </span>
    </span>
  );
}

function RenderProgress() {
  const r = useRender();
  if (!r.active) return null;
  return (
    <span className="flex items-center gap-2 text-white/80">
      {r.label}
      <span className="h-1.5 w-28 overflow-hidden rounded-full bg-white/10">
        <span className="block h-full rounded-full bg-krypt-gradient transition-[width] duration-200" style={{ width: `${Math.round(r.progress * 100)}%` }} />
      </span>
      <span className="font-mono">{Math.round(r.progress * 100)}%</span>
    </span>
  );
}

export function StatusBar() {
  const showHints = useSettings((s) => s.settings?.ui.showHints ?? true);
  return (
    <div className="flex h-6 flex-shrink-0 items-center gap-3 border-t border-white/[0.06] bg-krypt-void px-2.5 text-[10px] text-krypt-muted">
      <div className="min-w-0 flex-1">{showHints && <span ref={bindHintElement} className="truncate text-white/80" />}</div>
      <RenderProgress />
      <JobsIndicator />
      <LibraryQueueIndicator />
      <LastChange />
      <TelemetryDot />
    </div>
  );
}
