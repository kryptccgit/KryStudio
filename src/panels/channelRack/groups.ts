import { create } from 'zustand';
import { pluginById } from '@shared/plugins/catalog';
import type { Channel, Project } from '@shared/schema/project';

export const ALL_GROUPS = 'All';
export const AUTO_GROUPS = ['Drums', 'Synths'] as const;

const DRUM_TYPES = new Set(['krypt.sampler', 'krypt.kick808', 'krypt.drumsynth', 'krypt.audioclip']);

export function autoGroup(ch: Pick<Channel, 'generator'>): string {
  const type = ch.generator.type;
  if (DRUM_TYPES.has(type)) return 'Drums';
  const cat = pluginById(type)?.category ?? '';
  return /drum|perc|kit|sampler/i.test(cat) ? 'Drums' : 'Synths';
}

export function channelGroup(ch: Pick<Channel, 'generator' | 'group'>): string {
  return ch.group?.trim() || autoGroup(ch);
}

export function groupNames(p: Project): string[] {
  const custom = new Set<string>();
  for (const id of p.channelOrder) {
    const g = p.channels[id]?.group?.trim();
    if (g && !(AUTO_GROUPS as readonly string[]).includes(g)) custom.add(g);
  }
  return [...AUTO_GROUPS, ...[...custom].sort((a, b) => a.localeCompare(b))];
}

export function filterChannels(p: Project, filter: string): string[] {
  if (filter === ALL_GROUPS) return p.channelOrder;
  return p.channelOrder.filter((id) => p.channels[id] && channelGroup(p.channels[id]) === filter);
}

interface RackView {
  filter: string;
  setFilter: (filter: string) => void;
}

export const useRackView = create<RackView>((set) => ({
  filter: ALL_GROUPS,
  setFilter: (filter) => set({ filter }),
}));

export function cycleFilter(p: Project, dir: 1 | -1): string {
  const list = [ALL_GROUPS, ...groupNames(p)];
  const cur = Math.max(0, list.indexOf(useRackView.getState().filter));
  const next = list[(cur + dir + list.length) % list.length];
  useRackView.getState().setFilter(next);
  return next;
}
