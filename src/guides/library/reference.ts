// Glossary and FAQ (guides-content-2). See research/14-sounds-and-guides.md §3 for the markup and the rules.
import type { GuideArticle } from '../articles';

export const REFERENCE: GuideArticle[] = [
  {
    id: 'glossary',
    title: 'Glossary',
    summary: 'Music and studio words from A to Z, one line each, with a link to the guide that explains them.',
    group: 'Help',
    icon: 'book',
    body: `
Every term in one line. Follow the link for the full story.

## 0–9

- **808**: a deep, tuned bass drum that doubles as the bassline in trap, drill and hip-hop. [[guide:bass-808|Bass & 808s]]

## A

- **ADSR / envelope**: how a sound's volume (or filter) moves over time: attack, decay, sustain, release. [[guide:sound-design|Sound design]]
- **Arpeggio**: a chord played one note at a time, in a pattern. [[guide:piano-roll|Piano Roll]]
- **Arrangement**: the order of sections that turns a loop into a song. [[guide:arrangement|Arrangement]]
- **Audio clip**: a piece of recorded audio placed on the Playlist. [[guide:playlist|Playlist]]
- **Automation clip**: a Playlist clip that moves a knob over time. [[guide:playlist|Playlist]]

## B

- **Bar**: one measure of music; in 4/4, four beats. [[guide:rhythm-tempo|Rhythm & tempo]]
- **Beat**: one pulse of the music, the thing you tap your foot to. [[guide:rhythm-tempo|Rhythm & tempo]]
- **BPM**: beats per minute, the tempo. [[guide:rhythm-tempo|Rhythm & tempo]]
- **Breakdown**: a quieter section where the drums or bass drop out. [[guide:arrangement|Arrangement]]
- **Bus**: a mixer insert that several channels play into, so you can process them together. [[guide:mixer|Mixer]]

## C

- **Channel**: one instrument or sample in the Channel Rack. [[guide:channel-rack|Channel Rack]]
- **Chop**: a piece cut out of a sample, or cutting notes into repeats. [[guide:sampling|Sampling & chopping]]
- **Chord**: three or more notes played together. [[guide:chords|Chords]]
- **Chord progression**: the order of chords in a section. [[guide:chords|Chords]]
- **Clipping**: distortion when a signal goes over 0 dB. [[guide:mix-levels|Levels]]
- **Closeness**: the 0 to 100 score of how near a song is to its reference: tempo, key, groove, harmony, arrangement, sounds and mix. [[guide:ai-results#make-something-like-a-song-you-love|AI results]]
- **Compression**: evening out a sound's loud and quiet parts. [[guide:compression|Compression]]
- **Crash**: a cymbal hit that marks the start of a section. [[guide:transitions|Transitions]]
- **Cut group**: channels that stop each other, like an open hat cut by a closed one. [[guide:channel-rack|Channel Rack]]

## D

- **dB (decibel)**: the unit for level; 6 dB is about twice the signal level. [[guide:mix-levels|Levels]]
- **Delay**: an echo of the sound, often in time with the beat. [[guide:space|Space]]
- **Downbeat**: the first beat of a bar. [[guide:rhythm-tempo|Rhythm & tempo]]
- **Downlifter**: a falling sweep that lets energy out at the start of a section. [[guide:transitions|Transitions]]
- **Drop**: the high-energy section that a build leads into. [[guide:arrangement|Arrangement]]
- **Drum fill**: a short break in the drum pattern at the end of a phrase. [[guide:drums|Drums]]
- **Dry / wet**: the untouched sound versus the effect; the **mix** knob blends them. [[guide:mixer|Mixer]]

## E

- **Effect chain**: several effects in a row on one insert, savable as a preset. [[guide:sounds-presets|Sounds & presets]]
- **EQ**: turning frequency ranges up or down. [[guide:eq|EQ]]
- **Export**: rendering your song to a WAV or MP3 file. [[guide:exporting|Exporting]]

## F

- **Factory sounds**: the samples that come with Krypt Studio, made by its own engine. [[guide:sound-packs|Sound packs]]
- **Filter**: cuts the highs (low-pass) or the lows (high-pass) of a sound. [[guide:sound-design|Sound design]]
- **Filter sweep**: a filter's cutoff moving over time, often before a drop. [[guide:transitions|Transitions]]
- **Fingerprint (sound matching)**: a few numbers that describe what a sound is like (brightness, attack, decay, pitch, noisiness), used to find the preset or sample closest to a sound in a song. [[guide:audio-to-project|Turn a song into a project]]
- **Formant**: the resonances that make a voice sound like itself; keeping them stops pitched vocals sounding cartoonish. [[guide:audio-tools|Audio tools]]

## G

- **Gain staging**: keeping levels sensible at every step, so nothing clips and nothing is too quiet. [[guide:mix-levels|Levels]]
- **Ghost note**: a very quiet drum hit between the main ones; in the Piano Roll, also the faint notes of other channels. [[guide:drums|Drums]]
- **Glide / slide**: a note bending smoothly into the next one, typical for 808s. [[guide:bass-808|Bass & 808s]]
- **Groove**: the timing and accents that make a pattern feel played, not programmed. [[guide:drums|Drums]]

## H

- **Half-time**: a feel where the snare lands half as often, so the beat feels slower at the same tempo. [[guide:rhythm-tempo|Rhythm & tempo]]
- **Headroom**: the space between your loudest peak and 0 dB. [[guide:mix-levels|Levels]]
- **Hook**: the catchiest part of a song, usually the chorus or the main melody. [[guide:melodies|Melodies & hooks]]

## I

- **Impact**: a boom or hit on the first beat of a section. [[guide:transitions|Transitions]]
- **Insert**: one strip in the Mixer, with its own fader and effects. [[guide:mixer|Mixer]]
- **Intro / outro**: the sections that open and close a song. [[guide:arrangement|Arrangement]]

## K

- **Key**: the home note and scale a song is built on, like A minor. [[guide:keys-scales|Keys & scales]]
- **KPN**: Krypt Pattern Notation, the short text format agents write patterns in. [[guide:ai-agents|AI agents]]
- **Krypt Tune**: Krypt Studio's pitch correction for vocals. [[guide:vocals|Vocals]]

## L

- **Latency / buffer size**: the delay between an action and its sound; a bigger buffer is safer but slower. [[guide:troubleshooting|Troubleshooting]]
- **LFO**: a slow, repeating movement applied to a knob, like a wobbling filter. [[guide:sound-design|Sound design]]
- **Limiter**: stops the level from going over a ceiling; the last effect on the master. [[guide:mastering|Mastering]]
- **Loop region**: the part of the Playlist that repeats while you work, set on the ruler. [[guide:playlist|Playlist]]
- **LUFS**: a loudness measurement that matches how loud music feels. [[guide:mastering|Mastering]]

## M

- **Marker**: a named flag on the Playlist ruler that marks a section. [[guide:arrangement|Arrangement]]
- **Master**: the final insert everything plays through. [[guide:mixer|Mixer]]
- **MCP**: the Model Context Protocol, how AI apps like Claude Code connect to Krypt Studio. [[guide:ai-agents|AI agents]]
- **MIDI**: notes as data (pitch, timing, velocity), not sound. [[guide:recording|Recording]]
- **Mode (musical)**: a flavour of scale, like dorian or phrygian. [[guide:keys-scales|Keys & scales]]
- **Mono**: one channel of sound, or a channel that plays one note at a time. [[guide:channel-rack|Channel Rack]]
- **More like this**: right-click a sound or preset in the Browser to list the closest sounds by timbre. [[guide:sounds-presets#more-like-this|Sounds & presets]]
- **Multisampler**: the instrument that plays the recorded sound packs. [[guide:sounds-presets|Sounds & presets]]

## O

- **One-shot**: a sample that plays once, like a single drum hit. [[guide:sampling|Sampling & chopping]]
- **Originality check**: compares your melodies with your deep-analysed reference songs. [[guide:reference-library|Reference library]]

## P

- **Pan**: where a sound sits from left to right. [[guide:mixer|Mixer]]
- **Pattern**: a short loop of notes and steps; songs are built from them. [[guide:getting-started|Getting started]]
- **Pattern mode / song mode**: loop the active pattern, or play the whole Playlist. [[guide:arrangement|Arrangement]]
- **Phrase**: a musical sentence, usually 4 or 8 bars. [[guide:arrangement|Arrangement]]
- **Piano Roll**: the grid where you draw and edit notes. [[guide:piano-roll|Piano Roll]]
- **Playbook**: the genre recipe agents follow to build a song. [[guide:ai-results|AI results]]
- **Playlist**: the timeline where you arrange the song. [[guide:playlist|Playlist]]
- **Preset**: a ready-made sound with all its settings. [[guide:sounds-presets|Sounds & presets]]

## Q

- **Quantize**: snapping notes to the grid. [[guide:piano-roll|Piano Roll]]

## R

- **Reference track**: a finished song you compare your own with. [[guide:ai-results|AI results]]
- **Render**: turning the project into audio, faster than real time. [[guide:exporting|Exporting]]
- **Reverb**: the sound of a room or hall around a sound. [[guide:space|Space]]
- **Reverse cymbal**: a cymbal played backwards that swells into a section. [[guide:transitions|Transitions]]
- **Riser**: a sound that climbs up to build tension before a drop. [[guide:transitions|Transitions]]
- **Root note**: the note a chord or a scale is named after; for a sample, the note it plays at. [[guide:keys-scales|Keys & scales]]

## S

- **Sample**: a piece of recorded or generated audio. [[guide:sampling|Sampling & chopping]]
- **Sampler**: the instrument that plays a sample from the keys or the steps. [[guide:sampling|Sampling & chopping]]
- **Scale**: the set of notes that belong to a key. [[guide:keys-scales|Keys & scales]]
- **Send**: a route that copies part of a channel to a shared effect, like one reverb for everything. [[guide:space|Space]]
- **Sidechain**: one sound controlling an effect on another, like the kick ducking the bass. [[guide:compression|Compression]]
- **Snap**: the grid notes and clips lock to while you drag. [[guide:piano-roll|Piano Roll]]
- **Snare roll**: snare hits getting faster and louder into a drop. [[guide:transitions|Transitions]]
- **Sound pack**: an optional download of recorded instruments or sounds. [[guide:sound-packs|Sound packs]]
- **Stems**: a song split into parts like drums, bass, vocals and other; in an export, one file per mixer insert. [[guide:audio-tools|Audio tools]] · [[guide:exporting#stems|Exporting stems]]
- **Step sequencer**: the grid of 16th-note steps in the Channel Rack. [[guide:channel-rack|Channel Rack]]
- **Stereo width**: how wide a sound feels between the speakers. [[guide:space|Space]]
- **Style focus**: a reference collection the AI composes in the style of. [[guide:reference-library|Reference library]]
- **Sub drop**: a low tone that falls in pitch on the first beat of a drop. [[guide:transitions|Transitions]]
- **Swell**: a sound that blooms up into the next section, like a reversed reverb. [[guide:transitions|Transitions]]
- **Swing**: pushing every second 16th note later for a bouncy feel. [[guide:rhythm-tempo|Rhythm & tempo]]

## T

- **Tape stop**: the sound slowing to a halt, like a tape machine switched off. [[guide:transitions|Transitions]]
- **Tempo sync (Follow tempo)**: stretching audio so it stays in time at any BPM. [[guide:audio-tools|Audio tools]]
- **Time signature**: how many beats are in a bar; most music is 4/4. [[guide:rhythm-tempo|Rhythm & tempo]]
- **Transcription**: writing the notes heard in audio into a pattern, as Convert to pattern and Open audio as project do. [[guide:audio-to-project|Turn a song into a project]]
- **Transient**: the sharp start of a sound, like a drum's attack. [[guide:compression|Compression]]
- **Transition**: anything that leads from one section into the next. [[guide:transitions|Transitions]]
- **Transpose**: moving notes up or down in pitch. [[guide:piano-roll|Piano Roll]]
- **Triplet**: three notes in the space of two. [[guide:rhythm-tempo|Rhythm & tempo]]
- **True peak**: the real highest level of a signal, between the samples. [[guide:mastering|Mastering]]

## V

- **Velocity**: how hard a note is played, which usually sets its loudness. [[guide:drums|Drums]]
- **Verse**: the section between hooks, often where the vocal tells the story. [[guide:arrangement|Arrangement]]
- **VST3 / CLAP**: plugin formats for third-party instruments and effects. [[guide:sounds-plugins|Sounds & plugins]]

## W

- **Whoosh**: air rushing past, used across a section change. [[guide:transitions|Transitions]]
`,
  },
  {
    id: 'faq',
    title: 'FAQ',
    summary: 'Free? Offline? Where are my files? Sharing projects, releasing your music, SmartScreen warnings and getting help.',
    group: 'Help',
    icon: 'lifebuoy',
    body: `
## Is Krypt Studio really free?

Yes. No price, no account, no ads, no subscription and no telemetry. Krypt Studio is part of Krypt's free tools.

## What does "MIT-licensed" mean for me?

Krypt Studio's source code is open, under the MIT licence. You may use the app for anything, including commercial work, and you may copy, change and share it, as long as the licence notice stays with it. The licence covers the app, not your music: what you make is yours.

## Which computers does it run on?

Windows 10 and 11, 64-bit. There is no Mac or Linux version.

## Does it work offline?

Yes. Making music, the audio engine, the factory sounds and presets, exporting, and the audio tools all run on your PC. You need an internet connection only for:

- AI agents, because the AI itself runs at the service of the app you use (Claude Code, the built-in chat and so on);
- downloading sound packs and the stem model, once;
- the links in the Help menu.

## Where are my files?

| What | Where |
|---|---|
| Your projects (\`.kstudio\`) | Wherever you save them. Save and open dialogs start in your project's folder, else in your last project's, else in Documents |
| Audio recordings | A **recordings** folder next to the project |
| Exports | Wherever you choose in the Export dialog. Exports by agents go to **Music ▸ Krypt Studio** |
| Your presets | The app's data folder. **Home ▸ Sounds & Plugins ▸ Your presets folder** opens it |
| Settings, sound packs, models, the reference library, backups and crash recovery | The app's data folder: \`%APPDATA%\\Krypt Studio\` |

Uninstalling Krypt Studio keeps the data folder, so your presets, packs and library are still there after a reinstall. Delete the folder yourself if you want them gone.

## How do I share a project?

A \`.kstudio\` file holds the project and its cover image, but not your audio files.

- **Factory sounds** are found on any PC that has Krypt Studio.
- **Sound pack sounds** come back on any PC with the same pack. If it's missing, the project says which one to download.
- **Your own samples and recordings** travel with the project when they sit in or under its folder. Send the whole folder (zip it), and Krypt Studio relinks them on the other PC. Anything missing is named when the project opens.

Just want someone to hear it? Export an MP3 ([[Ctrl+R]]).

## Can I open projects from other DAWs?

Not directly. Bring the parts in instead: MIDI files with **File ▸ Import MIDI…**, and audio or stems by dragging them onto the Playlist.

## Can I use my beats commercially?

Yes. You own the music you make in Krypt Studio, and Krypt claims nothing.

- **Factory sounds and presets** are original to Krypt Studio and MIT-licensed. Use them in anything, without credit.
- **Sound packs** are CC0 or public domain, so you can use them in released music too. Some authors politely ask for credit, or that you don't resell the raw samples. Each pack's \`LICENSE.txt\` says so.
- **Your own samples** follow whatever licence they came with.
- **Songs made with AI**: the AI writes original parts, but you're responsible for what you release. If you used a reference song, run the originality check, and never release a mashup of other people's records without their permission.

See [[guide:sound-packs#using-the-sounds-in-music-you-release|Using the sounds in music you release]].

## Why does Windows say "Windows protected your PC"?

The installer isn't code-signed yet, and Windows SmartScreen warns about unsigned apps it hasn't seen often. Click **More info**, then **Run anyway**. Every release is built from the public source code, so you can check what you're running.

## Smart App Control blocks it

On Windows 11 with **Smart App Control** turned on, unsigned apps can be blocked outright, with no "Run anyway" button. You can build Krypt Studio from its source code instead, or wait for signed releases. Turning Smart App Control off affects every app on your PC, so read Windows' own notes before you change it.

## Do I need an AI subscription?

No. Everything except the AI agents works without one. To use agents, you need an app that supports MCP, such as Claude Code, Claude Desktop, Cursor or VS Code (under that app's own plans), or your own API key from Anthropic, OpenAI or OpenRouter for the built-in chat. See [[guide:ai-agents|AI agents]].

## Can I use my VST plugins?

VST3 and CLAP plugins, yes: the Plugin Manager finds them. VST2 plugins aren't supported. See [[guide:sounds-plugins|Sounds & plugins]].

## How do I update?

Krypt Studio doesn't update itself yet. Download the new installer from krypt.cc (Help ▸ **krypt.cc**) and run it over your current version. Your projects, settings and downloads stay where they are.

## Something isn't working

Start with [[guide:troubleshooting|Troubleshooting]]: it covers no sound, engine restarts, crashed plugins, missing models and audio files that won't open.

## Getting help

Ask on the Krypt Discord, linked in the **Help** menu and on the About page. Bug reports with the steps to repeat them help the most.

[[show:titlebar.help|Show me the Help menu]]
`,
  },
];
