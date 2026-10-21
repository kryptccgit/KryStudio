import type { GuideArticle } from './articles';

export const TAKES_ARTICLE: GuideArticle = {
  id: 'takes-comping',
  title: 'Recording takes and comping',
  summary: 'Loop a section, record it again and again, then build one perfect performance from the best bits.',
  group: 'Make music',
  icon: 'vocal',
  body: `
Singers rarely nail a whole verse in one go. With **loop recording** you sing the same section several times in a row; every pass becomes a **take**. Then you **comp**: pick the best line, word or breath from each take, and Krypt Studio stitches them into one performance with smooth crossfades.

## Record takes

1. Switch to **song mode** and set a **loop region** over the section: drag across the bar numbers above the playlist. [[show:playlist.markers|Show me]]
2. Choose what to record (right-click the record button: **Audio**, **MIDI notes** or both) and arm it. [[show:transport.record|Show me]]
3. Press [[Space]]. Sing or play along; each time the loop comes round, a new take starts. Stop when you have enough.

A toast says how many takes landed, for example "Recorded 3 audio takes on Recording". The whole loop recording is one undo step.

- **Audio** is one continuous WAV file in the **recordings** folder. Each take is a different stretch of that file, so nothing is cut or copied.
- **MIDI** gives one pattern per pass that has notes.
- A single pass (or a last pass shorter than a beat) is placed like a normal recording.

## The take lanes

The track that got the takes shows a small **lanes** button next to its M and S buttons. It opens by itself after recording; click it to show or hide the lanes. [[show:playlist.takes|Show me]]

- The **track row** is the comp: what you hear. It holds ordinary clips, so it plays, renders and exports like anything else.
- Under it, each **take lane** shows one take's waveform (or notes). The parts the comp uses are bright, with a pink line on top; the rest is dimmed.
- A pink dot next to a lane's name means part of that take is in the comp.

## Comp the best bits

- **Drag across a take lane** to use that take for that stretch. The pick snaps to the playlist's snap setting; hold [[Alt]] for no snapping. Each drag is one undo step.
- **Click a lane's name** to use that whole take wherever it was recorded.
- By default the comp starts as the **last** take; earlier takes fill in where the last one didn't reach (if you stopped halfway through the final pass).

## Crossfades and tidying up

Right-click a lane's name for more:

- **Crossfade**: hard cuts, 10, 20 (the default) or 50 ms. Every switch between takes fades one into the other, so there are no clicks.
- **Move lane up / down** to put your favourites on top.
- **Delete take** removes a take you'll never use. Where the comp used it, the latest other take fills in.
- **Flatten comp** keeps the comp as normal clips and removes the lanes and the takes it doesn't use. Do this when you're happy, to clean up the project.

!> Editing the comp rebuilds its clips: a clip of the comp you moved or trimmed by hand goes back to the comp. Insert time and delete time don't move take lanes yet, so comp before you rearrange the song.

## Ask an AI agent

Agents can comp too, with the **comp_takes** tool. Try: "list my takes", "use take 2 for bars 5 to 6 and take 3 for bar 7", "set the comp crossfade to 10 ms" or "flatten the vocal comp". Like any agent edit, you can undo it.
`,
};
