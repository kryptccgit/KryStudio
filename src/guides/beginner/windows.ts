// Start here (step by step) · 2: the windows, their keys, and how to get them back.
import type { GuideArticle } from '../articles';

export const WINDOWS: GuideArticle = {
  id: 'step-windows',
  title: 'The windows and how to get them back',
  summary: 'Every window, its key and its View menu entry. Closed one by accident? Three ways back.',
  group: 'Start here (step by step)',
  icon: 'layers',
  body: `
The Studio is made of **windows** (boxes you can move and close). Each one has a job, and most have a key on your keyboard.

> Rather be shown? [[action:tourWindows|Start the tour: windows and shortcuts]]

## What you see first

{{image:studio-map.webp|The Studio: the Browser (1), the Channel Rack (2), the Playlist (3) and the Mixer (4).}}

## Every window

Press the key once to open a window. Press it again to close it. Or click its name in the **View** menu at the top.

| Window | Key | View menu | What it is for |
|---|---|---|---|
| Channel Rack | [[F6]] | View ▸ Channel Rack | Your sounds, and the squares you click to make a beat |
| Piano Roll | [[F7]] | View ▸ Piano Roll | Drawing notes (melodies, chords, bass) for one sound |
| Playlist | [[F5]] | View ▸ Playlist | The whole song: your beats laid out from left to right |
| Mixer | [[F9]] | View ▸ Mixer | The volume and effects of each sound |
| Browser | [[Alt+F8]] | View ▸ Browser | Finding sounds, presets (saved sounds) and samples (recorded sounds) |
| Session | [[F3]] | View ▸ Session | Starting loops live, one row at a time |
| Guides | [[F1]] | View ▸ Guides | These guides, beside your work |
| Agents | the **AI** button | View ▸ Agents | Connecting an AI, and the built-in chat |
| History | none | View ▸ History | Every change you and the AI made, to undo |
| Home | [[Ctrl+Shift+H]] | View ▸ Home | The start screen with the big cards |
| Settings | none | Tools ▸ Settings… | Your speakers, shortcuts and more |

{{image:menu-view.webp|The View menu: Home (1), every window with its key (2), and Reset layout (3).}}

1. Click **View** at the top of the screen (between **Edit** and **Tools**). [[show:titlebar.view|Show me]]
2. Click the window you want. A tick means it is open already.

## Move, float and close a window

Every window has small buttons at the right of its title bar.

{{image:window-buttons.webp|A window's buttons: float it, give it its own window, make it big, or close it.}}

- The **square** floats the window over the others. Click it again to dock it back.
- The **two boxes** move it into its own window (handy on a second screen).
- The **arrows** make it fill the Studio.
- The **×** closes it.
- Drag a window's name (its tab) to move it somewhere else.

## Closed a window by accident?

Try these, in this order:

1. Press its key (the table above), for example [[F6]] for the Channel Rack.
2. Or press [[Ctrl+Z]] (undo). It brings back the window you just closed. If you changed something since, press it again: it undoes that change first.
3. Or click **View**, then **Reset layout** (the last line). Every window goes back to where it started.

> [[Ctrl+Shift+T]] also reopens the last window or tab you closed.

## Next

Make some noise: [[guide:step-first-beat]].
`,
};
