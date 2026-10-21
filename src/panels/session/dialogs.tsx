// Session view dialogs: the follow-action editor, a custom clip length and a
// scene tempo. Each applies through one session.* command.

import { useState } from 'react';
import { Gauge, Ruler, Shuffle } from 'lucide-react';
import type { FollowAction, FollowRule, LaunchClip, Scene } from '@shared/schema/launcher';
import type { TimeSig } from '@shared/schema/time';
import { DialogForm, DialogSelect, Field, NumberBox, RangeField, openDialog } from '../../components/Dialog';
import {
  AFTER_BARS_PRESETS,
  FOLLOW_LABELS,
  FOLLOW_OPTIONS,
  MAX_AFTER_BARS,
  MIN_AFTER_BARS,
  barsToTicks,
  chanceToPercent,
  defaultFollow,
  followSummary,
  formatBars,
  normalizeAfterBars,
  percentToChance,
  sanitizeFollow,
  ticksToBars,
} from './model';
import { setScene, updateClip } from './actions';

// ── Follow actions ───────────────────────────────────────────────────

export function openFollowEditor(clip: LaunchClip, label: string, ts: TimeSig, doc?: Document | null): void {
  openDialog({
    key: 'session-follow',
    title: 'Follow action',
    subtitle: `${label}: what happens after it has played for a while. Agents can set these too.`,
    icon: Shuffle,
    doc,
    width: 420,
    render: (close) => <FollowForm clip={clip} ts={ts} onDone={close} />,
  });
}

function FollowForm({ clip, ts, onDone }: { clip: LaunchClip; ts: TimeSig; onDone: () => void }) {
  const init = clip.follow ?? defaultFollow(ticksToBars(clip.length, ts));
  const [on, setOn] = useState(!!clip.follow);
  const [action, setAction] = useState<FollowAction>(init.action);
  const [pct, setPct] = useState(chanceToPercent(init.chance));
  const [other, setOther] = useState<FollowAction>(init.otherAction);
  const [after, setAfter] = useState(normalizeAfterBars(init.afterBars));
  const rule: FollowRule = sanitizeFollow({ action, chance: percentToChance(pct), otherAction: other, afterBars: after });
  const apply = (): void => {
    onDone();
    void updateClip(clip.id, { follow: on ? rule : null }, on ? 'Set follow action' : 'Remove follow action');
  };
  return (
    <DialogForm onSubmit={apply} onCancel={onDone} submitLabel="Apply" extra={on ? followSummary(rule) : 'The clip loops until you launch something else'}>
      <Field label="Follow action" hint="Off: the clip just loops (or plays once with Loop off)">
        <DialogSelect<'on' | 'off'>
          value={on ? 'on' : 'off'}
          onChange={(v) => setOn(v === 'on')}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          width={110}
        />
      </Field>
      {on && (
        <>
          <Field label="After" hint="Bars after the launch (quarter bars allowed)">
            <div className="flex items-center gap-1.5">
              <DialogSelect<number>
                value={(AFTER_BARS_PRESETS as readonly number[]).includes(after) ? after : -1}
                onChange={(v) => v > 0 && setAfter(v)}
                options={[...AFTER_BARS_PRESETS.map((b) => ({ value: b as number, label: formatBars(b) })), ...((AFTER_BARS_PRESETS as readonly number[]).includes(after) ? [] : [{ value: -1, label: 'Custom' }])]}
                width={110}
              />
              <NumberBox value={after} min={MIN_AFTER_BARS} max={MAX_AFTER_BARS} step={0.25} onChange={(v) => setAfter(normalizeAfterBars(v))} width={60} />
            </div>
          </Field>
          <Field label="Action" hint="next / previous skip empty slots and wrap around">
            <DialogSelect<FollowAction> value={action} onChange={setAction} options={FOLLOW_OPTIONS} width={150} />
          </Field>
          <RangeField label="Chance" hint={`Of "${FOLLOW_LABELS[action]}"; otherwise the other action`} value={pct} onChange={setPct} min={0} max={100} step={1} format={(v) => `${v} %`} />
          <Field label="Other action" hint={`Runs ${100 - pct} % of the time`}>
            <DialogSelect<FollowAction> value={other} onChange={setOther} options={FOLLOW_OPTIONS} width={150} />
          </Field>
        </>
      )}
    </DialogForm>
  );
}

// ── Clip length ──────────────────────────────────────────────────────

export function openLengthDialog(clip: LaunchClip, label: string, ts: TimeSig, doc?: Document | null): void {
  openDialog({
    key: 'session-length',
    title: 'Clip length',
    subtitle: `${label}: how much of its pattern or audio loops.`,
    icon: Ruler,
    doc,
    width: 380,
    render: (close) => <LengthForm clip={clip} ts={ts} onDone={close} />,
  });
}

function LengthForm({ clip, ts, onDone }: { clip: LaunchClip; ts: TimeSig; onDone: () => void }) {
  const [bars, setBars] = useState(() => Math.round(ticksToBars(clip.length, ts) * 4) / 4);
  const [offset, setOffset] = useState(() => Math.round(ticksToBars(clip.offset, ts) * 4) / 4);
  const valid = bars >= 0.25;
  return (
    <DialogForm
      onSubmit={() => {
        onDone();
        void updateClip(clip.id, { length: barsToTicks(bars, ts), offset: offset > 0 ? barsToTicks(offset, ts) : 0 }, 'Clip length');
      }}
      onCancel={onDone}
      submitDisabled={!valid}
      extra={`${ts.num}/${ts.den} time`}
    >
      <Field label="Length" hint="In bars (quarter bars allowed)">
        <NumberBox value={bars} min={0.25} max={1024} step={0.25} suffix="bars" onChange={setBars} />
      </Field>
      <Field label="Start offset" hint="Bars into the source where the loop starts">
        <NumberBox value={offset} min={0} max={1024} step={0.25} suffix="bars" onChange={setOffset} />
      </Field>
    </DialogForm>
  );
}

// ── Scene tempo ──────────────────────────────────────────────────────

export function openSceneTempoDialog(scene: Scene, currentBpm: number, doc?: Document | null): void {
  openDialog({
    key: 'session-tempo',
    title: 'Scene tempo',
    subtitle: `Launching "${scene.name}" also sets the project tempo (an undoable edit).`,
    icon: Gauge,
    doc,
    width: 380,
    render: (close) => <TempoForm scene={scene} bpm={currentBpm} onDone={close} />,
  });
}

function TempoForm({ scene, bpm, onDone }: { scene: Scene; bpm: number; onDone: () => void }) {
  const [on, setOn] = useState(scene.tempo !== null);
  const [tempo, setTempo] = useState(scene.tempo ?? Math.round(bpm * 100) / 100);
  return (
    <DialogForm
      onSubmit={() => {
        onDone();
        void setScene(scene.id, { tempo: on ? Math.max(10, Math.min(999, tempo)) : null });
      }}
      onCancel={onDone}
      extra={on ? `${tempo} BPM when launched` : 'Keeps the current tempo'}
    >
      <Field label="Set tempo on launch">
        <DialogSelect<'on' | 'off'>
          value={on ? 'on' : 'off'}
          onChange={(v) => setOn(v === 'on')}
          options={[
            { value: 'on', label: 'Yes' },
            { value: 'off', label: 'No' },
          ]}
          width={100}
        />
      </Field>
      {on && (
        <Field label="Tempo" hint="10 to 999 BPM">
          <NumberBox value={tempo} min={10} max={999} step={0.01} suffix="bpm" onChange={setTempo} width={80} />
        </Field>
      )}
    </DialogForm>
  );
}
