// Start here (step by step) · 4: play, stop, tempo, metronome.
import type { GuideArticle } from '../articles';

export const TRANSPORT: GuideArticle = {
  id: 'step-play',
  title: 'Play, stop, tempo and metronome',
  summary: 'The buttons at the top: play and stop, pattern or song, the speed (BPM) and the click.',
  group: 'Start here (step by step)',
  icon: 'headphones',
  body: `
The bar across the top of the Studio is the **transport bar**: it plays and stops your music.

{{image:transport-map.webp|The transport bar: Play (1), Stop (2), PAT / SONG (3), the tempo (4), the time signature (5) and the metronome (6).}}

## Play and stop

1. Click **Play** (1, the ▶ at the far left), or press [[Space]]. [[show:transport.play|Show me]]
2. Press [[Space]] again to stop. Or click **Stop** (2, the ■ next to it).

> [[Ctrl+Space]] pauses: it stops where you are, and the next play carries on from there.

## Pattern or song

- **PAT** (3) loops the pattern you are working on. Use it while you make a loop.
- **SONG** (3) plays the whole Playlist from left to right.

1. Click **PAT** or **SONG** at the top to switch. [[show:transport.mode|Show me]]

## The tempo (speed)

The **tempo** is how fast the music goes, in **BPM** (beats per minute). 140 is the starting value; slow songs sit near 70 to 90, dance music near 120 to 130.

1. Double-click the number above **BPM** (4). [[show:transport.tempo|Show me]]
2. Type a new number, for example 120.
3. Press [[Enter]].

{{image:tempo-type.webp|Double-click the tempo, type a number, press Enter.}}

> You can also drag the number up or down, or scroll on it with your mouse wheel.

## The time signature

The **4/4** (5) means four beats in each bar. Most songs use it, so you can leave it alone. Click it if you want a waltz (3/4) or something rarer. [[show:transport.timeSig|Show me]]

## The metronome (click)

The **metronome** is a click on every beat, to help you keep time.

1. Click the **metronome** button (6, the little pyramid next to **SWING**), or press [[Ctrl+M]]. [[show:transport.metronome|Show me]]
2. Press [[Ctrl+M]] again to turn it off.

## Next

Keep your work, and turn it into a file you can share: [[guide:step-save-export]].
`,
};
