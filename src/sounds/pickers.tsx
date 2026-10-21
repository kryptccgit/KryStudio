import { Layers } from 'lucide-react';
import { getProject } from '../doc/store';
import { toggleMenuAt } from '../components/Menu';
import { openDialog } from '../components/Dialog';
import { toast } from '../app/notify';
import { PresetBrowser } from './PresetBrowser';
import { applyChainPreset, loadPresetOnChannel } from './actions';

function fitWidth(el: Element, want: number): number {
  const win = el.ownerDocument.defaultView ?? window;
  return Math.max(260, Math.min(want, win.innerWidth - 16));
}

export function toggleChannelPresetPopover(anchor: HTMLElement, channelId: string): void {
  const width = fitWidth(anchor, 380);
  toggleMenuAt(
    anchor,
    () => [
      {
        type: 'custom',
        render: (close) => (
          <PresetBrowser
            kind="instrument"
            width={width}
            currentId={getProject().channels[channelId]?.generator.preset?.id ?? null}
            close={close}
            onPick={(p, o) => loadPresetOnChannel(channelId, p.id, { withFx: o.withFx })}
          />
        ),
      },
    ],
    { minWidth: width },
  );
}

export function toggleChainPopover(anchor: HTMLElement, insertId: string): void {
  const ins = getProject().mixer.inserts[insertId];
  if (!ins) {
    toast.error('That mixer insert no longer exists');
    return;
  }
  const width = fitWidth(anchor, 360);
  toggleMenuAt(
    anchor,
    () => [
      {
        type: 'custom',
        render: (close) => (
          <PresetBrowser kind="chain" width={width} isMaster={!!ins.isMaster} close={close} onPick={(p, o) => applyChainPreset(insertId, p.id, o.mode)} />
        ),
      },
    ],
    { minWidth: width },
  );
}

export function openChainPicker(insertId: string, doc?: Document | null): void {
  const ins = getProject().mixer.inserts[insertId];
  if (!ins) {
    toast.error('That mixer insert no longer exists');
    return;
  }
  openDialog({
    key: 'load-chain',
    title: 'Load chain',
    subtitle: `Effect chains for ${ins.isMaster ? 'the master' : ins.name}. Replace swaps its effects; Append adds after them. One undo step.`,
    icon: Layers,
    width: 420,
    doc,
    render: (close) => (
      <div className="pt-1">
        <PresetBrowser kind="chain" width={418} isMaster={!!ins.isMaster} close={close} listMaxHeight="min(420px, calc(80vh - 200px))" onPick={(p, o) => applyChainPreset(insertId, p.id, o.mode)} />
      </div>
    ),
  });
}
