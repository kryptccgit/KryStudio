import { LIBRARY_ARTICLES } from './library';
import { BEGINNER_ARTICLES, BEGINNER_FIRST } from './beginner';
import { SESSION_ARTICLE } from './sessionArticle';
import { RACKS_ARTICLE } from './racksArticle';
import { SCRIPTS_ARTICLE } from './scriptsArticle';
import { TAKES_ARTICLE } from './takesArticle';
import { MASHUP_ARTICLE } from './mashupArticle';
import { AUTOMIX_ARTICLE } from './autoMixArticle';
import { VOICE_ARTICLE } from './voiceArticle';

export type GuideGroup = 'Start here (step by step)' | 'Start here' | 'Make music' | 'Music basics' | 'Mixing' | 'Genres' | 'AI and audio' | 'Help';

export type GuideIcon =
  | 'rocket'
  | 'rack'
  | 'piano'
  | 'playlist'
  | 'mixer'
  | 'mic'
  | 'bot'
  | 'wave'
  | 'vocal'
  | 'library'
  | 'blocks'
  | 'presets'
  | 'download'
  | 'keyboard'
  | 'lifebuoy'
  | 'music'
  | 'drum'
  | 'chords'
  | 'sliders'
  | 'sparkles'
  | 'book'
  | 'flame'
  | 'headphones'
  | 'layers'
  | 'zap'
  | 'video';

export interface GuideArticle {
  id: string;
  title: string;
  summary: string;
  group: GuideGroup;
  icon: GuideIcon;
  body: string;
}

export const GUIDE_GROUPS: GuideGroup[] = ['Start here (step by step)', 'Start here', 'Make music', 'Music basics', 'Mixing', 'Genres', 'AI and audio', 'Help'];

export const ARTICLES: GuideArticle[] = [];

