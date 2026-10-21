// Song building in Krypt Studio: arrangement, transitions, sound packs, sampling, workflow tips (guides-content-2). See research/14-sounds-and-guides.md §3 for the markup and the rules.
import type { GuideArticle } from '../articles';

export const WORKFLOW: GuideArticle[] = [
  {
    id: 'arrangement',
    title: 'Song structure & arrangement',
    summary: 'Sections, energy, 4- and 8-bar phrases, markers, and turning a loop into a whole song on the Playlist.',
    group: 'Make music',
    icon: 'layers',
    body: `
A loop is an idea. A song is that idea told over time: it starts somewhere, builds, peaks, takes a breath and ends. Arranging is deciding what plays when, so the listener always has a reason to keep listening.

[[action:playlist|Open the Playlist]]

## The sections

Most songs are built from a handful of section types. The names change between genres, but the jobs stay the same.

| Section | Its job | Typical length |
|---|---|---|
| **Intro** | Sets the mood and the tempo. Often drums or chords alone, or the hook filtered. | 4 to 16 bars |
| **Verse** | Room for a vocal or a simpler idea. Lower energy than the hook. | 8 to 16 bars |
| **Build / pre-chorus** | Raises the tension: more percussion, a rising filter, a riser, a snare roll. | 4 to 8 bars |
| **Hook / chorus / drop** | The main idea at full energy. The part people remember. | 8 to 16 bars |
| **Breakdown / bridge** | A breath: the drums or the bass drop out, something new appears. | 8 to 16 bars |
| **Outro** | Winds down, or gives a DJ a clean beat to mix out of. | 4 to 16 bars |

A common shape is intro, verse, hook, verse, hook, bridge, hook, outro. Dance music often runs intro, breakdown, build, drop, breakdown, build, drop, outro. The genre guides show what each style tends to do, for example [[guide:genre-trap|Trap and drill]] or [[guide:genre-electronic|House, techno and EDM]].

## Think in 4- and 8-bar phrases

Listeners feel music in groups of 4 and 8 bars, even if they couldn't tell you why. Changes that land on those lines feel natural, and changes that land on bar 7 feel like a mistake.

- Make sections a multiple of 4 bars long: 8 and 16 are the safest.
- Change something small every 4 or 8 bars: a hat pattern, a fill, a new layer, a muted kick.
- Put a fill or a transition in the **last bar** of a phrase, so the next phrase starts clean on its downbeat.

> The AI's song check (\`review_song\`) flags sections whose length isn't a multiple of 4 bars, and loops that repeat unchanged for too long.

## Energy

Think of each section as a level of energy from quiet to full. A good song moves between levels instead of staying at one.

- **Add and remove parts.** The easiest contrast is a kick that drops out for a breakdown and comes back for the hook.
- **Change density.** Hats in 8ths for the verse, 16ths for the hook.
- **Change the range.** A melody an octave up, a bass that moves to higher notes, a pad that opens up.
- **Save the biggest moment.** The last hook can add one more layer than the first.

## Build a song on the Playlist

1. Make your main loop in pattern mode: drums, bass and the hook.
2. Make variations of it with **Clone pattern** in the pattern picker [[show:channelRack.patterns|Show me]]. For example "Hook", "Verse" (fewer drums, no lead) and "Intro" (chords only).
3. Open the Playlist ([[F5]]). Click a pattern in the pattern list to make it the brush, then draw it on a track. With **Paint** ([[B]]) you drag to lay copies end to end.
4. Switch to **Song** mode with [[L]] and play from the start.
5. Mark the sections: double-click the ruler, or right-click it ▸ **Add marker at…** [[show:playlist.markers|Show me the marker bar]]

Markers are named "Marker 1", "Marker 2" and so on. You can't rename them in the Playlist yet; agents name theirs ("Hook 1") when they arrange.

[[show:playlist.tracks|Show me the Playlist tracks]] [[show:transport.mode|Show me the Pat / Song switch]]

### Tricks for variation without new patterns

- **Split by channel** (right-click a pattern clip) puts each channel on its own track, so you can mute or remove one part in one section.
- **Make unique** turns one copy into its own pattern, so you can change it without touching the others.
- Use the Playlist's Slice tool ([[C]]) to cut the end off a clip, for a beat of silence before a hook.
- **Insert time at…** on the ruler's right-click menu opens space in the middle of the song. **Delete loop region time** removes a part you don't need.

## Pattern mode and song mode

| | Pattern mode | Song mode |
|---|---|---|
| Plays | The active pattern, looped | The Playlist from the play position |
| Use it for | Writing a loop | Hearing the arrangement |
| Recording goes | Into the looping pattern | Into the pattern under the play position |

The switch is in the transport bar, and [[L]] flips it.

## Let the AI arrange

Agents can arrange too. Ask in plain words:

- "Arrange my patterns into intro, verse, hook, verse, hook, outro."
- "Make the song 3 minutes long, with a breakdown before the last hook."
- "Add 8 bars before the first drop."

In Claude Code, \`/krypt-studio:arrange\` does the same thing as a ready-made prompt: it arranges your existing patterns into sections, adds markers and a transition at every boundary, then checks the song. Every step is one entry in History, so you can undo it in one click.

Next: [[guide:transitions|Transitions between sections]] · [[guide:ai-results|Getting great results from the AI]]
`,
  },
  {
    id: 'transitions',
    title: 'Transitions',
    summary: 'Risers, downlifters, swells, whooshes, tape stops, impacts, snare rolls, filter sweeps and silence: what each does and where it goes.',
    group: 'Make music',
    icon: 'zap',
    body: `
A transition is whatever tells the listener "something new is coming" or "we're here". Without them, sections just switch, and even a good arrangement sounds like a playlist of loops. With them, the song flows.

Krypt Studio's factory sounds include a whole set of transition effects, made by its own engine, and the optional sound packs can add recorded ones. AI agents place them with one tool, \`add_transition\`.

[[show:browser.factory|Show me the factory sounds]]

## Every kind, and where it goes

| Kind | What it does | Where it goes | Lines up by |
|---|---|---|---|
| **Riser** | Noise or pitch climbing up, building tension | The 1 to 8 bars before a drop or hook | Its **end** on the bar line |
| **Reverse cymbal** | A cymbal played backwards, sucking into the next beat | The 1 to 2 bars before a new section | Its **end** |
| **Swell** | A reversed reverb or a volume swell that blooms into the next section | The bar or two before a section | Its **end** |
| **Whoosh** | Air rushing past, loudest at its end | Across a section change, or under a fill | Its **end** |
| **Tape stop** | The sound slowing to a halt, like a tape machine switched off | The last beat or bar before a drop or a break | Its **end** |
| **Sweep up** | Filtered noise rising | Into a section | Its **end** |
| **Impact** | A boom or hit that marks the arrival | The downbeat of a drop or hook | Its **start** on the bar line |
| **Sub drop** | A low tone that falls in pitch, felt more than heard | The downbeat of a drop | Its **start** |
| **Crash** | A cymbal crash | The downbeat of any new section | Its **start** |
| **Downlifter** | A falling sweep that lets the energy out | The start of a breakdown or a quieter section | Its **start** |
| **Sweep down** | Filtered noise falling | The start of a section | Its **start** |
| **Snare roll** | Snare hits getting faster and louder | The 1 to 8 bars before a drop | Ends on the boundary |
| **Drum fill** | A short fill on snare or toms | The last bar of a phrase | Ends on the boundary |
| **Filter sweep** | A filter opening or closing over the music | The bars before a section, snapping back on the downbeat | Spans the bars before |
| **Silence** | Everything drops out for a moment | The last beat before a drop | Ends on the boundary |

Layering works: a riser plus a snare roll into the drop, then an impact and a crash on its first beat, is a classic for a reason.

Beyond transitions, the factory and the packs also have ear candy: zaps and glitches, vocal shots, foley, ambience, textures and retro game sounds. Sprinkle them on the off-beats of a quiet section, or under a breakdown.

{{kinds}}

## End-aligned and start-aligned

This is the one rule that makes transitions sound right.

- **Building sounds end on the boundary.** A riser's whole point is its last moment, so its **end** must touch the bar line where the next section starts. A 4-bar riser into bar 17 starts at bar 13.
- **Arriving sounds start on the boundary.** An impact, a crash or a sub drop starts exactly on the downbeat of the new section.

A riser that starts on the downbeat instead sounds like a mistake, because it builds into nothing.

## Place one by hand

1. Find the boundary: the first bar of the next section. A marker helps.
2. Open the Browser ([[Alt+F8]]) ▸ **Factory sounds** and pick a kind, such as Risers. Click a sound to hear it. Tempo-synced effects show their length in bars.
3. Drag it onto a free Playlist track. An audio clip appears with its own channel and mixer insert.
4. Move it so its end (or its start, for impacts and crashes) sits on the boundary.
5. Make it follow your tempo: click the clip's channel name in the Channel Rack, and under **Stretch & pitch** set **Source BPM** to the tempo the sound was made at (**128** for the factory's tempo-synced effects), then switch **Follow tempo** on. Now a 4-bar riser lasts exactly 4 bars at any tempo.

> Put all your transition sounds on one track and one mixer insert. Then one fader sets how loud they are, and one reverb send glues them to the song.

## Automation sweeps

A sweep moves a control over time instead of playing a sound. The classic one is a high-pass filter that thins the music out before a drop.

1. Add **Krypt Filter** to an insert, or to the Master for everything [[show:mixer.fxSlots|Show me the effect slots]]. Set **Type** to HP 24.
2. Right-click **Cutoff** ▸ **Create automation clip**. A 4-bar clip appears on the first free track.
3. Drag the clip so it ends on the boundary.
4. Double-click to add points: start low (20 Hz, so nothing is cut) and rise to a few hundred hertz at the end. [[Alt]]+drag a line to bend it, so most of the rise happens at the end.
5. Add a point right on the downbeat back at 20 Hz, so the drop comes in full.

The same works for a reverb's mix (a wash into a breakdown), a fader (a volume swell) or the tempo.

## Drop out before the drop

Silence is the cheapest and strongest transition. Cut everything, or everything but the vocal or a riser, for the last beat or half bar before the drop. The contrast makes the drop feel twice as big.

1. Pick the Slice tool ([[C]]) in the Playlist.
2. Drag a vertical line across all tracks one beat before the boundary.
3. Delete the short pieces after the cut.

For a tape stop over the whole mix instead of a sample, put **Krypt Gate/Time** on the Master with **Pattern** set to Tape stop and **Trigger** set to Active param. Then automate its **Active** switch to turn on for the last beat.

## Ask the AI

Agents place transitions with \`add_transition\`, at one boundary or many at once, in one undo step:

- "Add a 4-bar riser and a snare roll into the drop at bar 33, and an impact on it."
- "Put a downlifter at the start of the breakdown."
- "Drop everything out for the last beat before each hook."
- "Add a whoosh into every section, and a tape stop before the bridge."

The agent picks fitting sounds from the factory library and from the sound packs you have installed. Tempo-synced effects are stretched to span exactly the bars you asked for. It puts them on an "FX" track through one "FX" mixer insert. When you ask for a whole song, the agent adds transitions at every section boundary by itself, and its song check flags any boundary that has none.

Next: [[guide:arrangement|Song structure & arrangement]] · [[guide:sound-packs|Sound packs & your own samples]]
`,
  },
  {
    id: 'sound-packs',
    title: 'Sound packs & your own samples',
    summary: 'Factory sounds, optional sound packs, your own sample folders, credits, and using the sounds in music you release.',
    group: 'Make music',
    icon: 'download',
    body: `
Krypt Studio's sounds come from three places: the factory library that comes with the app, the optional sound packs you can download, and your own sample folders.

[[action:sounds|Open Sounds & Plugins]] [[action:browser|Open the Browser]]

## Where sounds come from

| Source | What it is | Where you find it |
|---|---|---|
| **Factory sounds** | Drums, 808s, one-shots, transitions and textures, made by Krypt Studio's own engine. They come with the app. | Browser ▸ **Factory sounds** |
| **Instrument packs** | Recorded instruments: pianos, a live drum kit, mallets, strings and brass. Optional downloads. | Their presets, in the preset browser |
| **Sample packs** | Recorded sound effects (for example hits, whooshes and foley) from CC0 and public-domain sources. Optional downloads. | Browser ▸ **Sound packs** |
| **Your folders** | Any sample packs or recordings you already have | The folders you add to the Browser |

Here is what's on this PC right now, by kind:

{{kinds}}

## Download a sound pack

1. Open **Home ▸ Sounds & Plugins** and scroll to **Sound packs**.
2. Read the card: what the pack adds, its download size, the memory it uses, and its licence and credit. **Licence** opens the licence itself.
3. Click **Download**. Progress shows on the card.
4. Krypt Studio checks every file's size and SHA-256 before it installs the pack. If something doesn't match, nothing is installed and the card says why.

- **Cancel** stops a download and keeps the finished files, so the next **Download** picks up where it stopped.
- Some packs come as one ZIP file from their source's own site. Krypt Studio takes only the files the pack lists out of it, checks each one, and deletes the ZIP.
- **Show folder** opens the pack's folder. **Remove** deletes the pack from this PC. **Update** appears when a newer version is offered.

!> Packs download from the sites that host them. You need an internet connection for the download, and never again afterwards.

## Use pack sounds

- **Instrument packs** add presets that play in the Krypt Multisampler. In the preset browser they show a **Download pack** button until you have the pack.
- **Sample packs** add samples to the Browser's **Sound packs** section [[show:browser.packs|Show me]]. Click one to hear it, double-click to add it as a sampler channel, or drag it onto the Channel Rack or the Playlist.
- The Browser's search box finds pack sounds along with presets and factory sounds.

Agents see which packs you have (\`list_packs\`) and use installed ones: their sample search and their transitions draw on pack samples too. They can suggest a pack, but only you can download one.

## Your own sample folders

1. Click the folder button at the top of the Browser, and pick a folder.
2. Or open **Home ▸ Sounds & Plugins ▸ Found on this PC**: it lists the sample folders in the usual places (Documents, Music, Downloads), each with an **Add to Browser** button.

Krypt Studio never copies, moves or changes your files. To take a folder out again, right-click it in the Browser ▸ **Remove from browser**.

Agents can search your Browser folders too (\`find_samples\`). They guess what a sound is from its file and folder names, so a folder called "Kicks" with files like "Kick Punchy 03.wav" helps them a lot.

## Credits and licences

- **Factory sounds** are original: the engine synthesizes every one of them, and there are no third-party samples inside. They're released under the same MIT licence as Krypt Studio.
- **Sound packs** use only CC0 or public-domain sounds. Each card shows the licence and who made the sounds. After download, the pack's folder has a \`LICENSE.txt\` with the licence, the credit and a checksum of every file. The full list of credits is in THIRD-PARTY-NOTICES.

## Using the sounds in music you release

| Sounds | In a song you release | Selling or sharing the raw files as a sample pack |
|---|---|---|
| Factory sounds | Yes, with no credit needed | Allowed: they're MIT-licensed like the app, so keep the licence notice with them |
| Sound packs (CC0 / public domain) | Yes. Credit is welcome, not required | The licence allows it, but some authors ask you not to: see the pack's \`LICENSE.txt\` |
| Your own folders | Depends on where you got them | Read their licence |

Some pack authors add polite requests on top of their licence, like credit or "please don't sell the samples on their own". Krypt Studio keeps them in the pack's \`LICENSE.txt\`, and we ask you to respect them.

## Projects that use a pack

A project remembers which pack a sound came from. Opened on a PC without that pack, it says which pack to download, and the sounds come back once it is installed. That makes projects easy to share: see [[guide:faq|the FAQ]].

Related: [[guide:sounds-presets|Sounds & presets]] · [[guide:transitions|Transitions]] · [[guide:sampling|Sampling & chopping]]
`,
  },
  {
    id: 'sampling',
    title: 'Sampling & chopping',
    summary: 'Bring audio in, fit it to your tempo and key, chop it on the Playlist or in a sampler, split stems and turn it into notes.',
    group: 'Make music',
    icon: 'wave',
    body: `
Sampling means building music from recorded audio: a drum break, a chord stab, a vocal phrase, a sound you recorded yourself. Chopping means cutting that audio into pieces and playing them in a new order.

Krypt Studio has no dedicated slicer that spreads a sample's slices across the keys yet. This guide shows how to sample and chop with the tools it does have.

!> Only sample audio you have the right to use: your own recordings, the factory sounds and the sound packs, or material you licensed. Releasing music with someone else's recording in it needs their permission.

## Bring audio in

- **Onto the Playlist:** drag a file from the Browser or from Windows Explorer onto a track. It becomes an **audio clip** with its own channel and mixer insert.
- **Into the Channel Rack:** drop a file onto empty rack space for a **sampler** channel you play with steps or notes.
- **Record it:** see [[guide:recording|Recording]].

## Fit it to your song

Right-click the audio clip on the Playlist:

- **Detect tempo & key** finds the tempo and key. From its window you can use the tempo as the project's tempo, or make the clip follow the project.
- **Match key & tempo to ▸ Project** pitches the clip onto your song's key (never more than 6 semitones) and makes it follow your tempo.

Or click the clip's channel name in the Channel Rack and use **Stretch & pitch**: **Follow tempo** with the **Source BPM**, **Stretch** from 0.25× to 4×, **Pitch** up to 24 semitones either way, and **Formants** to keep voices natural. The [[guide:audio-tools|Audio tools]] guide has the details.

## Chop on the Playlist

Best for breaks, vocal phrases and long samples.

1. Select the Slice tool ([[C]]) and drag a line through the clip where you want a cut. Or right-click the clip right where you want the cut and choose **Split here**.
2. Move the pieces: drag one, [[Shift]]+drag to copy it, [[Ctrl+B]] to duplicate the selection.
3. Mute a piece with the Mute tool ([[T]]), or delete it.
4. Drag a piece's edges to trim it. Hold [[Alt]] while you drag to move off the grid.

All the pieces share one channel, so **Reverse**, **Pitch** and the stretch settings in its window change every piece at once. For a chop that needs its own settings, use a sampler channel instead.

## Chop in a sampler

Best for one-shots, stabs and drum hits you want to play with steps or notes.

1. Drop the sample onto empty Channel Rack space. A sampler channel appears.
2. Click its name to open its window. Turn **Start** up to begin playback later in the sample: that's where your chop starts.
3. Turn **One-shot** off, so a note's length decides how much plays, and keep **Release** short for a clean cut.
4. Right-click the channel ▸ **Clone**, and give the clone a different **Start**. Repeat for every chop you want.
5. Play the chops from the step grid or the Piano Roll. With **Key tracking** on, a chop plays higher or lower with the keys.

**Reverse** and **Loop** are in the same window, along with an envelope, a filter and a pitch envelope. In the Piano Roll, **Chop…** ([[Alt+U]]) and **Quick chop** ([[Ctrl+U]]) cut notes into fast repeats, which gives stutters on a chop.

## Stems: take a song apart

**Separate stems** (right-click an audio clip) splits a song into drums, bass, vocals and other, each on its own track. Mute the parts you don't need and chop the rest. It needs the **HT-Demucs** model, a one-time download in the Model Manager.

[[action:modelManager|Open Model Manager]]

## Turn audio into notes

**Convert to pattern** ▸ **Melody & chords**, **Single line** or **Drums** writes what it hears into a new pattern. Then you can play a sampled melody with your own instrument, or rebuild a break with your own drums. It works best on a stem.

## Effects that love samples

- **Krypt Gate/Time:** tempo-locked stutters, half-time, triplet chops, reverse, scratch and tape stops. Under **Custom steps** you draw your own pattern: up to 16 steps, each a time move (play, roll, repeat, half speed, reverse, tape stop or start) with its own level, or load one from **Load steps**.
- **Krypt Drive:** tape and tube warmth, or bitcrush for grit.
- **Krypt Filter:** a low-pass for that "from the next room" sound.
- The **Character** effect chains (Lofi Tape, Telephone, Bit Crushed, Tube Warmth) add colour in one click.

## Ask the AI

Agents have the same tools. They can bring in audio, read its tempo and key, split stems, transcribe it, stretch and pitch a clip, and place sections of an audio clip on the Playlist:

- "Import this break and make it follow the project tempo: C:\\Users\\me\\Music\\break.wav"
- "Use bars 9 to 12 of the vocal as a hook, every 8 bars in the drop."
- "Split this song into stems and turn the bassline into a pattern."

!> Not available yet: a slicer that maps slices to keys, fade handles on audio clips, and different pitch or reverse settings per piece of the same clip.
`,
  },
  {
    id: 'audio-to-project',
    title: 'Turn a song into a project',
    summary: 'Open a WAV, MP3, M4A or FLAC as an editable project: drums, bass, chords and lead as patterns on matched sounds, vocals as audio.',
    group: 'Make music',
    icon: 'wave',
    body: `
Krypt Studio can open a song file as a project you can edit. It listens to the song on your PC, splits it into stems, writes the drums, bass, chords and lead into patterns on the closest matching sounds, keeps the vocal as audio, and lays it all out in sections on the Playlist. From then on it's a normal project: change the notes, swap a sound, rearrange it.

[[action:audioProject|Open audio as project…]] [[action:modelManager|Open Model Manager]]

## Open a song

1. Choose **File ▸ Open audio as project…** ([[Ctrl+Shift+O]]), **Home ▸ Projects ▸ From an audio file**, or **Home ▸ Audio Tools ▸ Audio → Project**. You can also drop a song on Home and pick **Open as project**.
2. Pick the parts to turn into patterns: **Drums**, **Bass**, **Chords** and **Lead**. Vocals always stay audio.
3. Pick the **Tempo reading**: **As detected**, **Half time** or **Double time**. Start with As detected.
4. Leave **Keep the stems** on to get the separated stems on muted tracks.
5. Click **Convert** (or **Choose a file…**). If your open project has unsaved changes, you're asked first: the song opens as a new project.

A window ticks off the five stages as they finish: listening (tempo, key, beats and sections), splitting the stems, writing the notes, matching sounds and building the project. **Cancel** stops it at any stage. You can also close the window: the conversion keeps going, and **Open audio as project** shows it again.

## What you get

- The song's tempo, key and swing, with a marker for each section (Intro, Verse, Drop and so on).
- One channel per part, each with the closest matching preset or sample on its own mixer insert.
- A pattern per section. Sections that repeat share a pattern, so changing one hook changes every hook.
- The vocal on its own audio track, playing.
- With **Keep the stems**: the drums, bass, vocals and other stems on muted audio tracks, lined up with the song. Unmute one to compare it with what was written.

When it's done, a summary lists the tempo, key, bars, sections, channels and patterns, which sound each part got, and the limits of this conversion. The whole build is one entry in **Edit ▸ History**.

[[show:playlist.tracks|Show me the Playlist tracks]]

## What converts well, and what doesn't

| Part | How it comes out |
|---|---|
| **Drums** | Well: kick, snare, hats and percussion land on the grid with their accents |
| **Bass** | Well on a clear bassline. Very deep 808s can come out an octave off |
| **Chords** | Roughly: dense chords in a full mix lose notes, so check them in the Piano Roll |
| **Lead** | Roughly: busy or layered synth lines come out simplified |
| **Sounds** | Close, not identical: synth sounds especially need tweaking by ear |
| **Vocals** | Not turned into notes: they stay audio |

Live recordings that drift in tempo still land on the grid, because the notes follow the song's own beats rather than one fixed tempo.

> If the result feels twice too fast or too slow, convert again with **Half time** or **Double time**.

## It needs HT-Demucs

Splitting the stems uses the **HT-Demucs** model, a one-time download in the Model Manager. Without it the conversion still works, but drums, bass and chords are read from the full mix, which is rougher, and there are no stems to keep. On a DirectX 12 graphics card it runs on the GPU and takes a few seconds per minute of audio; on the CPU it is slower.

## Ask an agent

Agents have the same converter, \`audio_to_project\`: "Turn C:\\Users\\me\\Music\\song.mp3 into a project." An agent opens it as a new project only when the open one has no unsaved changes. Otherwise it asks you to save first, or adds the parts to the open project if you tell it to.

!> If this isn't your song, use the result for practice and remix study, not for release. To make an original song in the style of one you love, give it to an agent as a reference instead: [[guide:ai-results#make-something-like-a-song-you-love|Make something like a song you love]].
`,
  },
  {
    id: 'workflow-tips',
    title: 'Work faster',
    summary: 'The keys worth learning, starting points, the typing keyboard, windows on a second screen, hints and History.',
    group: 'Make music',
    icon: 'flame',
    body: `
Speed matters in music: the faster an idea gets out of your head and into the project, the more of it survives. Here are the habits that save the most time in Krypt Studio.

## The keys worth learning first

| Key | Does |
|---|---|
| [[Space]] | Play and stop |
| [[L]] | Pattern / song mode |
| [[F5]] / [[F6]] / [[F7]] / [[F9]] | Playlist, Channel Rack, Piano Roll, Mixer |
| [[Alt+F8]] | Browser |
| [[F4]] | Next empty pattern (a new one if there is none) |
| [[Ctrl+T]] | Typing keyboard on and off |
| [[Ctrl+S]] | Save |
| [[Ctrl+R]] | Export audio |
| [[Ctrl+Z]] | Undo your last edit |
| [[Ctrl+H]] | Panic: all notes off |
| [[F1]] | The guides |

In the Piano Roll and the Playlist, the tools have one-letter keys: Draw [[P]], Paint [[B]], Delete [[D]], Select [[E]], Slice [[C]], Mute [[T]]. Every key can be changed in Settings ▸ **Shortcuts**, and [[guide:shortcuts|Keyboard shortcuts]] lists them all.

## Don't start from nothing

- **The demo.** Open it from Home ▸ Projects, or from the Browser under **Demo projects**. It opens as a template: [[Ctrl+S]] makes your own copy in Documents and never changes the demo.
- **A new project** already has Kick, Clap, Hat, Snare, 808 and Keys channels, each with its own mixer insert, at 140 BPM.
- **Your own starting point.** Krypt Studio has no template feature yet. Build a project the way you like to start (your drums, your mix bus, your sends), save it as "Start", and each time you open it press [[Ctrl+Shift+S]] first, so you never save over it.
- **Presets and chains.** Save a sound you like with **Save…** on the preset bar, and an insert's effects with **Save chain as preset…**. They're in every project from then on.

[[action:openDemo|Open the demo]]

## Play ideas in

- [[Ctrl+T]] turns your computer keyboard into a piano for the selected channel: the **Z** row and the **Q** row. It plays, but doesn't write notes. To keep what you play, record it.
- A MIDI keyboard shows up within a couple of seconds of plugging it in. Arm the record button and play: see [[guide:recording|Recording]].
- In the Piano Roll, the **chord stamp** draws a whole chord with one click, and **ghost notes** show the other channels, so parts line up.

## Reuse what you made

- **Clone pattern** in the pattern picker copies the active pattern, ready for a variation.
- [[Ctrl+B]] duplicates the selection right after itself, in the Piano Roll and the Playlist.
- On the Playlist, **Paint** ([[B]]) lays copies of a pattern end to end with one drag.
- Drag a chain preset from the Browser onto an insert's effects to set up a whole mix bus at once.

## Arrange your windows

- The F-keys open and close windows. The buttons in a window's header float it over the workspace, dock it back, maximize it, or move it into its own window: handy for the Mixer on a second screen.
- **View ▸ Reset layout** puts everything back.
- Settings ▸ **Interface** ▸ **Open to Home on launch** decides whether you start on Home or straight in the Studio.

## Let the app explain itself

Turn on Settings ▸ **Interface** ▸ **Hint bar**, and the status bar describes whatever is under your mouse. The "Show me" buttons in these guides highlight the real control on screen.

## Never lose work

- Krypt Studio keeps a crash-safe copy of your changes while you work, and brings them back after a crash.
- Each save over a project keeps the previous version as a backup (the last ten per project).
- **Edit ▸ History…** lists every edit, yours and the AI's. [[Ctrl+Z]] undoes your own edits; History reverts an agent's.

[[action:history|Open History]]

## Hand the chores to the AI

Some jobs are faster to say than to do. A connected agent will happily:

- "Name and colour every channel by its role."
- "Route all the drums to a drum bus with a bus compressor."
- "Make three hat variations and use them in the second verse."
- "Check the mix and fix the top two problems."

See [[guide:ai-results|Getting great results from the AI]].
`,
  },
];
