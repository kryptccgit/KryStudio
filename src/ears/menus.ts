import { AudioWaveform, Drum, Layers, ListMusic, Magnet, MicVocal, Music2, Piano, TimerOff } from 'lucide-react';
import type { AudioTarget } from '@shared/types';
import { TUNE_STYLES, type TuneStyle } from '@shared/music/keymatch';
import type { MenuItem } from '../components/Menu';
import { getProject } from '../doc/store';
import { getAnalyzerState } from '../panels/modelManager/store';
import { TRANSCRIBE_MODES, firstClipOfChannel, fmtBpm, installedStemModels, matchTargets, stemLabel, stemMode, targetPath } from './logic';
import { openAudioAsProject } from '../audioProject/actions';
import { audioClipCanFollowTempo, convertToPattern, separateStems, stopFollowingTempo } from './actions';
import { autoTuneVocal, matchClipTo } from './vocals';
import { openAnalysisDialog } from './AnalysisDialog';

const MODE_ICON = { poly: Piano, mono: Music2, drums: Drum } as const;

function convertItems(target: AudioTarget, doc?: Document | null): MenuItem[] {
  const p = getProject();
  const path = targetPath(p, target);
  const best = stemMode(p, target);
  const modes = best ? [...TRANSCRIBE_MODES].sort((a, b) => Number(b.mode === best) - Number(a.mode === best)) : TRANSCRIBE_MODES;
  return [
    { type: 'header', label: 'One part (a stem, a loop, one instrument)' },
    ...modes.map((m): MenuItem => ({
      label: m.mode === best ? `${m.label} (best for this stem)` : m.label,
      detail: m.detail,
      icon: MODE_ICON[m.mode],
      onSelect: () => void convertToPattern(target, m.mode),
    })),
    { type: 'separator' },
    {
      label: 'Whole song → parts…',
      icon: ListMusic,
      detail: path ? 'A full mix: split into drums, bass, chords and vocals first, each written on its own' : 'Needs an audio file on disk',
      hint: 'Opens Audio → Project. Or use Separate stems here, then convert each stem.',
      disabled: !path,
      onSelect: () => path && openAudioAsProject(path, doc),
    },
  ];
}

function separateItem(clipId: string | null): MenuItem {
  if (!clipId)
    return {
      label: 'Separate stems',
      icon: Layers,
      disabled: true,
      detail: 'Place it in the Playlist first',
      onSelect: () => {},
    };
  const models = installedStemModels(getAnalyzerState());
  if (models.length > 1)
    return {
      type: 'submenu',
      label: 'Separate stems',
      icon: Layers,
      items: [
        { type: 'header', label: 'Separate with' },
        ...models.map((m) => ({
          label: m.name,
          detail: m.stems?.length ? m.stems.map(stemLabel).join(' · ') : undefined,
          onSelect: () => void separateStems(clipId, m.id),
        })),
      ],
    };
  return {
    label: 'Separate stems',
    icon: Layers,
    hint: models.length ? `Split into ${models[0].stems?.map(stemLabel).join(', ') ?? 'stems'} on new tracks under the clip (${models[0].name})` : 'Needs a stem model from the Model Manager',
    onSelect: () => void separateStems(clipId),
  };
}

export function earsMenuItems(target: AudioTarget, opts: { clipId?: string | null; doc?: Document | null } = {}): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Detect tempo & key', icon: AudioWaveform, hint: 'Tempo, key, swing, sections and loudness', onSelect: () => openAnalysisDialog(target, opts.doc) },
  ];
  if (!('path' in target)) items.push(separateItem(opts.clipId ?? null));
  items.push({ type: 'submenu', label: 'Convert to pattern', icon: Piano, items: convertItems(target, opts.doc) });
  return items;
}

function tuneItem(target: AudioTarget): MenuItem {
  return {
    type: 'submenu',
    label: 'Tune vocal',
    icon: MicVocal,
    items: [
      { type: 'header', label: 'Krypt Tune, key detected' },
      ...(Object.keys(TUNE_STYLES) as TuneStyle[]).map((style) => ({
        label: TUNE_STYLES[style].label,
        detail: `${TUNE_STYLES[style].detail} (retune ${TUNE_STYLES[style].speed} ms)`,
        onSelect: () => void autoTuneVocal(target, style),
      })),
    ],
  };
}

function matchItem(clipId: string): MenuItem {
  const p = getProject();
  const others = matchTargets(p, clipId);
  return {
    type: 'submenu',
    label: 'Match key & tempo to',
    icon: Magnet,
    items: [
      { label: 'Project', detail: `${fmtBpm(p.transport.bpm)} BPM and the key of your patterns or other audio`, onSelect: () => void matchClipTo(clipId, 'project') },
      ...(others.length
        ? [{ type: 'header' as const, label: 'Another clip: its key and tempo' }, ...others.map((o) => ({ label: o.label, detail: o.detail, onSelect: () => void matchClipTo(clipId, { clipId: o.clipId }) }))]
        : []),
    ],
  };
}

export function clipEarsItems(clipId: string, doc?: Document | null): MenuItem[] {
  return [...earsMenuItems({ clipId }, { clipId, doc }), tuneItem({ clipId }), matchItem(clipId)];
}

export function channelEarsItems(channelId: string, doc?: Document | null): MenuItem[] {
  const p = getProject();
  const ch = p.channels[channelId];
  if (!ch || !ch.generator.sampleId) return [];
  const type = ch.generator.type;
  if (type !== 'krypt.audioclip' && type !== 'krypt.sampler') return [];
  const items = earsMenuItems({ channelId }, { clipId: type === 'krypt.audioclip' ? firstClipOfChannel(p, channelId) : null, doc });
  if (type === 'krypt.sampler') return items.filter((it) => !('label' in it && it.label === 'Separate stems'));
  if (audioClipCanFollowTempo() && Math.round(ch.generator.params.tempo_sync ?? 0) === 1)
    items.push({ label: 'Stop following project tempo', icon: TimerOff, onSelect: () => void stopFollowingTempo(channelId) });
  const first = firstClipOfChannel(p, channelId);
  items.push(tuneItem(first ? { clipId: first } : { channelId }));
  if (first) items.push(matchItem(first));
  return items;
}

export function fileEarsItems(path: string, doc?: Document | null): MenuItem[] {
  return [{ label: 'Detect tempo & key', icon: AudioWaveform, hint: 'Tempo, key, swing, sections and loudness of this file', onSelect: () => openAnalysisDialog({ path }, doc) }];
}