const CORE_ARTICLES: GuideArticle[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    summary: 'The five-minute tour: Home, the Studio, patterns and the playlist, play, save, project tabs.',
    group: 'Start here',
    icon: 'rocket',
    body: `
Krypt Studio is a beat-making studio in the pattern-and-playlist style. You build short loops called **patterns**, then arrange them into a song on the **Playlist**. AI agents like Claude can work in the same project with you, and everything they do can be undone.

> Brand new to making music, or to apps like this? [[guide:step-start|Start here, step by step]] shows every click with pictures, from your first beat to setting up AI.

{{video:overview}}

Rather be shown? A **tour** points at each button as you go, one step at a time.

[[action:tourFirstBeat|Start the tour: your first beat]] [[action:tours|All tours]]

## 1. Home and the Studio

**Home** is the start screen. It has one card for each thing you might be here to do: the Studio, your projects, AI agents, the reference library, audio tools, sounds and plugins, these guides, export and settings. Each card shows a little live status, like which agent is connected.

- **Studio** is where you make music. Click the Studio card, or press [[Esc]] on Home.
- To come back here, click the house button in the title bar or press [[Ctrl+Shift+H]].
- Opening a project, from Home or the File menu, takes you straight to the Studio.
- [[F1]] or **Help ▸ Guides** opens these guides at any time.

[[action:studio|Go to the Studio]] [[action:openDemo|Open the demo]]

## 2. The windows

The Studio is made of windows you can move around. Each one has a key:

| Window | Key | What it is for |
|---|---|---|
| Playlist | [[F5]] | The song: patterns, audio and automation along a timeline |
| Channel Rack | [[F6]] | Your instruments and the step sequencer |
| Piano Roll | [[F7]] | The notes of the selected channel |
| Mixer | [[F9]] | Volume, effects and routing |
| Browser | [[Alt+F8]] | Samples, projects and MIDI files |

Press the key again to close the window. The buttons in a window's header float it over the workspace, dock it back, or move it into its own window (handy on a second screen). **View ▸ Reset layout** puts everything back.

Closed a window by accident? Press [[Ctrl+Z]]: it comes back where it was, docked or floating, as long as you haven't edited anything since. After an edit, [[Ctrl+Z]] undoes the edit first, then brings the window back. [[Ctrl+Shift+T]] reopens the last thing you closed, a window or a tab.

## 3. Patterns and the playlist

A **pattern** is a short loop, like a drum beat or a bassline. You make it in the Channel Rack (click steps) and the Piano Roll (draw notes). The **Playlist** is the whole song: you place patterns along the timeline to build an intro, a verse, a drop.

{{video:quickstart}}

There are two ways to play:

- **Pattern mode** loops the active pattern. Use it while you build a loop.
- **Song mode** plays the Playlist from start to end.

Switch with the **Pat / Song** buttons in the transport bar, or press [[L]]. [[show:transport.mode|Show me]]

How to turn a loop into a whole song is in [[guide:arrangement|Song structure & arrangement]].

## 4. Play, stop, tempo

- [[Space]] plays and stops. [[Ctrl+Space]] pauses.
- The tempo is the **BPM** number in the transport bar. Drag it up or down, scroll on it, or double-click it and type a number. [[show:transport.tempo|Show me]]
- The time signature is the **4/4** next to it. Click it for 3/4, 6/8, 12/8, 5/4, 7/8 or your own. Bars, the grid, the Channel Rack's steps and the metronome follow it. Clips keep their place in beats; only the bar numbers move. [[show:transport.timeSig|Show me]]
- [[Ctrl+M]] turns the metronome on and off.

## 5. Save your work

1. Press [[Ctrl+S]]. The first time, pick a folder and a name.
2. Projects are \`.kstudio\` files. Double-click one in Explorer to open it here.
3. [[Ctrl+Shift+S]] saves a copy under a new name.
4. **File ▸ Save as template…** keeps the project as a starting point: its sounds, mixer, tempo and patterns. Start the next song from it with **File ▸ New from template**, or on Home ▸ Projects, where you can also rename and delete templates. [[show:home.templates|Show me]]

> Krypt Studio keeps a crash-safe copy of your unsaved changes while you work. If the app or your PC crashes, your changes come back the next time you start it. Save to keep them.

[[action:projects|Your projects]] [[action:agents|Connect an AI agent]]

## 6. Several projects at once

Each open project is a **tab** in the title bar, like in a web browser. [[show:titlebar.tabs|Show me]]

- [[Ctrl+N]] or the **+** button opens a new tab with a fresh project. The small arrow next to **+** (or a right-click on it) starts one from a template, opens a project or reopens a closed tab. [[show:titlebar.newTab|Show me]]
- **File ▸ Open…**, Home ▸ Projects and the recent list open the project in a new tab. A project that's already open just comes to the front.
- Click a tab to switch to it. [[Ctrl+Tab]] and [[Ctrl+Shift+Tab]] go to the next and the previous tab, [[Ctrl+1]] to [[Ctrl+8]] jump to that tab, and [[Ctrl+9]] to the last one.
- Drag a tab to put it somewhere else in the row. A pink dot means unsaved changes. A spinning icon means the project is busy (an AI build, a recording): you can't switch away until it's done, and a message says why.
- [[Ctrl+W]], a middle-click or the × closes a tab. With unsaved changes you're asked first: **Save**, **Don't save** or **Cancel**. Right-click a tab for **Close others**, **Save**, **Reveal in Explorer** and **Copy path**.
- [[Ctrl+Shift+T]] reopens the tab (or window) you closed last.
- Only the front tab plays: switching tabs stops playback. Each tab keeps its own undo history, and AI agents work on the front tab.
- Your tabs come back the next time you start Krypt Studio, unsaved changes included.

## 7. Where to go next

- Want every click spelled out, with pictures? The **Start here (step by step)** guides: [[guide:step-start]], [[guide:step-first-beat]], [[guide:step-ai]] and [[guide:step-help]].
- New to making music? Start with [[guide:rhythm-tempo|Rhythm & tempo]] and [[guide:drums|Drum programming]].
- Ready for a full song? Read [[guide:arrangement|Song structure & arrangement]] and [[guide:transitions|Transitions]].
- More sounds: [[guide:sound-packs|Sound packs & your own samples]].
- Working with an AI agent: [[guide:ai-results|Getting great results from the AI]].
- Speed: [[guide:workflow-tips|Work faster]]. A word you don't know: [[guide:glossary|the Glossary]].
`,
  },
  {
    id: 'videos',
    title: 'Video tutorials',
    summary: 'Short narrated videos: the quickstart, then one for each part of the app.',
    group: 'Start here',
    icon: 'video',
    body: `
Short narrated tutorials, with captions. Pick one to play it here. Each one goes with a guide that has every detail: **Read the guide** under the player opens it. Help ▸ **Video tutorials** brings you back to this page.

## The videos

{{videos}}

## Captions and speed

- Captions are on to begin with. The **CC** button under the player turns them off and on.
- **1×**, **1.25×** and **1.5×** set the speed. Your choices hold for every video until you close Krypt Studio.
- Click the video once it plays, and [[Space]] pauses and plays it.
`,
  },
  {
    id: 'channel-rack',
    title: 'Channel Rack & step sequencer',
    summary: 'Add instruments and samples, click in beats, set swing, length and routing.',
    group: 'Make music',
    icon: 'rack',
    body: `
The Channel Rack ([[F6]]) lists your **channels**. A channel is one instrument: a drum sample, a synth or an 808. Each row has a step sequencer for the active pattern.

[[action:channelRack|Open the Channel Rack]]

## Add a channel

- Click **+ Channel** in the header, or the dashed row at the bottom (**Add channel · or drop a sample**). Pick a stock instrument, or one of your installed VST3 / CLAP plugins.
- Or drag a sample from the Browser (or from Windows Explorer) onto empty rack space. You get one sampler channel per file, named after it.
- Drop a sample onto an existing row to load it into that channel.

Every new channel gets its own mixer insert, named after it. Drag the grip at the left of a row to reorder channels.

## Click in a beat

Each square is a 16th note.

- **Click** a step to turn it on or off. **Drag** to paint several.
- **Right-click** (or right-drag) to erase.
- **Shift+click** gives a step an accent (full velocity).

Pick the pattern you are editing in the pattern picker. [[Num +]] and [[Num −]] step through patterns, and [[F4]] jumps to the next empty one (it makes a new pattern if there is none).

## Length, swing, velocity and pan

- **Pattern length:** the length menu in the header offers **Auto** or 8 to 128 steps. Right-click a channel ▸ **Pattern length** has **Custom…** too.
- **Swing:** the **Swing** knob in the header shuffles every channel. Each channel's own **Swing mix** is in its plugin window.
- **Vel** and **Pan** in the header open a lane under the selected channel. Drag across the steps to draw values; [[Alt]]+click resets one.

## The row controls

- The green light mutes the channel. Right-click it to solo.
- The two knobs are pan and volume. Drag them up and down; hold [[Ctrl]] for fine moves; double-click to reset.
- The small number button routes the channel to a mixer insert (**M** means Master). Click it to pick an insert or a new one.
- Click the channel's name to select it and open its plugin window. [[Ctrl]]+click plays its root note.

The Piano Roll and the typing keyboard always follow the selected channel. [[Up]] and [[Down]] change the selection while the rack has focus.

## The channel menu

Right-click a channel's name for: **Open plugin editor**, **Open in Piano Roll**, **Rename…**, **Color**, **Replace instrument**, **Clone**, **Route to mixer insert**, **Solo**, **Mute**, **Clear notes in this pattern**, **Fill** (every 2, 4 or 8 steps and more), **Shift steps**, **Pattern length**, **Filter group**, **Load sample…** and **Delete…**.

## Mono, glide and cut groups

These live in the channel's plugin window, under **Voice**: **Mono**, **Glide**, **Cut group** and **Cut by**. A channel cuts off every channel whose "cut by" matches its group. Use it so an open hat stops when the closed hat plays. New 808 channels start in mono with a short glide.

## The typing keyboard

[[Ctrl+T]] turns your computer keyboard into a piano for the selected channel. The **Z** row is one octave and the **Q** row is the octave above. Hold [[Shift]] to play louder. Right-click the keyboard button in the transport bar for octave up and down.

!> The typing keyboard only plays sounds: it doesn't write notes. And while it is on, letter keys play notes instead of switching Piano Roll tools.
`,
  },
  {
    id: 'piano-roll',
    title: 'Piano Roll',
    summary: 'Draw and edit notes, chords and scales, quantize, and the Tools menu.',
    group: 'Make music',
    icon: 'piano',
    body: `
The Piano Roll ([[F7]]) edits the notes of the **selected channel** in the **active pattern**. Change either one with the **Pattern** and **Channel** menus in its toolbar, or by selecting a channel in the Channel Rack.

[[action:pianoRoll|Open the Piano Roll]]

{{video:piano-roll}}

## Tools

| Tool | Key | What it does |
|---|---|---|
| Draw | [[P]] | Click to place a note, drag before you let go to move it |
| Paint | [[B]] | Drag to paint a row of notes |
| Delete | [[D]] | Click or drag over notes to delete them |
| Mute | [[T]] | Click or drag to mute notes |
| Select | [[E]] | Drag a box to select |
| Slice | [[C]] | Drag a line through notes to cut them |

!> Tool keys only work while the typing keyboard is off. Press [[Ctrl+T]] to switch it off.

## Mouse

- Drag a note to move it. Drag its left or right edge to change its length.
- New notes use the length of the last note you clicked.
- **Right-click** (or right-drag) deletes notes, whatever tool you are in.
- [[Shift]]+drag copies notes. [[Ctrl]]+drag draws a selection box in any tool.
- Hold [[Alt]] to move freely, without snapping.
- Click the keys on the left to hear them. Click the ruler to move the play position.

## Chords, scales and ghost notes

- **Chord stamp:** pick a chord (major, minor, 7, maj7, sus4, 9 and more) in the toolbar and Draw or Paint places the whole chord.
- **Scale highlight:** choose a root and a scale (major, minor, dorian, pentatonic, blues…) to shade the notes in key. It only highlights; it doesn't lock you in.
- **Ghost notes** show the other channels' notes faintly, so parts line up.
- The **slide** toggle makes new notes glide from the previous one (great on 808s).

## Snap and the lane

- **Snap** goes from **Bar** down to **1/16 beat**, or **None**. The default is **Step** (a 16th).
- The lane under the grid edits **Vel**, **Pan**, **Rel**, **Fine**, **ModX** or **ModY**. Drag to paint values; with notes selected, only those change.

## Keys

| Keys | Does |
|---|---|
| [[Ctrl+A]] / [[Ctrl+D]] | Select all / deselect |
| [[Ctrl+C]] / [[Ctrl+X]] / [[Ctrl+V]] | Copy / cut / paste at the last click |
| [[Ctrl+B]] | Duplicate the selection right after itself |
| [[Ctrl+Q]] | Quick quantize to the snap grid |
| [[Ctrl+Up]] / [[Ctrl+Down]] | Move notes a semitone (add [[Shift]] for an octave) |
| [[Shift+Left]] / [[Shift+Right]] | Nudge by the snap grid |
| [[Delete]] | Delete the selection |

Zoom with [[Ctrl]]+wheel (add [[Shift]] for height). [[Alt]]+wheel changes the velocity of the note under the mouse.

## Generate notes

**Generate** (the wand in the toolbar, or [[Alt+G]]) writes a part for you, in key. [[show:pianoRoll.generate|Show me]]

- **Rhythm:** Euclidean patterns (pulses spread over steps), or hits by density, with accents, ghost notes and 32nd hat rolls.
- **Chords:** a progression by scale degree. Pick a mood preset or type numerals like \`i VI III VII\`. Choose close, open or spread voicing; inversions follow each other smoothly.
- **Arp** and **Bass** follow the chords already in the pattern, on any channel, or a progression. The bass plays roots, root-fifth, octaves, walking lines or 808 glides.
- **Melody:** a contour, a range, a density and a feel, in phrases with call and response. Strong beats land on the chords.

The key is the toolbar scale, or the key your pattern is already in. It fills the selected notes' bars, or the whole pattern. **Replace** rewrites those notes; **Merge** adds to them. The **seed** makes it repeatable: the same seed gives the same notes, and the dice rolls a new take. **Variations** shows four takes side by side; click one to use it. **Listen** plays the take on the channel. Every Generate is one undo step.

**Scripts** (the braces next to the wand, or **Tools** ▸ **Scripts…**) run note devices written in JavaScript: the factory ones, ones the AI writes for you, or your own. See [[guide:scripts]].

## The Tools menu

The Tools menu works on the selected notes, or on the whole channel when nothing is selected. Tools with a dialog preview as you change them; **Apply** makes one undo step.

| Tool | Key |
|---|---|
| Generate… | [[Alt+G]] |
| Quantize… | [[Alt+Q]] |
| Chop… / Quick chop | [[Alt+U]] / [[Ctrl+U]] |
| Glue | [[Ctrl+G]] |
| Legato | [[Ctrl+L]] |
| Strum… | [[Alt+S]] |
| Arpeggiate… | [[Alt+A]] |
| Randomize… | [[Alt+R]] |
| Levels: ramp / LFO… | [[Alt+O]] |
| Flip horizontally / vertically | [[Alt+Y]] / [[Shift+Alt+Y]] |
| Limit key range… | [[Alt+K]] |
| Mute / unmute | [[Shift+M]] |

There is also **Snap to scale…**, **Slide on / off**, colour groups and **Select** (muted notes, slide notes, out-of-key notes…). You can rebind every key in Settings ▸ Shortcuts.
`,
  },
  SCRIPTS_ARTICLE,
  {
    id: 'playlist',
    title: 'Playlist & arranging',
    summary: 'Place patterns and audio, automation clips, markers, loops and song mode.',
    group: 'Make music',
    icon: 'playlist',
    body: `
The Playlist ([[F5]]) is your song. Any track can hold pattern clips, audio clips and automation clips. Switch to **Song** mode ([[L]]) to hear it.

[[action:playlist|Open the Playlist]]

{{video:arrange}}

## Place patterns

1. The pattern list on the left (**Show pattern list** in the toolbar) holds your patterns. Click one to make it the brush. Right-click one for **Open in Piano Roll**, **Open in Channel Rack**, **Rename…**, **Color**, **Clone pattern** and **Delete pattern…**.
2. With **Draw** ([[P]]), click on a track to place it. With **Paint** ([[B]]), drag to lay copies end to end.
3. Or drag a pattern from the list straight onto the Playlist.

Clicking a pattern clip makes its pattern the brush. Double-click it to open it in the Piano Roll. Stretch a pattern clip longer than its pattern and the pattern repeats.

## Tools and mouse

The tools and keys match the Piano Roll: Draw [[P]], Paint [[B]], Delete [[D]], Select [[E]], Slice [[C]], Mute [[T]].

- Drag a clip to move it, also to another track. Drag its edges to trim it.
- [[Shift]]+drag copies. [[Ctrl]]+drag selects with a box.
- **Right-click a clip for its menu.** **Right-drag** across clips to delete them quickly.
- Right-click empty space to place the brush pattern, start a **New pattern here** (it opens in the Piano Roll) or **Paste here**.
- [[Ctrl+B]] duplicates the selection, [[Ctrl+X]] / [[Ctrl+C]] / [[Ctrl+V]] cut, copy and paste, [[Delete]] deletes.
- [[Ctrl]]+wheel zooms; [[Ctrl+Shift]]+wheel makes tracks taller or shorter.

The clip menu starts with **Open in Piano Roll** and **Open in Channel Rack** (audio clips: **Open audio editor**), then **Cut**, **Copy**, **Paste**, **Duplicate**, **Clone (make unique)** and **Delete**, then **Mute**, **Split here**, **Make unique**, **Split by channel**, **Consolidate** (several pattern clips into one) and a **Pattern** submenu (rename, color, clone, delete).

## Audio clips

Drag an audio file from the Browser or from Windows Explorer onto a track. It becomes an audio clip with its own channel and mixer insert. Right-click it to detect its tempo and key, split it into stems or turn it into a pattern (see the [[guide:audio-tools|Audio tools]] guide). The Slice tool and **Split here** cut audio clips too: [[guide:sampling|Sampling & chopping]] shows how to chop with them.

A loop whose tempo is known plays in time straight away: factory and sound-pack loops, and files named like \`loop_128bpm.wav\`, get **Follow tempo** with that tempo, and a message says so ("Following tempo (128 → 140 bpm)"). Press [[Ctrl+Z]] once to keep its original speed instead. One-shots are left as they are.

## Fades and crossfades

[[show:playlist.tracks|Show me]]

- Every audio clip has two small square handles on its top corners. Drag the left one right to fade in, the right one left to fade out. The white line shows the volume; the shaded corner is what you no longer hear. Fades snap to the grid; hold [[Alt]] while you drag for free movement.
- To blend two clips that meet on one track (after **Split here**, say), right-click the second one and choose **Crossfade with the previous clip**, or hold [[Alt]] as you grab its fade-in handle and drag. The second clip reaches back over the cut while the first fades out.
- **Remove fades** in the clip menu sets both back to none.

## Automation clips

1. Right-click any knob or fader (also mixer faders, effect knobs and the tempo).
2. Choose **Create automation clip**. A four-bar clip appears on the first free track.
3. On the clip, double-click to add a point, drag points to move them, right-click a point to delete it, and [[Alt]]+drag a line to bend it.

Automated controls show a small pink dot.

## Loop, markers and time

- Click the ruler to move the play position.
- Drag along the ruler to set a **loop region**. Drag its edges to change it.
- Double-click the ruler to add a marker. Double-click a marker to rename it in place ("Chorus", "Drop"): [[Enter]] keeps the name, [[Esc]] cancels. [[show:playlist.markers|Show me]]
- Drag a marker along the ruler to move it. Click it to jump there.
- Right-click a marker for **Rename…**, **Jump here**, **Loop this section** (up to the next marker) and **Delete marker**.
- The bar numbers follow the time signature in the transport bar ([[guide:getting-started#4-play-stop-tempo|Play, stop, tempo]]).
- Right-click the ruler for **Loop on** / **Loop off**, **Insert time at…**, **Insert loop length at loop start**, **Delete loop region time** across the whole song, and **Add marker at…**.
- **Follow playhead** in the toolbar keeps the view moving with the song.

How to shape a whole song from your patterns, and how to lead from one section into the next, is in [[guide:arrangement|Song structure & arrangement]] and [[guide:transitions|Transitions]].
`,
  },
  SESSION_ARTICLE,
  {
    id: 'mixer',
    title: 'Mixer & effects',
    summary: 'Inserts, effect slots, routing, sidechain, the master limiter and every stock effect.',
    group: 'Make music',
    icon: 'mixer',
    body: `
The Mixer ([[F9]]) is where your channels meet. Each channel plays into a mixer **insert**, and the inserts play into the **Master**.

[[action:mixer|Open the Mixer]]

{{video:mixer}}

## Inserts

A new project has the Master and six inserts (Kick, Clap, Hat, Snare, 808, Keys). Every strip has a fader, a pan knob, a stereo width knob, a meter, and **M** (mute) and **S** (solo). The **+** after the last strip adds an insert.

Right-click a strip for **Rename…**, **Color**, **Reset fader & pan**, **Add effect**, **Move left** / **Move right** and **Delete insert…**. Channels on a deleted insert fall back to the Master.

## Effects

Click a strip to select it. Its effects show on the right, up to **10 per insert**.

1. Click **Add effect** and pick one. Its window opens.
2. The green light on a slot bypasses it. The small knob is the wet/dry **mix**.
3. Drag a slot by its grip to reorder it, or onto another insert.
4. Right-click a slot for **Open editor**, **Bypass**, **Replace with** and **Remove**.

Your installed VST3 and CLAP effects are in the same menu, under **Installed**.

## Routing and sends

1. Click the strip you want to send from.
2. Every other strip now shows an arrow. Click the arrow under the strip you want to send into.
3. A small knob next to the arrow sets how much goes there.

!> Adding a route doesn't remove the route to the Master. If you only want the new one, remove the Master route with its X in the **Routing** list.

## Sidechain

Krypt Comp, Krypt Duck and Krypt Vocoder have a **Sidechain** menu: pick the insert that should push them.

- **Krypt Duck**: set **Mode** to **Sidechain follow** for a classic kick duck. Its default mode, **Tempo shape**, pumps in time with the beat and needs no sidechain.
- **Krypt Comp**: also set **Use sidechain input** to On.

## The master limiter

New projects put **Krypt Limiter** first on the Master (ceiling −0.3 dB, true peak on) so exports don't clip. It is a normal slot: bypass, replace or remove it.

## Auto Mix

**Auto Mix** in the Mixer's toolbar mixes the vocals, the whole song or the master from a preset or a prompt such as "vocals on top, not harsh". It measures the song, sets real knobs on its own marked slots, measures again, and shows before and after with a Before / After switch. **Auto** on the Master strip opens it in Master mode. The whole run is one undo step: see [[guide:auto-mix|Auto Mix & Master]].

[[show:automix.open|Show me Auto Mix]] [[action:autoMix|Open Auto Mix…]]

## Every stock effect

{{catalog:effect}}
`,
  },
  AUTOMIX_ARTICLE,
  RACKS_ARTICLE,
  {
    id: 'recording',
    title: 'Recording',
    summary: 'Record a vocal in the Vocal Booth, or MIDI notes and audio from the transport: count-in, quantize, monitoring and controller links.',
    group: 'Make music',
    icon: 'mic',
    body: `
You can record notes from a MIDI keyboard, audio from a microphone or interface, or both at once.

## Record a vocal (the easy way)

The **Vocal Booth** is one small panel for recording vocals. [[action:booth|Open the Vocal Booth]]

1. Open it: click the **record button** in the transport bar (in Audio mode), or Home ▸ **Recording Studio** ▸ **Open the Vocal Booth**. It makes a "Vocals" track with a vocal chain if you don't have one, switches to Song mode and arms recording.
2. Song empty? Click **Loop my beat** and your pattern repeats for 16 bars, so you have something to sing to.
3. Put on headphones and click **Hear yourself**. The line under the meter says whether your voice really reaches your headphones.
4. Click the playlist ruler where you want to start (or **Bar 1**), then hit **Record** or press [[Space]]. Sing, then **Stop** (or [[Space]] again).
5. Check the take: **Listen**, **Redo** (throws it away and records the same spot again) or **Keep** (the playhead moves after it, ready for the next part).
6. Click **Natural**, **Pop** or **Hard** under **Krypt Tune** to tune it. Krypt finds your key and tunes every take on the Vocals track.
7. Click **Done**. Your takes stay on the Vocals track; [[Ctrl+Z]] takes any of them back.

## Record a take

1. Pick what to record: right-click the **record button** in the transport bar (or click its small arrow) and choose **MIDI notes**, **Audio** or **MIDI + audio**.
2. Click the record button to arm it. With **Audio** or **MIDI + audio** this opens the Vocal Booth (above), which arms for you.
3. Press [[Space]] to play. Recording runs while the transport plays.
4. Stop the transport (or click the record button again) to finish.

A toast says what was recorded, for example "Recorded 12 notes into Pattern 1". Each take is one undo step.

## Where takes go

- **Notes** go to the selected channel.
  - In pattern mode, into the looping pattern. Each loop adds to it.
  - In song mode, into the pattern under the play position, or a new pattern on the first free track.
- **Audio** becomes a WAV file with its own audio-clip channel, mixer insert and a clip on the Playlist. The files go into a **recordings** folder next to your project.
- **Vocals**: Home ▸ **Recording Studio** tests your mic level and sets up a "Vocals" insert with a vocal chain and a "Vocals" track. Then every take plays through that chain and lands on that track. [[action:recording|Open the Recording Studio]]
- **Loop a section** in song mode (with a loop region on) and every pass becomes a take you can comp: see [[guide:takes-comping|Recording takes and comping]].

## Options

The record button's menu also has:

- **Quantize**: snap note starts to 1/4, 1/8, 1/16 or 1/32 (off by default).
- **Count-in**: one or two bars of clicks before recording starts.
- **Input monitoring**: hear your input through the speakers. Use headphones, or you will get feedback.

## Set up your inputs

Open **Settings** and look for:

- **MIDI input**: switch devices on or off. New devices are enabled automatically and show up within two seconds.
- **Audio input**: the input device and which channels (mono or stereo).
- **Recording**: the same mode, quantize and count-in choices.

[[action:settings|Open Settings]]

## Control knobs from your MIDI controller

1. Right-click a knob and choose **Link to controller…**
2. Move a knob, fader or pedal on your controller within 30 seconds.

To undo it, right-click the knob ▸ **Unlink**, or remove the link in Settings ▸ **Controller links**. Links are saved with your settings, not the project.

## Play from a gamepad or your keyboard

An Xbox, PlayStation (DualSense / DualShock) or Switch Pro controller, or your computer keyboard and numpad, can be a MIDI controller too. Open Settings ▸ **Controllers** and pick **Add a map…**:

- **Gamepad drum pads**: 14 pads from C2 on the face buttons, shoulders, triggers, D-pad and stick presses. Select a drum rack and play it.
- **Gamepad slice player**: the same pads from C4, for the Slicer's slices.
- **Gamepad scale player**: a minor pentatonic scale; the shoulders shift an octave.
- **Keyboard 4×4 pads** and **Numpad pads**: MPC-style pads on your keys.

Each map acts like a MIDI device called "Krypt: …": its notes play the selected channel and record like any keyboard, its sticks and triggers send CCs you can **Link to controller…**, and Start / Select play and arm recording. Click a binding, then press the button, stick or key it should use. Plug the pad in and press any button to wake it up.

!> Not yet supported: pitch bend and the mod wheel (sustain works). Record arm has no default shortcut: bind **Record arm** in Settings ▸ Shortcuts, or to a controller button. Monitoring switches itself off when the input and output sample rates differ. Controller maps work inside Krypt Studio only; other apps don't see them.
`,
  },
  TAKES_ARTICLE,
  {
    id: 'ai-agents',
    title: 'AI agents',
    summary: 'Connect Claude Code and friends, talk in plain words, undo anything an agent did.',
    group: 'AI and audio',
    icon: 'bot',
    body: `
Krypt Studio lets AI agents work in your project with you. Claude Code, Claude Desktop, Cursor and VS Code can write beats, design sounds, arrange, mix, and then **render and listen** to check their own work. You see every change happen live.

[[action:agents|Connect an agent]] [[action:agentPanel|Open the agent chat]]

{{video:ai-agents}}

## Connect Claude Code

1. Open **Home ▸ AI Agents**.
2. Click **Set up** next to Claude Code. Krypt Studio runs the setup command for you. (Or click **Copy** and paste the command into a terminal.)
3. Start a new Claude Code session and ask it to "use krypt-studio".

Claude Desktop, Cursor and VS Code work the same way: **Set up** adds Krypt Studio to their settings and keeps a backup. Restart the app afterwards. If Krypt Studio is closed when an agent needs it, it starts by itself.

## Just talk to it

You don't need special words. Ask the way you would ask a producer friend:

- "Make a 2-bar trap beat in F#m at 140."
- "Make the hats bouncier."
- "The low end sounds muddy. Can you fix it?"
- "Add a breakdown after bar 16."
- "Put the vocal from my first song on the second song's beat and tune it with Krypt Tune."
- "Export it as an MP3 with a cover."

In **Claude Code**, type \`/voice\` and hold [[Space]] to say it out loud instead. Claude Code also has ready-made prompts: \`/krypt-studio:beat\`, \`/krypt-studio:like\`, \`/krypt-studio:mixcheck\`, \`/krypt-studio:arrange\`, \`/krypt-studio:focus\` and \`/krypt-studio:mashup\`.

Ask for a song or a beat and the agent builds all of it before it answers: sounds, patterns for every section, the arrangement with transitions, the mix, and a check of the result. Your next prompt edits it. [[guide:ai-results|Getting great results from the AI]] has prompts that work, and [[guide:ai-limits|What the AI can and can't do]] is the honest list of its limits.

## Make a song like this one

Have a song you love? An agent can study it and write something new with the same feel.

In **Claude Code**, drag the song file from Explorer into the Claude Code window (that pastes its path) and say what you want. You can also paste the path: Shift + right-click the file in Explorer, pick **Copy as path**; the quotes are fine.

- \`make something like this "C:\\Users\\me\\Downloads\\song.mp3"\`
- \`Use krypt-studio to make an EDM song like this one: C:\\Users\\me\\Downloads\\song.mp3\`

In Krypt Studio's own **AI** panel, drop the song onto the message box, then send.

Or use a ready-made prompt:

- \`/krypt-studio:like C:\\Users\\me\\Downloads\\song.mp3 make it edm\`
- \`/krypt-studio:beat make an edm song like this song C:\\Users\\me\\Downloads\\song.mp3\`

What happens:

1. **The song opens.** By default agents can open any audio file on your PC (see **Which files agents can open** below). If you set File access to **Ask me**, you're asked first: pick **Allow this file** (until you close Krypt Studio), **Allow this folder** (adds it to the Browser, where you can remove it again) or **Deny**. The question appears in Claude Code. Apps that can't ask show a Krypt Studio dialog instead, and Krypt Studio's taskbar button flashes. Nothing is read until you answer, and after 2 minutes the agent is told you didn't.
2. **One study call.** The song lands on a muted track called **Reference: song**. Krypt Studio reads it on your PC: tempo, key and swing, which of its 18 genres it's closest to, the sections in bars and how loud each one is, the drum pattern, the chord loop, and the mix (loudness, low end vs highs, width).
3. **The recipe follows your song.** The genre recipe the agent builds from now uses your song's tempo, key and swing. It also follows its structure: where the drops and breaks land, and how long each part is. The sounds come from the genre you asked for (or the closest one).
4. **It builds the bed in one step:** drums with the reference's rhythm, its chords, a bass on its rhythm, the arrangement and the closest matching sounds. Then it writes its own **original** melody and hook.
5. It checks originality, matches the mix to the reference, then reviews the song: the review scores how close it is (tempo, key, groove, harmony, arrangement, sounds and mix) and the agent fixes what's off. [[guide:ai-results#make-something-like-a-song-you-love|Getting great results from the AI]] has the details.
6. It leaves the reference muted. Unmute its track to A/B the two.

!> Use songs you own or have the rights to. Krypt writes original music in a similar style; it never copies the song's melody, lyrics or hook. A song that ends up too close to a record can still infringe it, so trust your ears and the originality check.

## Which files agents can open

It's your computer, so by default an agent can open **any audio file on your PC**: a song in Downloads, a vocal on your desktop. Change it in **Settings ▸ Agents ▸ File access**:

| Setting | What agents can open |
|---|---|
| **Anywhere on this PC** (default) | Any audio file or folder you point them at. No questions. |
| **Ask me** | Your Browser folders and your project's files open directly. For anything else Krypt Studio asks you first. |
| **Browser folders only** | Only the factory kit, your Browser folders and your project's files. It never asks. |

- Songs you dropped into your project always work, in every mode, by their clip, their channel or their file path. So "analyze the song I just dropped in" just works.
- Network paths (like \\\\server\\share) are always refused: opening one can send your Windows login to that computer. Device paths and files that aren't audio are refused too.
- The optional HTTP endpoint for agents never gets "Anywhere": it is treated as **Ask me**.

[[action:settings|Open Settings]]

## What agents can and can't do

| Agents can | Agents can't |
|---|---|
| Write and change patterns, notes and channels | Save or open your project files |
| Set knobs, add effects (stock or your installed plugins), route and sidechain | Read network paths or files that aren't audio |
| Arrange the Playlist, add transitions and draw automation | Download models or sound packs |
| Render a preview, read its loudness, peaks and key, and compare it with a reference song | See the notes inside your reference songs |
| Detect tempo, split stems, turn audio into a pattern | Delete your files or your library records |
| Bring in audio from your PC (under your File access setting), or audio they hold | Write files anywhere but Krypt Studio's imports folder, your presets and your exports folder |
| Match a vocal's key and tempo to a beat, and tune it with Krypt Tune | Turn on deep library analysis without a stem model you installed |
| Set the song info and cover, and export a WAV or MP3 | Choose where an export goes, or overwrite a file |

## Export it with an agent

Say "export it as an MP3 with a cover". The agent fills in the song info (title, artist, album …), uses an image you point it at or generates a cover from your song, and saves a **new** file in **Music ▸ Krypt Studio**. If you prefer, **Settings ▸ Project ▸ Agent exports go to** puts it next to your project file instead. It never overwrites a file: a second export becomes "Song (2).mp3". The **Exporting** guide shows where the cover appears.

Agents can also bring in songs, match a vocal's key and tempo to a beat and tune it with Krypt Tune: the **Vocals, tuning & mashups** guide shows how.

## Undo anything an agent did

Every agent request becomes one named entry in **Edit ▸ History**, tagged with the agent's name.

- **Revert** undoes one entry. **Revert all AI edits** undoes everything that agent did and keeps your own edits. [[show:history.revertAgent|Show me]]
- [[Ctrl+Z]] only undoes **your** edits. Use History (or ask the agent to undo) for theirs.
- The **Kill switch** in the Agents panel disconnects every agent at once. Settings ▸ Agents has the same switch.

[[action:history|Open History]]

## The built-in agent chat

The **Agents** panel has a chat that works with your own API key from **Anthropic** (Claude), **OpenAI** (ChatGPT) or **OpenRouter** (many AIs with one key). The key is stored encrypted on this PC and only sent to the company it is from. Connected apps like Claude Code don't need a key from you here.

## Privacy

- Agents reach Krypt Studio only on your PC, through a private pipe with a new password every launch. The optional HTTP endpoint for agents stays off unless you turn it on in Settings.
- What an agent reads from your project goes to the AI service of the app you use (for example Anthropic for Claude), under that app's terms.
- Krypt Studio itself has no telemetry and sends nothing anywhere.
`,
  },
  {
    id: 'audio-tools',
    title: 'Audio tools',
    summary: 'Tempo & key, stems, audio to pattern, vocal tuning, matching, follow tempo, and the Model Manager.',
    group: 'AI and audio',
    icon: 'wave',
    body: `
Krypt Studio can listen to audio on your PC: find its tempo and key, split it into stems, and turn it into notes. All of it runs on your own computer. Your audio never leaves it.

{{video:audio-tools}}

## Where to find them

Right-click an **audio clip on the Playlist**. You get:

- **Detect tempo & key**
- **Separate stems**
- **Convert to pattern** ▸ **Melody & chords**, **Single line** or **Drums**
- **Tune vocal** ▸ **Natural**, **Pop** or **Hard**
- **Match key & tempo to** ▸ **Project**, or another audio clip
- **Mashup with…** (Playlist clips only): [[guide:auto-mashup|Auto Mashup]] with this clip as song A

The same items are in the Channel Rack menu of an audio channel; a sampler channel gets **Detect tempo & key** and **Convert to pattern**. In the Browser and the Library you get **Detect tempo & key**. Tuning and matching are explained in the **Vocals, tuning & mashups** guide.

> To turn a whole song into an editable project in one go (stems, patterns, sounds and sections), use **File ▸ Open audio as project…**: see [[guide:audio-to-project|Turn a song into a project]].

> To make one mashup from two songs in one step, use **Tools ▸ Auto Mashup…**: see [[guide:auto-mashup|Auto Mashup]].

[[action:playlist|Open the Playlist]]

## Detect tempo & key

Opens a **Tempo & key** window with the tempo (and half / double-time alternatives), the key, swing, sections, loudness and stereo width. Values marked **estimated** are best guesses. From there you can **Use … as project tempo** or make the clip **Follow project tempo**.

## Separate stems

Splits a clip into **drums**, **bass**, **vocals** and **other**. Each stem lands on a new track under the original, lined up, and the original clip is muted. It needs the **HT-Demucs** model (a one-time download in the Model Manager). On a DirectX 12 graphics card it runs on the GPU and takes a few seconds per minute of audio; on the CPU, closer to half a minute.

## Convert to pattern

- **Melody & chords** writes every note one instrument plays (piano, keys, guitar) into a new pattern.
- **Single line** writes one melody line, like a bassline or a vocal.
- **Drums** writes Kick, Snare, Hat, Open Hat and Perc channels.
- **Whole song → parts…** is for a full mix. It opens Audio → Project, which splits the song into stems first and writes drums, bass, chords and lead on their own.

Use the first three on **one part**: a stem, a loop or a solo instrument. On a full mix they hear the drums, vocal and bass all as notes, and the result is a mess. Separate stems first, then convert the bass or the drums.

The notes follow the clip as you hear it. If you pitched it (say, with Match key & tempo), warped it or reversed it, the pattern is moved the same way and lines up with the clip.

**Single line** and **Drums** play the notes with the audio itself. Every note (or drum hit) is its own piece of the original recording, so the new pattern sounds like the stem it came from, not like a stand-in synth. You can still edit it:

- Move or delete notes and they play the same piece of audio.
- Transpose a note and it plays the nearest recorded note, pitched.
- Draw a new note and it plays a real note from the song.
- The note's **velocity** picks which recording plays, not how loud it is. Leave it as it is to keep the original.

On a separated stem, the menu marks the mode that fits it (**Drums** for the drum stem, **Single line** for bass and vocals). **Melody & chords** is played by a synth: one recording of a chord can't be split across its notes.

## Tune and match

**Tune vocal** puts **Krypt Tune** first in the clip's mixer insert, set to the key Krypt detects, with a Natural, Pop or Hard feel. **Match key & tempo to** pitches the clip onto the key of the project or another clip (never more than 6 semitones) and makes it follow the tempo. Both are one undo step, and AI agents use the same tools (\`tune_vocal\`, \`match_clip\`).

## Follow tempo, stretch and pitch

Open an audio clip channel's window (click its name in the Channel Rack). Under **Stretch & pitch**:

- **Follow tempo** stretches the clip to the project tempo. It needs the clip's **Source BPM**; **Detect tempo** fills it in. Loops with a known tempo (factory and pack loops, or a file name like \`drums_92bpm.wav\`) get it on their own when you drop them on the Playlist.
- **Stretch** slows down or speeds up (0.25× to 4×).
- **Pitch** moves it up to 24 semitones up or down, and **Formants** keeps voices natural.

The clip is silent for a moment while the new version renders.

For a recording that drifts (a live drum break, a vocal sung without a click), pin its beats to the grid instead: see [[guide:warping]].

## Model Manager

Lists the on-device models, their licences and whether they are installed:

| Model | Used for | Install |
|---|---|---|
| Beat This! (small) | Beats and downbeats | Built in |
| Basic Pitch | Melody & chords | Built in |
| HT-Demucs (4 stems) | Separate stems | Download, about 163 MB |

Before a download you see the licence and any notes about the training data. Every file is checked before it is used. The header says whether a GPU (DirectML) is available. Running jobs show in the status bar; click there to cancel one.

[[action:modelManager|Open Model Manager]]
`,
  },
  {
    id: 'warping',
    title: 'Warping audio to the grid',
    summary: 'Warp markers pin beats in a loop or a live recording to the project grid: auto-warp, drag, warp modes.',
    group: 'AI and audio',
    icon: 'wave',
    body: `
**Warping** makes audio play in time with your project, even when it was played live and drifts. A **warp marker** pins one moment of the audio to one beat of the grid. Between two markers the audio is stretched so it arrives exactly on time.

Use it for a drum break that speeds up, a loop that isn't quite on the beat, or a vocal sung without a click. For a loop that is already steady, **Follow tempo** in the [[guide:audio-tools#follow-tempo-stretch-and-pitch|Stretch & pitch]] settings is enough.

## Open the warp view

Open the audio clip's channel window: click its name in the Channel Rack. The sample waveform shows the beat grid the clip plays with, with bar numbers. Under **Stretch & pitch** there is a **Warp** section.

## Auto-warp

Click **Auto-warp**. Krypt Studio finds the beats in the audio on your PC and puts one marker on every bar (pick **Every beat** next to the button for playing that drifts a lot). The audio's first downbeat lands on a bar line. A progress bar shows while it listens, and a message tells you how many markers it placed and the tempo it found.

[[show:warp.auto|Show me]]

- If it heard the loop in half time, each beat counts as two, so the loop keeps its speed.
- A stem is beat-tracked on the song it came from, because the full mix has the clearest pulse.
- Auto-warp also picks a mode: **Beats** for drums, **Tones** for a single voice, **Complex** for a full mix.
- It's one undo step: [[Ctrl+Z]] puts everything back.

## Fix a marker by hand

[[show:warp.markers|Show me]]

- **Drag** a marker left or right to move the audio under it. The marker keeps its beat, so you are choosing which hit lands on that beat. It stops at its neighbours.
- **Double-click** the waveform to add a marker on the nearest 16th of the grid. Nothing moves until you drag it. Hold [[Alt]] to place it exactly where you click.
- **Right-click** a marker to remove it.
- **Clear** removes every marker.

Each marker shows its bar and beat, like **5.1** for bar 5, beat 1. On the Playlist, warped clips show small ticks where their markers are.

> With two or more markers, the markers set the timing, and the **Follow tempo** and **Stretch** settings are ignored. Pitch and formants still apply, except in **Re-pitch** mode.

## Warp modes

[[show:warp.mode|Show me]]

| Mode | Best for | How it sounds |
|---|---|---|
| Complex | Full mixes | High quality stretching for everything at once |
| Tones | Vocals, bass, leads | Tuned for one note at a time |
| Beats | Drums | Cuts the audio at each hit, so drums stay punchy. **Slices** and **Fade** set where it cuts and how each slice ends |
| Texture | Pads, noise, ambience | Grains of sound. **Grain** sets their size, **Flux** adds movement |
| Re-pitch | Turntable effects | Speed and pitch change together |

**Off** removes the warp, and the clip plays exactly as before.

## Ask the AI

AI agents warp clips with the same commands, using the \`warp_clip\` tool. For example: "warp the drum break to the grid". Everything they do can be undone in the History panel.
`,
  },
  {
    id: 'vocals',
    title: 'Vocals, tuning & mashups',
    summary: 'Krypt Tune, matching a vocal to a beat, and whole mashups in one step or with an agent.',
    group: 'AI and audio',
    icon: 'vocal',
    body: `
Put a vocal on a beat, keep it in tune, and build a whole mashup. Everything runs on your PC.

> For a whole mashup from two songs in one step (vocal over beat, a stem blend, or the two trading sections), use **Auto Mashup**: see [[guide:auto-mashup|Auto Mashup]]. This guide covers the pieces it's built from, for when you want to do it by hand.

> No vocal yet? [[guide:krypt-voice|Krypt Voice]] types one: spoken tags and ad-libs, or lyrics sung on your melody with Sing my notes.

[[action:autoMashup|Make a mashup…]] [[action:playlist|Open the Playlist]] [[action:agents|Connect an agent]]

## Krypt Tune

**Krypt Tune** is Krypt Studio's pitch correction. It listens to a voice, or any instrument that plays one note at a time, and pulls each note to the nearest note of a key and scale. Add it to a vocal's mixer insert like any effect, or let **Tune vocal** set it up for you.

| Control | What it does |
|---|---|
| **Key** and **Scale** | The notes it pulls to. Pick the song's key. **Chromatic** allows every note, so it only fixes notes that are off pitch. |
| **Retune speed** | How fast a note is pulled in. 0 ms snaps instantly: the robotic sound of trap and pop records. 30 to 80 ms sounds natural. |
| **Humanize** | Lets long notes keep their vibrato and slides, while the start of each note is still caught. |
| **Amount** | How much of the correction is applied. 100 % is all of it. |
| **Mix** | Blends in the untouched voice. |

> It follows one voice at a time, between about 60 Hz and 1000 Hz. It adds about 15 ms of delay, and the mixer makes up for it.

## Tune a vocal

Right-click an audio clip on the Playlist ▸ **Tune vocal** ▸ pick a style:

| Style | Retune speed | Humanize | Sounds like |
|---|---|---|---|
| **Natural** | 60 ms | 40 % | A good singer on a good day |
| **Pop** | 25 ms | 20 % | A tight, polished radio vocal |
| **Hard** | 0 ms | 0 % | The robotic trap effect |

Krypt finds the key by itself: from the vocal, or from the rest of the song when the vocal alone isn't clear. The message says which. Krypt Tune goes **first** in the vocal's effects, before any EQ or compressor, and picking a style again changes that same Krypt Tune instead of adding a second one. It is one undo step.

## Match key & tempo

Right-click an audio clip ▸ **Match key & tempo to** ▸ **Project**, or another audio clip:

- **Key:** the clip is pitched by the smallest step that puts it on the other key, never more than 6 semitones up or down. A minor and C major share the same notes, so an A minor vocal on a C major beat isn't moved at all. Formants are kept, so voices still sound like themselves.
- **Tempo:** the clip follows the project tempo, stretched from its own tempo. When reading it at half or double time means less stretching, Krypt does that: a 96 BPM vocal on a 142 BPM beat is read as 192.
- **Another clip** that plays at its own tempo becomes the beat: the project tempo is set to its tempo so it plays unstretched, and the clip you matched follows it.

Big stretches, about a third faster or slower or more, are flagged because they can sound grainy. Read the message, then listen. Undo puts everything back.

## Mashups with an agent

With Claude Code, Claude Desktop or another connected agent, a mashup is one sentence:

- "Import these two songs, put A's vocal on B's beat, tune it hard."
- "Use the vocal on track 1 with the instrumental on track 3. Keep it natural."

Agents start with the \`auto_mashup\` tool: the same one-step builder as [[guide:auto-mashup|Auto Mashup]], with every option, plus a dry run that only checks the fit. For finer control they can also work step by step. In Claude Code, \`/krypt-studio:mashup\` starts the same workflow. Step by step, the agent:

1. Brings the songs in, from your PC (it asks you first about files outside your Browser folders) or as audio it holds, and reads their tempo, key and sections.
2. Splits both into stems: drums, bass, vocals and other. This needs **HT-Demucs** from the Model Manager. Agents can't download it, so install it first.
3. Keeps one song's vocals and the other song's drums, bass and other, and mutes the rest.
4. Matches the vocal's key and tempo to the beat, then tunes it with Krypt Tune.
5. Arranges an intro, a drop with the vocal and a break, renders a preview, and checks the loudness and that the vocal isn't buried.
6. Tells you what it did and offers variations.

The whole mashup is one entry in **Edit ▸ History**, so one click undoes it.

[[action:modelManager|Open Model Manager]] [[action:agentPanel|Open the agent chat]]

!> Only use songs you have the right to use. A mashup of other people's records is fine for practice and private listening; releasing it needs permission from the rights holders.

## Good to know

- Separate stems first: matching and tuning work best on a clean vocal.
- Krypt Tune follows one voice. Backing vocals and harmonies on the same stem can make it jump between notes.
- Audio an agent sends as bytes is stored once in Krypt Studio's data folder (in \`imports\`), and saved projects keep pointing at it.
`,
  },
  MASHUP_ARTICLE,
  VOICE_ARTICLE,
  {
    id: 'reference-library',
    title: 'Reference library & focus',
    summary: 'Teach Krypt your sound from your own songs, then let the AI compose in that style.',
    group: 'AI and audio',
    icon: 'library',
    body: `
The reference library learns a style from **your own songs**. Import folders into collections ("Dark trap", "90s R&B"). Krypt analyses every track on your PC and sums each collection up as a **style profile**: tempos, swing, keys, drum patterns, bass habits, chords, song structure and mix levels. AI agents can then compose from that profile.

!> Only import music you own or have the right to analyse: your own productions, licensed tracks, Creative Commons or public-domain music. Krypt never downloads songs and never ships a library.

[[action:library|Open the Library]]

## Add your music

1. Open the Library and click **New collection from a folder…**, or drop a folder onto it.
2. Add more with **Add folder…** (subfolders too) or **Add files…**, or drop files onto a collection.

Files are never copied, moved or changed. The library keeps only what it measured, never the audio. Removing a track or a collection deletes only those records.

## Quick and deep analysis

- **Light analysis** runs on every track: tempo, key, beats, sections, loudness, drums and rough chords. About a second to a few seconds per song.
- **Deep analysis** is per collection: switch on **Deep** in the header. It splits each song into stems, then transcribes the drums, bass, vocals and other parts. It needs the HT-Demucs model and takes much longer, so Krypt shows a time estimate first. The stems are deleted after each track.

The queue survives restarts. **Pause** stops it, and failed tracks can be retried.

## Style profile

Open a collection's **Style profile** tab to see what your songs have in common: **Tempo & feel**, **Keys**, **Drum grid**, **Bass & 808** (deep only), **Harmony**, **Structure**, **Mix targets** and example patterns. A very mixed collection gives a vague profile; split it into smaller ones.

**Find similar** (right-click a track) lists tracks with a similar feel: tempo, key, drums, loudness and width. It doesn't compare melodies.

## AI focus

Choose a collection as the **AI focus** with **Use as AI focus** on its profile, or **Tools ▸ AI focus**. You can add a short brief in your own words, like "dark, sparse, lots of space". The focus shows in the title bar; click it to see the profile, or the × to clear it. Connected agents and the built-in chat now compose in that style.

## Originality check

**Tools ▸ Check originality…** compares your melodies with the deep-analysed songs, and flags runs of 8 or more notes that match (even transposed).

- Drums and chord progressions are never flagged: everybody uses them.
- It is reliable on bass, 808 and vocal lines, and weaker on soft synth leads buried under pads.
- It is a production aid, **not legal advice**, and can't prove that something is original.

[[action:checkOriginality|Check originality now]]
`,
  },
  {
    id: 'sounds-presets',
    title: 'Sounds & presets',
    summary: 'Load, browse and save presets and effect chains, use the factory sounds, bring your own packs and music, and how agents pick sounds.',
    group: 'Make music',
    icon: 'presets',
    body: `
A **preset** is a ready-made sound: an instrument with all its settings, sometimes a sample, and often the effects it was designed with. Krypt Studio comes with factory presets for every part of a song, and you can save your own. An **effect chain** is a preset for a mixer insert: a few effects with their settings.

[[action:presets|Browse presets]] [[action:sounds|Sounds & Plugins]]

{{video:sounds}}

## Load a preset on a channel

1. Open a channel's plugin window: click the channel's name in the Channel Rack.
2. The **preset bar** sits under the channel's name. Click the preset name to open the preset browser.
3. Type to search ("dark pluck", "808"), click a genre to filter, or click a tag on a preset.
4. Click a preset, or pick one with the arrow keys and press [[Enter]].

- The arrows on either side of the name step to the previous or next preset for the same instrument.
- **With effects**, at the bottom of the preset browser, also loads the preset's effects onto the channel's mixer insert. A channel that shares its insert, or plays straight into the master, gets an insert of its own first.
- Loading a preset is one undo step: [[Ctrl+Z]] brings your old sound back.
- A pink dot after the name means you changed the sound since you loaded the preset.

> Third-party VST3 and CLAP instruments don't get the preset bar. Use the presets in the plugin's own window.

## Browse presets in the Browser

The Browser ([[Alt+F8]]) starts with **Presets**: one folder per role (kicks, 808s, leads, pads and so on) plus **Effect chains**. Your own presets have a small person icon.

- Double-click a preset, or drag it onto the Channel Rack, to add a new channel that plays it.
- Drag a preset onto a plugin window's preset bar to load it on that channel.
- Right-click a preset to load it onto the selected channel. Your own presets can also be renamed or deleted there.
- The search box at the top searches presets and factory sounds too.

## Save your own preset

1. Shape a sound on a stock instrument.
2. Click **Save…** on the preset bar.
3. Give it a name and a role (lead, bass, pad…). Genres, tags and one line of description help you and the agents find it later.
4. Leave **Include effects** on to keep the effects of the channel's insert with it.

Your presets are saved in the app's data folder, so every project can use them. **Home ▸ Sounds & Plugins ▸ Your presets folder** opens that folder.

## Effect chains on the mixer

- Right-click a mixer insert, or click its name above its effects, and choose **Load chain…**. **Replace** swaps the insert's effects for the chain. **Append** adds the chain after them.
- The **Chains** button above an insert's effects opens the same list. You can also drag a chain from the Browser onto the effects.
- On the master, the master chains come first.
- **Save chain as preset…** keeps the insert's effects as a chain of your own.

## Factory sounds

Under **Factory sounds**, the Browser sorts the bundled samples by kind: kicks, snares, hats, 808s, one-shots, and transition effects like risers, downlifters, impacts, sweeps, reverse cymbals and sub drops, plus textures and more. [[show:browser.factory|Show me]]

- Tonal sounds show their root note.
- Tempo-synced effects show their length in bars. Dropped on the Playlist, they follow the project tempo by themselves (**Follow tempo** with the tempo the sound was made at), so a 4-bar riser placed 4 bars before a drop ends right on it, at any tempo. Agents do this for you with \`add_transition\`; [[guide:transitions|Transitions]] explains where each kind goes.
- Click to hear a sound, double-click to add it as a sampler channel, or drag it onto the Channel Rack or the Playlist.

They are made by Krypt Studio's own engine and are MIT-licensed like the app: use them in anything.

## More like this

Found a kick that's almost right? Right-click it in the Browser and choose **More like this**. It works on factory sounds, sound pack sounds, instrument presets and audio files in your own Browser folders. [[show:browser.similar|Show me]]

- The Browser lists the closest sounds by timbre, best first. Each one has a similarity score and a short note on how it differs, like "darker, shorter tail".
- **Same kind** keeps to the same kind of sound (a kick finds kicks). **Any kind** compares everything.
- Click a result to hear it, double-click or drag it onto the Channel Rack, or hover and click the swap icon to load it onto the selected channel. Right-click a result to search again from there.
- The first time, sound pack sounds are measured while you watch. **Stop** shows what's ready so far. The arrow at the top goes back to the Browser.

Agents can do the same with \`find_samples\` and \`find_presets\` and a \`like\` sound.

## Sound packs: real recorded sounds

**Home ▸ Sounds & Plugins ▸ Sound packs** offers optional downloads of real recorded instruments, such as a grand piano, an acoustic drum kit, orchestral strings and brass, and mallets, and packs of recorded sound effects. They come from free CC0 and public-domain sources. Each card shows what the pack adds, its download size, the memory it uses, and its licence and credit before you download anything. Click **Download** to get a pack. Krypt Studio checks every file against its SHA-256 before it installs the pack, and **Cancel** keeps the finished files, so the next Download picks up where it stopped. Once a pack is installed, its presets play in the Krypt Multisampler like any other preset. Until then, they show a **Download pack** button in the preset browser. The sounds of a sample pack appear in the Browser's **Sound packs** section [[show:browser.packs|Show me]]. Agents use installed packs and suggest one when a real instrument would help, but only you can download them. **Remove** deletes a pack again, and a project that uses a pack you don't have says which one to download.

[[action:sounds|Open Sound packs]]

More on packs, your own folders and licences: [[guide:sound-packs|Sound packs & your own samples]].

## How agents pick sounds

Agents don't guess knob settings. They ask for a sound by **role** and **genre**, like "a dark pluck for future bass", and Krypt Studio picks the best fitting preset, yours included. A channel an agent adds by name ("808", "Lead") gets a fitting preset too. Agents can also load effect chains, save presets, and search the factory sounds, your installed sound packs and your sample folders.

What an agent loads shows in the preset bar, and you can undo it like any other change.

## Bring your own packs and music

Krypt Studio gets better with your own material. Three things help most:

- **Your sample packs.** Add a pack's folder to the Browser with the folder button at the top of the Browser, or in one click from **Home ▸ Sounds & Plugins ▸ Found on this PC**. That list shows the sample folders in the usual places (Documents, Music, Downloads), each with an **Add to Browser** button. Once a folder is in the Browser, agents can find and use its sounds too: their \`find_samples\` tool searches your Browser folders as well as the factory sounds.
- **Your music.** Import songs you love into the **Reference Library**. Krypt analyses them on your PC and sums each collection up as a style profile. Set a collection as the **AI focus** and agents learn your taste: they read it with \`get_style_profile\` and compose in that style, without copying your songs.
- **A human feel.** In the Piano Roll, **Tools ▸ Groove** makes programmed drums feel played. Its templates hold the timing and accents of real drummers, from the Groove MIDI Dataset (CC BY 4.0).

[[action:sounds|Open Sounds & Plugins]] [[action:library|Open the Reference Library]] [[action:browser|Open the Browser]]
`,
  },
  {
    id: 'sounds-plugins',
    title: 'Sounds & plugins',
    summary: 'The factory kit, the Browser, stock instruments and your VST3 / CLAP plugins.',
    group: 'Make music',
    icon: 'blocks',
    body: `
## The Browser

The Browser ([[Alt+F8]]) holds your **Presets**, the **Factory sounds**, the sounds of your installed **Sound packs**, the **Demo projects** and any folders you add with the folder button.

- Click a sample to hear it. Click again to stop.
- Double-click it (or right-click ▸ **Add to Channel Rack**) to make a sampler channel.
- Drag it onto the Channel Rack, onto a channel, or onto the Playlist (as an audio clip).

The **factory sounds** (drums, 808s, one-shots, risers, impacts and other transitions, textures) are made by Krypt Studio's own engine. They are MIT-licensed like the app: use them in anything. Presets and the factory sounds have a guide of their own, [[guide:sounds-presets|Sounds & presets]], and the optional packs and your own folders are in [[guide:sound-packs|Sound packs & your own samples]].

[[action:browser|Open the Browser]] [[action:presets|Browse presets]]

## Stock instruments

{{catalog:instrument}}

## Your VST3 and CLAP plugins

The **Plugin Manager** scans the standard VST3 and CLAP folders, plus any folder you add. Your plugins then show up under **Installed** when you add a channel or an effect.

- **Rescan** picks up new and changed plugins. **Full rescan** checks everything again.
- **Problems** lists plugins that failed or crashed while being scanned. Each one has **Retry**.
- VST2 plugins aren't supported. The Plugin Manager tells you how many it skipped.
- **Open plugin window** (right-click the channel or effect slot) shows the plugin's own interface. Changes you make there can be undone.

[[action:pluginManager|Open Plugin Manager]]

## If a plugin crashes

Third-party plugins run in a separate helper program, away from the audio engine and the app. If that helper crashes, your project and the stock instruments keep playing; the plugins go silent and a banner offers **Reload plugins**. A plugin that hangs is restarted automatically.

!> All third-party plugins share that one helper, so one crash silences all of them until you click **Reload plugins**.
`,
  },
  {
    id: 'exporting',
    title: 'Exporting',
    summary: 'Render your song, a pattern or the loop region to WAV or MP3 with song info and cover art, stems into a folder, and patterns to MIDI.',
    group: 'Make music',
    icon: 'download',
    body: `
Export renders your music offline, faster than real time, into a WAV or MP3 file you can share or upload, with your song's title, artist and cover art inside it.

[[action:export|Export audio…]]

## Export audio

1. Press [[Ctrl+R]] (or **File ▸ Export audio…**).
2. Fill in **Song info & cover** (see below). It is saved with your project, so you only do it once.
3. Choose what to render: **Song**, **Pattern** (with how many loops) or **Loop region** (when you set one on the Playlist ruler).
4. Choose the format: **16-bit**, **24-bit** or **32-bit float** WAV at your audio device's sample rate, or **MP3** at **320**, **256**, **192** or **128** kbps. MP3 uses Windows' own encoder (Windows N editions need the Media Feature Pack).
5. **Tail**: **Leave remainder** keeps the echo and reverb ringing after the last note for the **Tail length** (2 seconds by default, up to 30); **Cut** stops right at the end.
6. **Normalize** sets the loudest peak to −0.1 dB. Leave it off when your master limiter already sets the level.
7. Click **Export…** and pick the file name.

Your choices are remembered. Progress shows in the status bar. When it's done, a toast tells you the length, the peak level and the loudness in LUFS, and the folder opens if you asked for it.

## Song info & cover

- **Title** (blank = your project's name), **Artist** (blank = the author from Project info), **Album**, **Year**, **Genre** and **Track #** go into the file, so music players and Windows Explorer show them.
- **Choose image…** takes a PNG or JPEG up to 20 MB. It's cropped to a square from the centre and scaled to at most 1400 × 1400.
- **Generate** draws a cover from your song: its notes become waves, a grid, an orbit or bars in the Krypt colours, with the title and artist on top. Pick the look in the list, or press **Shuffle** for another one.
- **Remove** takes the cover off. Every cover change is one undo step, and the image is saved inside your .kstudio file.

## Where the cover shows

| | MP3 | WAV |
|---|---|---|
| Title, artist, album, year, genre, track # in Windows Explorer | Yes | Yes |
| Cover as the file's thumbnail in Explorer | Yes | No: Windows doesn't show WAV covers |
| Cover in music players | Yes, everywhere | In most players (VLC, foobar2000, Mp3tag and others) |

> Want the cover everywhere? Export MP3. WAV keeps the full quality, and its song info still shows in Explorer.

## Stems

Stems are your song split into one file per mixer insert, for a mix engineer, a remix or a live set.

1. In the Export dialog, set **Output** to **Stems**, or choose **File ▸ Quick export ▸ Stems into a folder…** (24-bit WAV).
2. Pick a folder. Krypt Studio makes a new folder inside it named after your song, like **My Song stems**, so nothing is overwritten.

Inside are one file per insert that plays, named like **01 Kick**, plus **Master**, the whole mix. They all come from one render, so they line up to the sample and add back up to your song.

- Each stem is the insert as you hear it in the mix: after its effects, fader and pan.
- Stems are never normalized and carry no song info, so every one keeps its level in the mix.
- Inserts that stay silent over the range are left out.
- The toast says how many stems were written; **Show in folder** opens them.

## Quick export

**File ▸ Quick export** skips the dialog: the song as WAV in 16, 24 or 32-bit, stems into a folder, or the active pattern loop as WAV.

## MIDI

- **File ▸ Quick export ▸ Active pattern as MIDI…** saves the notes of the active pattern.
- **File ▸ Import MIDI…** (or dropping a .mid file on the window) brings a MIDI file in as a pattern.

Releasing what you export? The [[guide:faq|FAQ]] covers using the factory sounds and sound packs in your music.

!> Not available yet: FLAC and OGG export, a whole-song MIDI export, and cancelling a render once it has started.
`,
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    summary: 'Every shortcut, straight from your current keymap.',
    group: 'Help',
    icon: 'keyboard',
    body: `
This list is built from your current keymap, so it includes any changes you made. To change a shortcut, open Settings ▸ **Shortcuts**.

[[action:shortcuts|Change shortcuts]]

{{shortcuts}}

## Mouse and knobs

- Knobs: drag up and down. Hold [[Ctrl]] for fine moves. Double-click resets.
- Right-click a knob for **Create automation clip** and **Link to controller…**
- In the Piano Roll and Playlist: [[Ctrl]]+wheel zooms, [[Shift]]+wheel scrolls sideways, middle-drag pans, and [[Alt]] turns snap off while you drag.

## The typing keyboard

With the typing keyboard on ([[Ctrl+T]]), the **Z** row and the **Q** row play notes on the selected channel. [[L]] is left out, because it switches pattern and song mode.
`,
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'No sound, engine restarts, plugin crashes, missing models, m4a / aac files.',
    group: 'Help',
    icon: 'lifebuoy',
    body: `
## No sound

1. Look at the engine pill in the transport bar. It should say **Engine**. If it says **Offline**, **Restarting** or **Engine failed**, click it ▸ **Restart engine**.
2. Open **Settings ▸ Audio**. Check the **Output device**, and click the rescan button if you just plugged something in. **System default** follows Windows.
3. Crackles or dropouts? Raise the **Buffer size** (256 is a good start, 512 if it still crackles).
4. Still nothing? Check that the channel, its mixer insert and the Master aren't muted, and that Windows' own volume is up.

If no device can be opened, Krypt Studio says so and keeps retrying every two seconds, so plugging the device back in is enough.

[[action:settings|Open Settings]]

## "Audio engine is restarting"

The audio engine is a separate program. If it crashes, Krypt Studio restarts it within a second or two, and your project stays exactly as it was. If it crashes five times in a minute, it stops trying: check your audio device, then use **Restart engine**.

## A plugin went silent

A banner says the plugin host crashed. Open the **Plugin Manager** (or the plugin's window) and click **Reload plugins**. If one plugin keeps crashing, remove it from the project or uninstall it. Plugins that crash while being scanned are blocked under **Problems**, with a **Retry** button.

[[action:pluginManager|Open Plugin Manager]]

## "The analyzer wasn't found" or "needs a model"

- **Analyzer missing:** the audio tools program isn't installed with the app. Reinstall Krypt Studio.
- **Needs a model:** stem separation needs **HT-Demucs**. Install it once in the Model Manager. A failed download can be retried, or installed from a folder.

[[action:modelManager|Open Model Manager]]

## m4a, aac or wma files won't open

wav, aiff, flac, mp3 and ogg always work. m4a, aac, mp4, wma and a few other formats use Windows' own decoders (Media Foundation). On **Windows N** editions those aren't installed: install the **Media Feature Pack** from Windows Settings ▸ Apps ▸ Optional features, or convert the file to wav or flac.

## My project after a crash

Krypt Studio restores your unsaved changes automatically the next time you start it, and the project's tab in the title bar shows a small **Rec** badge. Save to keep them. Each time you save over a project, the previous version is kept as a backup in the app's data folder (the last ten per project).

## Windows warns about the installer

The installer isn't code-signed yet, so SmartScreen says "Windows protected your PC": click **More info ▸ Run anyway**. The [[guide:faq|FAQ]] explains why, and what to do when Smart App Control blocks it.

## Still stuck?

Ask on the Krypt Discord, linked in **Help** and on the About page.
`,
  },
];

