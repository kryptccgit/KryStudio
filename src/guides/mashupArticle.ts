// The Auto Mashup guide (research/18). Kept in its own file; articles.ts
// lists it after "Vocals, tuning & mashups". Pure data.

import type { GuideArticle } from './articles';

export const MASHUP_ARTICLE: GuideArticle = {
  id: 'auto-mashup',
  title: 'Auto Mashup',
  summary: 'Two songs into one mashup project: vocal over beat, a stem blend, or the two trading sections, on one tempo and key.',
  group: 'AI and audio',
  icon: 'layers',
  body: `
**Auto Mashup** makes one mashup from two songs. It reads both songs on your PC and tells you how well they fit before it changes anything. Then it builds the mashup as a normal, editable project: audio clips per section, markers, a vocal chain with Krypt Tune, the beat carved under the vocal, and transitions. The whole build is **one undo step**.

[[action:autoMashup|Make a mashup…]] [[show:home.autoMashup|Show me the card]]

{{video:mashup}}

## Open it

- **Home ▸ Audio Tools ▸ Auto Mashup ▸ Make a mashup…**
- **Tools ▸ Auto Mashup…** in the Studio.
- Right-click an audio clip on the Playlist ▸ **Mashup with…**. That clip becomes song A, so you only pick song B.

## Pick the two songs

Each slot, **A** and **B**, takes:

- **Choose a file…:** any WAV, MP3, M4A, FLAC or other audio file on your PC.
- **From this project…:** an audio clip already on the Playlist.
- **From your library:** a track from your reference library, if you've imported some.

The arrows between the slots swap A and B. The stem grid and "vocal from" swap with them.

[[show:mashup.songs|Show me the song slots]]

## How well do they fit?

Once both songs are in, Krypt listens to them. The first time takes about 10 seconds a song. You then see:

- **A fit score** from 0 to 100. It weighs how far each song must be stretched, how far apart the keys are, how the sections line up, and who has a vocal.
- **Each song's reading:** its tempo, its key and how much of it has a vocal. The tempo shows its half-time and double-time readings as chips: click one if the song feels twice too fast or too slow.
- **Reasons:** one plain line per factor, such as "A minor and C major share their notes: no pitch change".
- **The key is measured on the stems.** Once a song's stems exist, Krypt compares the notes the vocal actually sings with the notes the instrumental's bass and other stems play, at every shift up to 6 semitones up or down. It picks the shift where they line up best for the smallest move, for example "the notes match 90% (unmoved: 0%)". This matters because a song's vocal can sit in a different key from the song's own mix, especially a remix or another mashup.
- **Could be better:** suggestions like "Use B at half time". Click **Apply** when a suggestion matches an option. The check runs again by itself.
- **Problems** that stop the build, such as a missing stem model. **Open Model Manager** is right there.

Changing a song or an option checks again after a moment, so the score and the plan always match what **Build** will make.

[[show:mashup.score|Show me the score]]

## The three styles

| Style | What you get | Needs stems |
|---|---|---|
| **Vocal over beat** | One song's vocal on the other song's instrumental (drums, bass and other). This is the classic mashup. **Vocal from: Auto** picks the direction that fits best. | Yes, unless one song is already an a cappella or an instrumental |
| **Stem blend** | Any stem from either song. A grid sets vocals, drums, bass and other each to **A**, **B** or **Off**. | Yes |
| **Back & forth** | Both full songs trade sections on one tempo and key (A's chorus, then B's drop, and so on), joined with transitions. | No |

Stems come from **HT-Demucs**, a one-time download in the Model Manager. Stems you already separated for a song are reused.

[[show:mashup.style|Show me the styles]] [[show:mashup.stems|Show me the stem grid]] [[action:modelManager|Open Model Manager]]

## The options

| Option | What it does |
|---|---|
| **Anchor** | Who keeps their own tempo and key. **Auto** (the default) keeps the instrumental's key, and keeps its tempo too unless that would stretch the vocal audibly: then both songs meet half way on tempo. **Keep the beat** leaves the instrumental untouched and moves the vocal. **Keep the vocal** moves the instrumental instead. **Meet in the middle** moves both about half way, for the smallest change on either. |
| **Krypt Tune on the vocal** | **Off** (the default), **Natural**, **Pop** or **Hard**, the same styles as **Tune vocal** (see [[guide:vocals#tune-a-vocal|Tune a vocal]]). A vocal from a finished song is already in tune, and the pitch shift puts it in the new key. Tuning it to a scale can bend a singer's runs and blue notes, so turn it on only for a reason. |
| **Length** | **Auto** uses the instrumental's arranged length, up to 128 bars. **Bars** sets it yourself, from 8 to 128. |
| **Put it in** | **A new project** (the default; you're asked about unsaved changes first) or **This project**, on new tracks. |
| **Transitions between sections** | Risers, impacts and sweeps at every section boundary. |

[[show:mashup.options|Show me the options]]

## The plan, then Build

**The plan** draws the arrangement before anything is built. It shows each section, what it uses (such as "A vocal + B beat") and how far each song is moved, such as "vocal +2 st, ×1.04". A warning sign marks a change big enough to hear.

Click **Build the mashup**. A window ticks off the stages: reading the songs, splitting stems, listening (where the vocal sings, and which notes each stem plays), planning, building the arrangement, and mixing.

The mix starts level: each song is brought to the same loudness (-14 LUFS) on its tracks' volume, with the vocal 1 dB over its old level. A loud, finished song no longer hits the master chain 8 dB harder than the other one. The vocal gets a light chain (a low cut, a little mud and fizz cut, gentle compression) because it was already mixed once. **Cancel** stops it, and your project is left as it was. You can also close the window: the build keeps going, and **Tools ▸ Auto Mashup…** shows it again. When it's done, a toast offers **Open Studio**, and the window lists the tempo, key, length, tracks and anything worth checking by ear.

[[show:mashup.plan|Show me the plan]] [[show:mashup.build|Show me the Build button]]

## Honest limits

- **Stems aren't perfect.** Separated vocals can carry a little of the beat, and a busy mix separates less cleanly than a sparse one.
- **Big moves are audible.** Stretching a song more than about 15 % slower or 18 % faster, or pitching a vocal more than 3 semitones, can sound grainy or cartoonish. The check says so, and suggests a half-time or double-time reading when that means less stretching.
- **Sections are a best guess.** The hook goes over the instrumental's strongest section and the verses over the calmer ones, on 4- and 8-bar phrases. Move clips around if a line lands badly.
- **Krypt Tune follows one voice.** Harmonies and doubled vocals on the same stem can make it jump between notes. Leave it **Off**, or try **Natural**.
- **Some pairs just don't fit.** When even the best shift leaves clashing notes, the check says "these two may not fit". Try the vocal from the other song, or another song.
- **Songs that drift in tempo,** like live recordings, are warped to the grid from their beats. Check the ends of long sections.

Everything it makes is ordinary clips, effects and markers. Change anything, or undo the whole mashup with one step in **Edit ▸ History**.

## Ask an agent

Agents can do the same thing in one call with the \`auto_mashup\` tool: "Mash up C:\\Users\\me\\Music\\a.mp3 and b.mp3, vocal from A, keep the beat, hard tune". An agent can check the fit first without building anything (a dry run), then build. In Claude Code, \`/krypt-studio:mashup\` starts with it. See [[guide:vocals#mashups-with-an-agent|Mashups with an agent]].

!> Mashups of songs you don't own are for practice, DJ sets you have the rights for, and personal listening, not for release.
`,
};
