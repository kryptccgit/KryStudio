// Start here (step by step) · 3: the first beat, click by click.
import type { GuideArticle } from '../articles';

export const FIRST_BEAT: GuideArticle = {
  id: 'step-first-beat',
  title: 'Your first beat, click by click',
  summary: 'Kick, clap and hats in the Channel Rack, play it, add a melody, then turn it into a song.',
  group: 'Start here (step by step)',
  icon: 'drum',
  body: `
You will make a **beat** (a short drum loop) in about five minutes. Start with a new project: press [[Ctrl+N]].

> Rather be shown? [[action:tourFirstBeat|Start the tour: your first beat]]

## 1. Find the Channel Rack

The **Channel Rack** is the box with your sounds. Each row is one sound (a **channel**). The squares on each row are **steps**: 16 steps make one **bar** (one count of 1-2-3-4).

{{image:beat-rack.webp|The Channel Rack: your sounds on the left (1), 16 steps per row (2).}}

1. Don't see it? Press [[F6]]. [[show:channelRack.steps|Show me]]

## 2. Click in the drums

A **kick** is the deep "boom" drum. Click a step once to turn it on; click it again to turn it off.

1. On the **Kick** row, click steps **1**, **5**, **9** and **13** (counting from the left).

{{image:beat-kick.webp|Kick: steps 1, 5, 9 and 13 are lit.}}

A **clap** is the sharp "clack" on the off-beats.

2. On the **Clap** row, click steps **5** and **13**.

{{image:beat-clap.webp|Clap: steps 5 and 13.}}

A **hat** (hi-hat) is the light "tss" that keeps time.

3. On the **Hat** row, click every second step: **1, 3, 5, 7, 9, 11, 13, 15**.

{{image:beat-hats.webp|Hat: every second step is lit.}}

> Made a mistake? **Right-click** a step to turn it off, or press [[Ctrl+Z]].

## 3. Play it

1. Click the **Play** button (the ▶ at the far left of the bar at the top), or press [[Space]]. [[show:transport.play|Show me]]

{{image:beat-play.webp|The Play button at the top-left. Space does the same.}}

2. Your beat loops. Press [[Space]] again to stop.

> No sound? See [[guide:step-help#no-sound|Help! No sound]].

## 4. Add a melody (optional)

The **Piano Roll** is where you draw notes. Higher on the grid = higher notes.

1. Press [[F7]] to open the Piano Roll.
2. At the top-left of the Piano Roll, click the sound name and pick **Keys** (a piano-like sound).
3. Click on the grid to add a note. Add a few. **Right-click** a note to delete it.

{{image:piano-roll-notes.webp|The Piano Roll: the sound you write for (1) and four notes drawn on the grid (2).}}

4. Press [[Space]] to hear the drums and your notes together.

## 5. Turn it into a song

So far you made a **pattern** (one loop). A song is patterns placed one after another in the **Playlist**.

1. At the top, click **SONG** (next to **PAT**). [[show:transport.mode|Show me]]
2. Press [[F5]] if you don't see the Playlist.
3. Click in the first row of the Playlist, at bar 1. Your pattern appears there.
4. Click just past its end to add it again. Each click adds one more copy.

{{image:song-paint.webp|Song mode is on (1), and the pattern is placed twice on the first Playlist row (2).}}

5. Press [[Space]] to play the song.

> **PAT** plays only the pattern you are editing, in a loop. **SONG** plays the Playlist from left to right. If you hear nothing, check which one is on.

## 6. Save it

1. Press [[Ctrl+S]], choose a folder and a name, then click **Save**. The next guide shows more: [[guide:step-save-export]].

## Next

Play, stop, the speed and the click: [[guide:step-play]].
`,
};
