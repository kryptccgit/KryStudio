import type { GuideArticle } from './articles';

export const SESSION_ARTICLE: GuideArticle = {
  id: 'session-view',
  title: 'Live sets with the Session view',
  summary: 'Launch patterns and audio live from a grid of clips and scenes, then record the jam into the playlist.',
  group: 'Make music',
  icon: 'zap',
  body: `
The **Session view** ([[F3]]) is a clip launcher. It has one column per playlist track and one row per **scene**. Each slot holds one clip: a pattern or an audio clip. Launch clips to jam, try out ideas or play a set live, while the Playlist keeps your arranged song.

[[action:session|Open the Session view]]

{{video:session}}

## Fill the grid

Click **Scene** in the toolbar (or the **+** at the top of the scene column) to add a row. [[show:session.scenes|Show me]] Then put clips in the slots:

- Drag a pattern from the Playlist's pattern list, or drag the pattern picker in the transport bar or the Channel Rack.
- Drag an audio file from the Browser or from Windows Explorer. It gets its own audio clip channel and mixer insert, like on the Playlist.
- Drag a Channel Rack row: an audio clip channel plays as itself, and a sampler's sample becomes a new audio clip.
- Right-click an empty slot and pick **Add pattern** or **Add audio clip**.
- On the Playlist, right-click a pattern or audio clip and choose **Send to Session view**. It lands in its track's first empty slot.

**From arrangement** builds scenes from your song: one per section between markers, or one every 4, 8 or 16 bars. Each track's clip at that time becomes its slot. [[show:session.fromArrangement|Show me]]

Drag a clip to another slot to move it; hold [[Ctrl]] to copy it. Dropping on a full slot replaces that clip.

## Launch

- Click a clip's triangle to launch it. It starts at the next **launch quantize** boundary (1 bar by default; change it in the toolbar). While it waits, it pulses. [[show:session.quantize|Show me]]
- If the transport is stopped, launching starts it right away in Song mode.
- A playing clip glows green and shows a progress line along its bottom.
- Click a scene's triangle to launch the whole row. Tracks without a clip in that row stop. A scene can also set the tempo: click its **BPM** badge.
- The square buttons stop a track at the next boundary. **Stop all** stops every track. [[show:session.stopAll|Show me]]

Keys: click a slot to select it, then use the arrow keys to move. [[Enter]] launches the selected clip (on an empty slot it stops the track), [[Shift]]+[[Enter]] launches its scene, and [[Delete]] removes the clip.

## Back to arrangement

While a track plays a launch clip, its Playlist clips stay silent. That stays true after you stop it from the launcher. The track header shows a small arrow, and **Back to arrangement** lights up. Click it to hand every track back to the Playlist. [[show:session.backToArrangement|Show me]]

## Clip options

Right-click a clip for:
- **Rename**, **Color**;
- **Launch mode**: **Trigger** (click starts it), **Gate** (plays while you hold the mouse button or [[Enter]]), **Toggle** (click again to stop) or **Repeat** (restarts every quantize step while held);
- **Quantize**: its own launch timing, or the global one;
- **Loop**: off means it plays once, then the track stops;
- **Length**: how many bars loop (**Custom…** also sets a start offset);
- **Follow action…**: after a number of bars, do something else. Pick an action and a chance, plus the other action for the rest of the time. **Next** and **Previous** skip empty slots and wrap around; **Any** may pick the same clip again, **Other** never does.

Double-click a pattern clip to open it in the Piano Roll. Double-click an audio clip to open its audio clip settings.

## Record your set into the Playlist

Switch to **Song** mode ([[L]]), turn on **Record to arrangement** in the toolbar, press play and launch clips. When you stop, everything you launched is written into the Playlist as one undoable edit. Clips that were already on those tracks at those times are replaced. [[show:session.record|Show me]]

## Grid controllers

A MIDI pad grid can launch clips and scenes. Click the plug button in the toolbar, turn it on, pick the device and channel, and choose a layout: **Launchpad-style** (programmer mode), **APC mini-style** or a generic 8×8 note layout with a base note. **First track** and **First scene** pick which part of the grid the pads cover. Notes from the grid launch clips and don't play the selected channel. [[show:session.gridController|Show me]]

The pads light up to show the launcher: empty slots stay dark, clips show their colour, queued clips flash and playing clips pulse (red while you record launches). Krypt Studio finds the controller's output by its name; pick another one under **LEDs** if it guesses wrong, or turn the lights off there. A Launchpad X, Mini MK3 or Pro MK3 is switched to programmer mode for you, and back when you close the app. The APC mini shows green, yellow and red, and a generic grid lights the pads that play.

## Agents build sets too

AI agents can fill the launcher for you. Ask for "a live set with an intro, a verse and a drop scene" and the agent uses **build_session** (scenes with clips per track, follow actions and quantize, or scenes from the arrangement). It can also launch and stop clips and scenes, go back to the arrangement and record with **launch**. As always, every edit an agent makes can be undone (see [[guide:ai-agents|AI agents]]).

Exported audio always comes from the Playlist, never from the launcher. Record your set into the Playlist first if you want to export it.
`,
};
