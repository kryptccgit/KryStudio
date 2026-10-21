// The Auto Mix & Master guide (research/20). Kept in its own file; articles.ts
// lists it in the Mixing group. Pure data.

import type { GuideArticle } from './articles';

export const AUTOMIX_ARTICLE: GuideArticle = {
  id: 'auto-mix',
  title: 'Auto Mix & Master',
  summary: 'One button for the vocals, the whole mix or the master: from a preset or a prompt, measured, with an honest before and after.',
  group: 'Mixing',
  icon: 'sparkles',
  body: `
**Auto Mix** mixes your vocals, your whole song or your master without an AI agent. You pick a preset or describe the sound in plain words. Krypt renders the song, measures it, and sets real knobs on real effects. Then it measures again and fine-tunes until it hits the target, up to three passes. You get the numbers before and after, a list of every change, and a Before / After switch. The whole run is **one undo step**.

[[action:autoMix|Open Auto Mix…]] [[action:masterSong|Master a song file…]] [[show:automix.open|Show me the button]]

{{video:automix}}

## Open it

- **Mixer ▸ Auto Mix** in the Mixer's toolbar.
- **Auto** on the Master strip opens it in Master mode.
- **Tools ▸ Auto Mix…** in the title bar.
- Right-click an audio clip on the Playlist ▸ **Auto-mix this vocal…**. That opens Vocals mode with that clip's track as the vocal.
- **Home ▸ Audio Tools ▸ Master a song…** masters a finished audio file (see below).

[[show:automix.master|Show me Auto Master]]

## The four modes

| Mode | What it works on | What it does |
|---|---|---|
| **Vocals** | The vocal tracks only | Clean-up EQ (low cut, mud cut, presence and air), the Krypt De-Esser, compression sized to the vocal, the level against the beat, reverb and delay sends, and a little room carved for the vocal in the busiest part of the beat |
| **Mix** | Every insert | Gain staging, EQ and compression by role (drums, bass, keys, vocals…), glue on the drum bus, the bass ducking under the kick when they clash, and space for the vocals. It leaves about 6 dB of headroom on the Master for mastering |
| **Master** | The Master only | EQ toward the preset's tone curve, glue, warmth, width with the low end in mono, then the limiter to the loudness target under the true-peak ceiling |
| **Mix + Master** | Everything | Mix first, then master |

Vocals are found from track names, stems you separated and what the audio sounds like. From the clip menu, you choose them yourself.

[[show:automix.modes|Show me the modes]]

## Presets

Each card shows a name, a **loudness target** in LUFS and a tiny **tone curve**: how much sub, low, mid and high it aims for, compared with the mids. **Auto** comes first. It picks a preset from your project's genre (Project info) and what Krypt hears in the song.

| Preset | Target | For |
|---|---|---|
| Streaming Clean | −14 LUFS | Open, dynamic, at the level streaming plays at |
| Balanced | −11 LUFS | A safe all-rounder |
| Loud Trap / Drill, Club / EDM | −8 LUFS | Big low end, loud |
| Pop Polish, Hip-Hop Punch | −9 LUFS | Bright and loud, or hard drums |
| Warm R&B | −11 LUFS | Smooth top, close vocal |
| Rock / Live | −10 LUFS | Natural dynamics |
| Lo-fi | −13 LUFS | Dark, soft, nothing sharp |
| Podcast / Voice | −16 LUFS | Clear speech |
| Phonk Slam | −7 LUFS | As loud as it gets |

[[show:automix.presets|Show me the presets]]

## Describe it in your own words

The prompt box is optional. Write what you want on top of the preset, or click an example:

- "vocals on top, not harsh"
- "loud for the club"
- "warm and wide"
- "darker, less reverb, −9 LUFS"

As you type, a line under the box says how Krypt understood it, such as "Understood as: louder, vocals forward, less harsh". A badge says who read it. **AI** means your connected AI read it. **Keywords** means Krypt's built-in reader did, which knows words like louder, quieter, brighter, darker, warmer, punchy, wide, mono, bass, vocals up, reverb, dry, harsh, clean, club and streaming. Nothing changes until you click Run.

[[show:automix.prompt|Show me the prompt box]]

## The options

| Option | What it does |
|---|---|
| **Target loudness (LUFS)** | The loudness (in LUFS) the master aims for. It starts at the preset's or the prompt's target; the arrow resets it. Master and Mix + Master only |
| **Peak limit (no clipping)** | The highest the peaks may go (the true peak, in dBTP), so nothing clips. −1 is safe for streaming, because MP3 and AAC conversions add a little peak |
| **Measure** | **Loudest part** (the loudest 32 bars, or the whole song when it is short; faster), **Whole song**, or a **Bars** range |
| **Keep my effects** | On: Krypt only adds and adjusts its own marked slots and never touches yours. Off: it may replace your effects too |
| **Let the connected AI read the prompt** | Off: the built-in keyword reader only |

[[show:automix.options|Show me the options]] [[show:automix.run|Show me the Run button]]

## Run, then compare honestly

Click Run. A window ticks off the stages: rendering and measuring, reading your prompt, planning, setting the knobs, then measuring again and fine-tuning. **Cancel** stops it and leaves your mix as it was. You can close the window and it keeps going.

The result shows:

- **Before and after** (under **Details**): loudness (LUFS), peak (no clipping below 0), vocal against the beat, and loudness range.
- **Tone:** the curve before (dashed), after (the gradient line) and the preset's target (dotted).
- **What changed:** every setting, by track, in plain words, such as "Vocals: Krypt EQ: cut 2.5 dB at 320 Hz (mud)".
- **Good to know:** honest limits, such as "No vocals found" or "Loudness capped: more would distort".

**Before / After** switches the whole run off and on while the song plays. Be honest with your ears: **louder always sounds better at first**. A mastered song is usually several dB louder than your mix, so the window tells you how much louder After is. Turn your speakers down by that much while you listen to After, and you will hear what really changed.

Then choose **Keep**, **Undo** (switches the run off; Edit ▸ History can bring it back) or **Export…**. Closing the window keeps the result.

[[show:automix.ab|Show me the Before / After switch]]

## Master a song file

**Home ▸ Audio Tools ▸ Master a song…** masters a finished song you already have, such as a WAV or MP3. The window has numbered steps:

1. **Your song:** click **Choose your song…** (or drop the file). It shows the song's name and length; nothing runs yet. [[show:automix.song|Show me]]
2. **Pick a style:** a preset, or Auto.
3. **Sound like a song you love (optional):** a reference song (below).

**More options** holds the prompt and the loudness settings. Then click **Master my song**: it's greyed out, with the reason next to it, until step 1 is done. A list ticks off each step while it works. The song opens in a new project tab, so your current project stays open and the file itself is never changed. The result starts with a one-line **Done!** headline and three next steps: listen Before / After, **Keep**, **Export…**. The numbers are under **Details**. **Export…** opens the export dialog with Normalize turned off, because it would push the peaks past the limit.

[[show:home.masterSong|Show me the Audio Tools card]] [[action:export|Export audio…]]

New to this? [[guide:step-master|Master your song (step by step)]] walks through every click.

## Match a song you love (reference)

The **Sound like a song you love (optional)** step in Master a song (and the same row in Master and Mix + Master mode) takes a finished song whose sound you want: click **Pick a reference song…** or drop the file on it. Krypt measures it, never copies it, and the preset title changes to **Matching:** and its name. It can't be the song you're mastering (it would match itself): the row says so and leaves it out.

- **Tone:** your song moves toward the reference's balance of sub, low, mid and high, instead of the preset's curve. A preset you pick still adds its intent on top.
- **Loudness:** the target becomes the reference's loudness, between −20 and −6 LUFS (set **Target loudness** yourself to go further). If your song would distort before it gets there, Krypt stops and says so in **Good to know**.
- **Width** follows the reference, with the low end kept in mono. The true-peak ceiling stays at −1 dBTP unless you change it.

The result adds the reference's tone curve to the overlay and says how much closer it got. **Compare** gets a **Reference** button that plays the reference turned to the same loudness, so the louder one doesn't win by volume.

[[show:automix.reference|Show me the Reference song row]]

## Master an album

**Home ▸ Audio Tools ▸ Master an album…** masters 2 to 20 songs as one record, with the same numbered steps: **Choose your songs…** and put them in order, pick one style (or one reference) for all of them, then **Master my album**. They open in one new tab, back to back with a marker on each, and every song gets its own mastering chain on its own track.

- **Tone:** each song moves toward the target and toward the album's average, so it sounds like one record, not twelve different EQs.
- **Keep the album's dynamics** (on by default): the loudest song hits the target and the quieter ones (intros, slow songs) keep their distance, up to 4 LU below. Off: every song hits the target.
- **The result:** a **Done!** headline, then one row per song with its loudness and peak before and after and a ▶ to play it, with Before / After. **Keep** and **Undo** work on the whole album as one step.
- **Export all** asks for a folder and writes one file per song, named \`<song> (mastered)\`.

[[action:masterSong|Master a song…]] [[show:home.masterSong|Show me]]

## Honest limits

- **It can't fix a bad recording.** Noise, clipping, room echo and a vocal recorded too quietly stay in the audio.
- **Presets are starting points.** Your song isn't the average song of its genre. Trust your ears over the numbers, and change any knob it set.
- **Loud costs punch.** Past about −8 LUFS, drums lose their snap. Krypt stops before it distorts and says so.
- **Vocal detection is a guess.** Name your vocal tracks "Vocal" or "Vox", or use the clip menu, to be sure.
- **Krypt Tune isn't switched on** unless the preset or your prompt asks for it.

## Ask an agent

Agents can run the same thing with the \`auto_mix\` tool: "Auto-mix my vocals, warm and close" or "Master this for streaming at −14 LUFS". An agent can measure and plan first without changing anything (a dry run), and fine-tune by hand afterwards with the mixer tools. Everything it does is in Edit ▸ History. See [[guide:ai-agents|AI agents]].

For the craft behind it, see [[guide:mastering|Mastering and loudness]] and [[guide:mix-levels|Levels and gain staging]].
`,
};
