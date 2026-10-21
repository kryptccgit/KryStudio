# Beginner hand-holding (written 2026-10-14)

**User ask:** "a full ease-of-use guide: clicking new project, the hotkeys to open stuff … I couldn't figure it out from the start video. Users are total beginners: hand-hold, exactly what to click, setting up MCP or AI through an API key."

The quickstart video stays. Add:

## 1. Interactive tours (coach marks): the real hand-holding

**The engine** (`src/tours/**`):
- A step is `{ anchor (data-guide / selector), title, text (≤ 2 short sentences), do: 'click' | 'key' | 'type' | 'read', done: predicate, onEnter?: prep }`.
- The screen dims, with a cut-out around the target and a big pulsing ring + arrow.
- The instruction card is in large type, e.g. "Click **this button**" / "Press **F6** on your keyboard".
- The step advances ONLY when `done()` is true: the panel opened, the step was set, playback started, a key was pressed, …
- Also: Back / Skip / "Do it for me" (performs the action), and progress dots.
- If the anchor isn't visible, the card explains how to get it back, e.g. "The Channel Rack is closed: press F6", with a button that does it.

**Tours:**
1. **"Start here: your first beat"** (offered on first launch and from Home). Steps:
   1. new project;
   2. what the Channel Rack is;
   3. click 4 kick steps;
   4. Play (Space);
   5. Stop;
   6. add claps / hats;
   7. the tempo;
   8. save (Ctrl+S);
   9. what's next.
2. **"Find your way: windows and shortcuts":** each window (Channel Rack F6, Piano Roll F7, Playlist F5, Mixer F9, Browser Alt+F8, Session F3, Guides F1, Home Ctrl+Shift+H):
   - open it with the key, say what it's for, close it;
   - "lost a window? Ctrl+Z reopens it; View ▸ Reset layout puts everything back".
3. **"Make a song from your beat":** Song mode, paint into the Playlist, play the song, Export (Ctrl+R).
4. **"Set up AI":** a chooser, then the path for that choice:
   - (a) Claude Code: Agents (AI button) → Connect → Claude Code → Connect, then type the example request in Claude Code;
   - (b) Claude Desktop / Cursor / VS Code: the same, plus "restart that app";
   - (c) built-in chat with your own Anthropic API key: where to get it (console.anthropic.com, an external link button), paste in Agents ▸ Chat (or Settings), Save, type a request.

   Honest notes: an API key costs money per use; Claude Code / Desktop use your Claude plan.

**Entry points:**
- Home: "New here? Take the tour" next to the quickstart card;
- Help ▸ Tours;
- the Guides "Start here" article;
- a small "?" on the Agents panel opens tour 4.

The first launch offers tour 1 once (dismissible, and remembered).

## 2. "Absolute beginner" guides: click-by-click, with annotated screenshots

A new Guides section at the very top, "Start here (step by step)":
1. **Opening Krypt Studio and starting a beat:** Home, Studio / New project / Ctrl+N, tabs.
2. **The windows and how to get them back:** a table of every window: key, View menu entry, what it's for. Closing, Ctrl+Z, Reset layout.
3. **Your first beat, click by click.**
4. **Play, stop, tempo, metronome.**
5. **Save, open, export.**
6. **Set up AI (pick one):** Claude Code / Claude Desktop / Cursor / VS Code / the built-in chat with an API key. Exact steps, exact button names, and what to type first. The "Revert all AI edits" safety net.
7. **Help! Troubleshooting:**
   - no sound (Settings ▸ Audio device);
   - a window is gone;
   - the Home screen is covering everything;
   - AI not connecting;
   - "I clicked something and everything changed": Ctrl+Z / History.

**Every step** is a numbered line that **bolds the exact thing to click**, plus an annotated screenshot: the real app at 1920×1080, cropped, with the target circled and a step-number badge. Images go in `resources/guides/images/` as WebP or PNG, shown with a new `{{image:<file>|<caption>}}` block in GuideBody. Every step also has a "Show me" anchor and a "Start the tour" button where a tour exists.

**Tone:**
- second person, one action per sentence;
- no jargon without a one-line explanation;
- key names in Kbd style.

## Agents

| Agent | Owns |
|---|---|
| tours | `src/tours/**` (engine + the 4 tours + tests), entry points (Home card, Help ▸ Tours, first-launch offer, Agents "?"), and any missing `data-guide` anchors the tours need (small additive edits in panels). |
| beginner-guides | The new guide articles (`src/guides/beginner/*.ts`, registered first in the guide index), the `{{image:…}}` block in GuideBody (+ tests), the screenshots (captured with the video director in `scratchpad/videos`: real app instance, `d.spot` / an arrow overlay, crop with ffmpeg), and `resources/guides/images/**` (keep the total under ~8 MB). |

## Rules

As before:
- Krypt UI kit;
- no silent failures;
- no new dependencies;
- never "Auto-Tune";
- don't break existing guides / anchors;
- `npm run typecheck && npm test` green.

The video director lives in a local workspace outside this repository. This pass makes screenshots only (no narration); screenshots of brand-new UI (tours) aren't needed.
