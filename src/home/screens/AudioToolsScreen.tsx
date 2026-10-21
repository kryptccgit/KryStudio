import { AudioLines, AudioWaveform, Blend, BrainCircuit, Cloud, Cpu, Disc3, Gauge, ListMusic, Magnet, MicVocal, Music, Scissors, WandSparkles, type LucideIcon } from 'lucide-react';
import { shortcutFor } from '../../input/keymap';
import type { ModelTask } from '@shared/analyzer/models';
import type { AnalyzerState } from '@shared/types';
import { useAnalyzer } from '../../panels/modelManager/store';
import { cls } from '../../utils/format';
import { runHomeAction } from '../actions';
import { audioToolsPill, masterCardActions } from '../logic';
import { useVoice } from '../../voice/store';
import { ensureVoiceState } from '../../voice/actions';
import { useEffect } from 'react';
import { goBack, openGuides } from '../store';
import { GlassPanel, HomeButton, IconTile, Kbd, PillBadge, ScreenFrame, ScreenHeader } from '../ui';

type Need = { task: ModelTask; label: string } | null;

const TOOLS: Array<{ icon: LucideIcon; title: string; menu: string; body: string; need: Need }> = [
  {
    icon: Gauge,
    title: 'Detect tempo & key',
    menu: 'Detect tempo & key',
    body: 'Tempo (with half and double-time readings), key, swing, sections and loudness. Use the tempo for your project in one click, or make the clip follow it.',
    need: null,
  },
  {
    icon: Scissors,
    title: 'Separate stems',
    menu: 'Separate stems',
    body: 'Splits a clip into drums, bass, vocals and other, each on a new track lined up under the original.',
    need: { task: 'stems', label: 'HT-Demucs' },
  },
  {
    icon: Music,
    title: 'Audio to pattern',
    menu: 'Convert to pattern',
    body: 'Writes what it hears into a new pattern: Melody & chords, Single line, or Drums. Works best on a stem.',
    need: { task: 'transcribe', label: 'Basic Pitch (for Melody & chords)' },
  },
  {
    icon: MicVocal,
    title: 'Tune vocal',
    menu: 'Tune vocal',
    body: 'Krypt Tune, first in the vocal’s effects and set to the key it detects: Natural keeps it human, Pop is tight, Hard is the robotic trap sound.',
    need: null,
  },
  {
    icon: Magnet,
    title: 'Match key & tempo',
    menu: 'Match key & tempo to',
    body: 'Pitches a vocal onto the key of your project or another song by the smallest step, and makes it follow the tempo. The start of every mashup.',
    need: null,
  },
];

function needState(a: AnalyzerState | null, task: ModelTask): 'installed' | 'missing' | 'unknown' {
  if (!a) return 'unknown';
  const ms = a.models.filter((m) => m.def.task === task);
  if (!ms.length) return 'unknown';
  return ms.some((m) => m.status === 'installed') ? 'installed' : 'missing';
}

function AudioToProjectCard({ analyzer }: { analyzer: AnalyzerState | null }) {
  const st = needState(analyzer, 'stems');
  const keys = shortcutFor('file.openAudioProject');
  return (
    <GlassPanel className="relative mt-4 overflow-hidden p-5" label="Audio → Project">
      <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-krypt-gradient opacity-60" />
      <div className="flex flex-wrap items-start gap-4">
        <IconTile icon={AudioLines} accent />
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-white">
            Audio → Project {keys && <Kbd>{keys}</Kbd>}
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-krypt-muted">
            Open any song as an editable project: its tempo, key and sections, drums, bass, chords and lead written as patterns on the closest matching sounds, vocals as audio. Change anything. Drums and bass come out best; dense chords and synth sounds are rougher.
          </p>
          <div className={cls('mt-2 flex items-center gap-1.5 text-[11.5px]', st === 'installed' ? 'text-emerald-300' : st === 'missing' ? 'text-amber-300' : 'text-krypt-muted')}>
            <Cpu className="h-3 w-3" aria-hidden="true" />
            {st === 'installed'
              ? 'HT-Demucs: installed, so every part is read from its own stem'
              : st === 'missing'
                ? 'Works best with HT-Demucs: install it in the Model Manager (without it, parts are read from the full mix)'
                : 'Works best with HT-Demucs (stems)'}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <HomeButton kind="quiet" onClick={() => openGuides('audio-to-project')}>
            How it works
          </HomeButton>
          <HomeButton kind="primary" icon={AudioLines} onClick={() => runHomeAction('audioProject')}>
            Open audio as project…
          </HomeButton>
        </div>
      </div>
    </GlassPanel>
  );
}