ARTICLES.push(...BEGINNER_ARTICLES, ...CORE_ARTICLES, ...LIBRARY_ARTICLES);

export const DEFAULT_ARTICLE = BEGINNER_FIRST;

export function articleById(id: string | null | undefined): GuideArticle | undefined {
  return id ? ARTICLES.find((a) => a.id === id) : undefined;
}

export const PLUGIN_NOTES: Record<string, string> = {
  'krypt.sampler': 'Plays a sample across the keyboard, with envelope, filter, reverse and loop. The default for drums.',
  'krypt.slicer': 'Chops a loop at its hits or on a grid, one slice per key, so a break replays at any tempo and rearranges note by note. Per-slice pitch, reverse and gain.',
  'krypt.audioclip': 'Plays Playlist audio in time, with follow tempo, stretch and pitch. Made for you when you drop audio.',
  'krypt.triosc': 'Three-oscillator synth for leads, pads and basses, with two LFOs for vibrato, wobble, tremolo gates, auto-pan and filter sweeps (free, retriggered or synced to the beat). The default for melodic channels.',
  'krypt.kick808': 'Tuned 808 and kick synth with pitch sweep, click, drive and glide.',
  'krypt.multisampler': 'Plays recorded multisampled instruments from sound packs (grand and upright piano, live drums, mallets, strings) with velocity layers and round robins.',
  'krypt.drumsynth': 'Synthesised drums: kick, snare, clap, hats, tom, rim, cowbell, crash and perc.',
  'krypt.fm': 'Four-operator FM synth for bells, keys and electric pianos.',
  'krypt.wavetable': 'Wavetable synth with five tables, unison and a sub oscillator.',
  'krypt.eq': 'Seven-band EQ: cut lows and highs, shape the middle.',
  'krypt.comp': 'Compressor that evens out levels; can be sidechained.',
  'krypt.limiter': 'Brickwall limiter with true peak: keeps the master from clipping.',
  'krypt.clipper': 'Soft or hard clipper for loud, punchy drums.',
  'krypt.reverb': 'Room, hall and plate reverb.',
  'krypt.delay': 'Tempo-synced stereo and ping-pong echo.',
  'krypt.drive': 'Tape, tube, hard clip, wavefolder and bitcrush distortion.',
  'krypt.filter': 'Low-pass, high-pass, band-pass and notch filter with an LFO.',
  'krypt.duck': 'Ducks the volume in time with the beat, or under a sidechain.',
  'krypt.utility': 'Gain, pan, stereo width, mono and polarity.',
  'krypt.analyzer': 'Spectrum, oscilloscope and LUFS / true peak meter.',
  'krypt.chorus': 'Chorus and ensemble for width and shimmer.',
  'krypt.flanger': 'Flanger, including a through-zero mode.',
  'krypt.phaser': 'Phaser with 4 to 12 stages.',
  'krypt.gate': 'Tempo-locked stutters, tape stops, reverse and gate patterns, or your own 16-step pattern of rolls, repeats, reverses and levels.',
  'krypt.vocoder': 'Vocoder with up to 40 bands: the sidechain is the voice, and the carrier is this insert or the built-in saw and noise.',
  'krypt.transient': 'Makes hits snappier or softer, and tails longer or shorter.',
  'krypt.squash': 'Aggressive three-band upward and downward compression.',
  'krypt.imager': 'Stereo width per band: keep the lows mono, widen the highs.',
  'krypt.heat': 'Three-band saturator: warm the lows, crunch the mids and fizz the highs separately, with seven shapes from tube to bitcrush.',
  'krypt.tapeecho': 'Tape delay with wow, flutter, saturated repeats and age. Push Feedback past 100% for runaway dub builds, or Freeze a loop.',
  'krypt.grain': 'Granular delay and freeze, plus a spectral blur mode, for shimmering pads, glitch textures and pitched clouds.',
  'krypt.deesser': 'De-esser: turns down harsh "s" and "t" sounds in vocals, only in the sibilance band, so the rest of the voice stays untouched.',
  'krypt.glue': 'Bus compressor that glues drums and mixes together, with fixed ratios, auto release and a sidechain high-pass.',
  'krypt.rack': 'Instrument rack: layer or split instruments by key and velocity, each with its own effects, under 8 macro knobs.',
  'krypt.drumrack': 'Drum rack: one pad per sound, each with its own effects and choke group. Slice a loop onto the pads.',
  'krypt.fxrack': 'Effect rack: run effects in parallel chains and control them with 8 macro knobs and saved variations.',
  'krypt.pitch': 'Real-time pitch correction to a key and scale: natural at 30-80 ms retune, robotic at 0 ms. Tune vocal sets it up for you.',
};
