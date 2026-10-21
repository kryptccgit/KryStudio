import type { GuideArticle } from '../articles';

export const HELP: GuideArticle = {
  id: 'step-help',
  title: 'Help! Something went wrong',
  summary: 'No sound, a window is gone, Home is in the way, the AI won’t connect, or everything suddenly changed.',
  group: 'Start here (step by step)',
  icon: 'lifebuoy',
  body: `
Don't worry: almost everything can be undone or put back. Find your problem below and try the steps in order.

## No sound

{{image:engine-status.webp|Top-right: the Engine light should be green.}}

1. Look at the top-right of the Studio: **Engine** should have a **green** dot. Click it for details if it doesn't.
2. Check your speakers or headphones are on, and the Windows volume is up.
3. Open **Settings**: click **Tools** (top-left), then **Settings…**. [[show:settings.audio|Show me]]
4. Under **Audio**, next to **Output device**, pick the speakers or headphones you are using.

{{image:settings-audio.webp|Settings ▸ Audio: pick your speakers or headphones next to Output device.}}

5. Still nothing? In the same place, click **Restart engine**.
6. Playing but silent? You may be in **SONG** mode with an empty Playlist. Click **PAT** at the top and press [[Space]]. [[show:transport.mode|Show me]]
7. Also check the **Master** knob at the top isn't turned all the way down.

## A window is gone

1. Press its key: [[F6]] Channel Rack, [[F7]] Piano Roll, [[F5]] Playlist, [[F9]] Mixer, [[Alt+F8]] Browser.
2. Or press [[Ctrl+Z]] right after closing it: it comes back.
3. Or click **View**, then **Reset layout**: every window goes back to its start position.

The full list of windows is in [[guide:step-windows]].

## The Home screen is covering everything

That's Home, the start screen. To get back to your music:

1. Press [[Esc]].
2. Or click the **Studio** card.
3. Or click the little **house** button at the top-left (it turns Home on and off). [[show:titlebar.home|Show me]]

## AI not connecting

1. Krypt Studio must be open (it starts by itself when the AI asks for it).
2. After **Set up**, restart the AI app: a **new** Claude Code session, or fully quit and reopen Claude Desktop, Cursor or VS Code.
3. On **Home ▸ AI Agents**, does it say "Agents are switched off"? Click **Allow agents**.
4. In the **Agents** window, a green **Re-enable** button means the kill switch is on: click it.
5. Using the built-in chat? Check your key is saved (the key box is gone once it is) and your Anthropic account has credit.

Step by step setup: [[guide:step-ai]].

## I clicked something and everything changed

1. Press [[Ctrl+Z]] to undo. Press it again to undo more. [[Ctrl+Y]] redoes.
2. To see every change, click **Edit**, then **History…**.

{{image:menu-edit.webp|The Edit menu: Undo (1) and History (2).}}

3. Did the AI do it? In **History**, click **Revert all AI edits** next to its name. Your own changes stay.

## I closed Krypt Studio, but it's still running

That's on purpose: closing the window keeps Krypt Studio in the **tray** (the small icons by the clock, bottom-right of Windows), so AI agents can reach it and it opens instantly. Your work is kept.

- To open it again, click the Krypt icon in the tray, or open Krypt Studio from the Start menu.
- To close it completely, right-click the tray icon and click **Quit**, or use **File ▸ Exit**.
- It also starts quietly with Windows. To stop that, open **Tools ▸ Settings…** and turn off **Start with Windows**.

## Letters on my keyboard play notes

That's the **typing keyboard**: it turns your computer keys into piano keys. Press [[Ctrl+T]] to turn it off (or on again).

## Where did my song go?

1. Press [[Ctrl+Shift+H]] for Home, then click **Projects**: your recent songs are there.
2. Krypt Studio crashed? Open it again: your unsaved changes come back.

## Still stuck?

{{image:menu-help.webp|The Help menu: these Guides (1) and Troubleshooting (2).}}

- [[F1]] opens these guides any time. **Help ▸ Troubleshooting** has more fixes: [[guide:troubleshooting]].
- Ask on the Krypt Discord: **Help ▸ Discord**.
`,
};