function AutoMashupCard({ analyzer }: { analyzer: AnalyzerState | null }) {
  const st = needState(analyzer, 'stems');
  return (
    <div data-guide="home.autoMashup" className="mt-3 rounded-2xl">
      <GlassPanel className="relative overflow-hidden p-5" label="Auto Mashup">
        <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-krypt-gradient opacity-60" />
        <div className="flex flex-wrap items-start gap-4">
          <IconTile icon={Blend} accent />
          <div className="min-w-0 flex-1 basis-72">
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-white">Auto Mashup</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-krypt-muted">
              Two songs, one mashup: one song's vocal over the other's beat, a blend of stems from both, or the two trading sections. Krypt scores how well they fit, matches their tempo and key, lays out the sections, tunes the vocal with Krypt Tune and mixes it, as one editable project.
            </p>
            <div className={cls('mt-2 flex items-center gap-1.5 text-[11.5px]', st === 'installed' ? 'text-emerald-300' : st === 'missing' ? 'text-amber-300' : 'text-krypt-muted')}>
              <Cpu className="h-3 w-3" aria-hidden="true" />
              {st === 'installed'
                ? 'HT-Demucs: installed, so vocals and beats are separated cleanly'
                : st === 'missing'
                  ? 'Vocal over beat and Stem blend need HT-Demucs: install it in the Model Manager (Back & forth works without it)'
                  : 'Vocal over beat and Stem blend use HT-Demucs (stems)'}
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            <HomeButton kind="quiet" onClick={() => openGuides('auto-mashup')}>
              How it works
            </HomeButton>
            <HomeButton kind="primary" icon={Blend} onClick={() => runHomeAction('autoMashup')}>
              Make a mashup…
            </HomeButton>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}

function MasterSongCard() {
  const { song, album } = masterCardActions();
  return (
    <div data-guide="home.masterSong" className="mt-3 rounded-2xl">
      <GlassPanel className="relative overflow-hidden p-5" label="Master a song">
        <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-krypt-gradient opacity-60" />
        <div className="flex flex-wrap items-start gap-4">
          <IconTile icon={WandSparkles} accent />
          <div className="min-w-0 flex-1 basis-72">
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-white">Master a song</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-krypt-muted">
              Pick a preset like Streaming Clean or Loud Trap, or describe it ("loud for the club", "warm and wide"), then choose a finished song. Krypt opens it in a new tab, sets tone, glue, width and loudness to the target under a true-peak ceiling, shows before and after, and offers the export.
            </p>
            <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-krypt-muted">
              <Cpu className="h-3 w-3" aria-hidden="true" />
              Measured and mastered on your PC. For a project, use Auto Mix in the Mixer.
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            <HomeButton kind="quiet" onClick={() => openGuides('auto-mix')}>
              How it works
            </HomeButton>
            {album && (
              <HomeButton kind="ghost" icon={Disc3} onClick={() => runHomeAction(album)} title="Master several songs so they sound like one record">
                Master an album…
              </HomeButton>
            )}
            <HomeButton kind="primary" icon={WandSparkles} onClick={() => runHomeAction(song)} title="Master one finished song (WAV, MP3, FLAC…). It opens in a new tab.">
              Master a song…
            </HomeButton>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}

function KryptVoiceCard() {
  const v = useVoice((s) => s.state);
  useEffect(() => {
    void ensureVoiceState();
  }, []);
  const local = v?.local.installed;
  const fish = v?.fish.keySet;
  return (
    <div data-guide="home.kryptVoice" className="mt-3 rounded-2xl">
      <GlassPanel className="relative overflow-hidden p-5" label="Krypt Voice">
        <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-krypt-gradient opacity-60" />
        <div className="flex flex-wrap items-start gap-4">
          <IconTile icon={MicVocal} accent />
          <div className="min-w-0 flex-1 basis-72">
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-white">Krypt Voice</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-krypt-muted">
              Type it and a voice says it in your song: ad-libs, tags, intros, guide vocals. Or type lyrics in the Piano Roll and Sing my notes puts them on your melody, with Krypt Tune for the tuned sound. Speech voices aren't trained singers, so treat it as a sketch or an effect.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
              <span className={cls('flex items-center gap-1.5', local ? 'text-emerald-300' : v ? 'text-amber-300' : 'text-krypt-muted')}>
                <Cpu className="h-3 w-3" aria-hidden="true" />
                {local ? 'Local voices: ready, on your PC' : v ? 'Local voices: install Kokoro in the Model Manager' : 'Local voices run on your PC (Kokoro)'}
              </span>
              <span className={cls('flex items-center gap-1.5', fish ? 'text-sky-300' : 'text-krypt-muted')}>
                <Cloud className="h-3 w-3" aria-hidden="true" />
                {fish ? 'Cloud voices: your Fish Audio key is set' : 'Cloud voices (optional): your own Fish Audio key, text is sent there'}
              </span>
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            <HomeButton kind="quiet" onClick={() => openGuides('krypt-voice')}>
              How it works
            </HomeButton>
            <HomeButton kind="primary" icon={MicVocal} onClick={() => runHomeAction('kryptVoice')}>
              Make a voice…
            </HomeButton>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}

export function AudioToolsScreen() {
  const a = useAnalyzer((s) => s.state);
  const pill = audioToolsPill(a);
  const installed = a?.models.filter((m) => m.status === 'installed').length ?? 0;
  const gpu = a?.devices.includes('directml');
  return (
    <ScreenFrame label="Audio Tools">
      <ScreenHeader
        icon={AudioWaveform}
        title="Audio Tools"
        subtitle="Listen to audio on your PC: tempo and key, stems, vocal tuning, matching, and audio into notes. Your audio never leaves this computer."
        onBack={goBack}
        right={
          <div className="mt-1 flex flex-wrap gap-2">
            <HomeButton kind="quiet" onClick={() => openGuides('audio-tools')}>
              Read the guide
            </HomeButton>
            <HomeButton kind="quiet" icon={MicVocal} onClick={() => openGuides('vocals')}>
              Vocals & mashups
            </HomeButton>
          </div>
        }
      />

      <GlassPanel className="mt-7 flex flex-wrap items-center gap-3 p-5" label="Analyzer status">
        <IconTile icon={BrainCircuit} accent />
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-white">{!a ? 'Checking the analyzer…' : a.available ? 'Analyzer ready' : 'Analyzer missing'}</span>
            <PillBadge pill={pill} />
          </div>
          <p className="mt-0.5 text-[12px] text-krypt-muted">
            {!a
              ? 'Asking the app…'
              : !a.available
                ? 'krypt-studio-analyzer.exe wasn’t found next to the app. Reinstall Krypt Studio to get the audio tools back.'
                : `${installed} of ${a.models.length} models installed. ${
                    a.devices.length ? (gpu ? 'Stems run on your GPU (DirectML).' : navigator.userAgent.includes('Windows') ? 'No DirectX 12 GPU found: stems run on the CPU, which is slower.' : 'Stems run on the CPU here, which takes a few minutes per song.') : 'The device is picked when the first job starts.'
                  }`}
          </p>
        </div>
        <HomeButton kind="primary" icon={BrainCircuit} onClick={() => runHomeAction('modelManager')}>
          Model Manager
        </HomeButton>
      </GlassPanel>

      <AudioToProjectCard analyzer={a} />
      <AutoMashupCard analyzer={a} />
      <MasterSongCard />
      <KryptVoiceCard />

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {TOOLS.map((t) => {
          const st = t.need ? needState(a, t.need.task) : 'installed';
          return (
            <GlassPanel key={t.title} className="flex flex-col p-5" label={t.title}>
              <IconTile icon={t.icon} />
              <h2 className="mt-3 text-[15px] font-bold text-white">{t.title}</h2>
              <p className="mt-1 flex-1 text-[12.5px] leading-relaxed text-krypt-muted">{t.body}</p>
              <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/30 px-3 py-2 text-[11.5px] text-white/75">
                Right-click an audio clip ▸ <span className="font-semibold text-white">{t.menu}</span>
              </div>
              {t.need && (
                <div className={cls('mt-2 flex items-center gap-1.5 text-[11.5px]', st === 'installed' ? 'text-emerald-300' : st === 'missing' ? 'text-amber-300' : 'text-krypt-muted')}>
                  <Cpu className="h-3 w-3" aria-hidden="true" />
                  {st === 'installed' ? `${t.need.label}: installed` : st === 'missing' ? `Needs ${t.need.label}: install it in the Model Manager` : `Uses ${t.need.label}`}
                </div>
              )}
            </GlassPanel>
          );
        })}
      </div>

      <GlassPanel className="mt-4 flex flex-wrap items-center gap-3 p-5" label="Where to start">
        <IconTile icon={ListMusic} />
        <p className="min-w-0 flex-1 basis-60 text-[12.5px] leading-relaxed text-krypt-muted">
          Drop a song or loop on the <span className="font-semibold text-white">Playlist</span>, then right-click the clip. To make an audio clip follow your project's tempo, stretch it or change its pitch, open its channel from the Channel Rack and use <span className="font-semibold text-white">Stretch & pitch</span>.
        </p>
        <HomeButton kind="ghost" icon={ListMusic} onClick={() => runHomeAction('playlist')}>
          Open the Playlist
        </HomeButton>
      </GlassPanel>
    </ScreenFrame>
  );
}
