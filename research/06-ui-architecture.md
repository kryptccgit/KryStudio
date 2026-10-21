# 06 — UI Architecture for KryptStudio (Electron + React DAW)

> Research brief, 2026-10-11. Scope: renderer/UI architecture only. The audio
> engine, plugin hosting, and MCP protocol are covered by sibling reports. Where
> this report depends on them, it states the contract it needs from them.
>
> House stack: Electron + React 18 + TS + Vite + vite-plugin-electron + Tailwind
> + Zustand + lucide-react. kryptguidelines.md §2–§4 apply unchanged: tokens,
> UI kit, the `shared/` / `electron/` / `src/` layering, one IPC file,
> `ActionResult` returns, and no C++ compile at `npm install`.

---

## 0. TL;DR — the decisions

| Area | Decision |
|---|---|
| **Editor surfaces** (piano roll, playlist, automation, step grid) | **Canvas2D, layered** (grid / content / overlay), driven by one **rAF frame loop per OS window** with dirty flags. React renders only the chrome. Painters are written against a small `Painter` interface so the content layer can later move to a **WebGL2 instanced-quad backend**, if profiling demands it, without touching interaction code. |
| **Playheads** | A DOM element moved with `transform: translate3d()` (compositor-only), fed by a **non-React transport store** that interpolates engine clock packets. Never a Zustand field that components select. |
| **Meters / scopes** | Engine sends packed `Float32Array` frames at about 60 Hz (max-since-last-read). UI applies ballistics in the frame loop and draws **one canvas per mixer view**, not one per strip. |
| **Waveforms** | Multi-resolution min/max **peak pyramid** computed off the UI thread (engine or worker), rendered as **tiles** (`ImageBitmap`, 512 device px) in an OffscreenCanvas worker. This fixes the KryptEditor approach of one canvas per clip with no DPR handling. |
| **Controls** | **Custom** `<Knob> <Fader> <Slider> <StepButton>` built on one `useParamDrag` hook. Features: Pointer Lock with raw movement, fine modifier, wheel steps, reset-to-default, typed entry, and a right-click param menu. All are bound to a `ParamRef`, not to raw values. |
| **Plugin UIs** | Third-party VST3/CLAP editors are native HWNDs owned by the engine. v1 puts them in **engine-created native windows owned by the KryptStudio main HWND**. Built-in Krypt plugins and the "generic parameter view" are React panels. |
| **Windowing** | **dockview** (MIT core, v8.5) behind our own `WindowManager` facade. It covers grid docking, floating groups (FL's floating windows) and popout OS windows (FL's "detach") in one library, with FL-style custom headers. flexlayout-react (now with floating panels) is the drop-in fallback. Popouts are same-process `window.open` windows on a same-origin `popout.html`, which means serving the renderer from a custom secure `app://` scheme instead of `file://`. Because the doc store is a replica, heavy windows can later move into their own renderer process. |
| **Source of truth** | **One authoritative DocHost in the Electron main process.** It holds the normalized project, executes semantic commands, emits patches and owns history. Renderers are read replicas, and so is the engine (as a projection). MCP agents call the same commands. **No CRDT in v1**; the op format is designed so one could be adopted later. |
| **Undo** | **Commands → Immer/Mutative patches + inverse patches → transactions.** History entries are tagged with the actor (user/agent/engine) and support **groups**: a gesture, or an agent's multi-step `begin_edit…commit_edit`, becomes one undo step. **Per-actor undo** with conflict-checked selective inverse, plus a History panel. |
| **File format** | `.kstudio` = **zip container** (`project.json`, `ui.json`, `plugins/*.bin`, optional `samples/`), written atomically (tmp + rename). Crash recovery uses an **op journal** (NDJSON, flushed about 1 s) on top of periodic snapshots. Integer `schemaVersion` with pure migrations and zod validation. Samples are stored as relative path + absolute path + content hash, with a relink dialog. |
| **MIDI** | **The engine owns MIDI devices.** Do not use Web MIDI for playing or recording; the UI receives a copy for visuals and MIDI-learn. |
| **Shortcuts** | Central **command registry + keymap** (FL defaults, user-overridable, context-scoped by focused panel), attached to every window's document. Typing-keyboard-to-piano uses `KeyboardEvent.code` (physical keys). |

---

## 1. Rendering strategy at 60–144 fps

### 1.1 The load we must sustain

FL-scale worst cases to design and test against:

- 50k notes in one pattern, with about 2–5k visible at once.
- 2k playlist clips, each needing a preview (notes, waveform or automation curve).
- 126 mixer tracks (FL has Master + 125 inserts) metering stereo peak and RMS at 60 Hz.
- Dozens of automation clips with 1k+ points each.
- 4K monitors at 144 Hz: a 6.9 ms frame budget, of which **≤ 4 ms** may go to our JS.

Chromium canvas limits matter too. Per Blink source, the maximum is **32,767 px per side** and about **268M px of area**. A per-clip canvas sized to clip width, as KryptEditor's `Waveform` does, breaks at high zoom on long clips. Tiles are mandatory.

### 1.2 DOM vs Canvas2D vs WebGL vs WebGPU

| Option | Strengths | Weaknesses | Verdict |
|---|---|---|---|
| **DOM / SVG** | Free hit-testing, accessibility, CSS, text, React-native. Fine for hundreds of elements. | Layout/style cost grows with element count. 5k+ positioned divs scroll and zoom badly. Zooming re-lays-out everything. | Use for **chrome and controls** (toolbars, track headers, mixer strips, channel-rack rows, knobs, menus, browser), virtualized. Not for note or clip fields. |
| **Canvas2D** | Immediate mode, GPU-rasterized in Chromium, trivial HiDPI, good text (`fillText`), zero dependencies. Thousands of `fillRect`s per frame are cheap. The easiest code to own. | Everything must be redrawn on scroll/zoom (cost grows with visible items). We hit-test ourselves. | **Default for all editor surfaces.** |
| **WebGL2** (raw, twgl) | Instanced quads make scroll and zoom a *uniform change*: zero CPU re-upload, and 100k+ rects stay trivially smooth. **Signal** (MIT web MIDI editor) draws its piano roll exactly this way, with per-instance `bounds`/`state` attributes and a WebGL1 fallback. | More code (shaders, buffers). Text still needs Canvas2D or an atlas. Context loss must be handled. | **Upgrade path** for the piano-roll and playlist *content* layers only, if profiling shows Canvas2D can't hold 144 Hz on stress fixtures. Use raw WebGL2 + twgl.js (tiny, maintained). Skip regl, which is dormant and WebGL1-era. |
| **PixiJS v8** (8.22) | Batching renderer, scene graph, BitmapText, hit-testing. | A second retained scene graph to keep in sync with our doc, plus its own ticker. **`@pixi/react` 8 requires React 19** (house stack is React 18). Pixi's own docs still label the WebGPU renderer experimental. | Not needed. Our content is rects, lines and text, and a retained scene graph duplicates the doc replica. Keep as plan C, used imperatively. |
| **WebGPU** | Modern, compute shaders (spectrograms, waveform reductions). On by default in Chromium on Windows since M113, so Electron 44 (Chromium 152) has it. | Needs a secure context. Driver blocklists and device-loss handling. Overkill for 2D rects. | **Not in v1.** Feature-detect `navigator.gpu` and revisit for GPU spectrograms or analyzers. |

**Validation from the field (§11):** openDAW, the most rigorous open web DAW, draws its piano roll, timelines and waveforms with **Canvas2D painters** behind one shared animation-frame scheduler, and uses WebGL only for visualisers. Signal uses WebGL2 instancing for notes. Both are inside the range recommended here: Canvas2D first, with an instanced WebGL content layer as the scale-up path.

(Library versions and maintenance status are in §10.)

### 1.3 The frame loop (avoiding React re-render storms)

**Rule:** anything that changes faster than a human edits does not go through React state. That covers playhead, meters, automated parameter values, hover, drag previews, scope data and MIDI activity.

```
src/render/frameLoop.ts   (one instance per OS window)
  register(painter: Painter): () => void
  Painter = { id, dirty: boolean, animating(): boolean, paint(now, dt): void }

per rAF tick (of THAT window — popouts must use canvas.ownerDocument.defaultView.requestAnimationFrame):
  1. live.transport.update(now)   → interpolated playhead position
  2. live.meters.update(now, dt)  → ballistics
  3. for painter of painters: if (painter.dirty || painter.animating()) painter.paint(now, dt)
  4. playhead DOM nodes: el.style.transform = `translate3d(${x}px,0,0)`
```

Where state lives, and how it reaches the screen:

| State | Store | How the UI reads it |
|---|---|---|
| Project document (replica) | Zustand `useDoc` (immutable, structurally shared, normalized) | React chrome: selectors on *small* slices. Painters: `useDoc.subscribe(selector, () => painter.dirty = true)` (transient, no render). |
| View state (zoom, scroll, tool, snap, selection) | Per-panel Zustand store (not undoable, not in the doc) | Same split. Scroll and zoom during a drag-zoom are mutated imperatively and committed on gesture end. |
| Live engine data | `src/live/*`: plain mutable typed arrays plus listener sets | Painters only. Read inside the frame loop. |
| Gesture previews (drag ghosts, marquee, lasso) | Local to the interaction controller (a plain object) | The overlay painter only. Not React state, not doc. |

Zustand's documented "transient updates" pattern (subscribe into a ref, no re-render) plus `subscribeWithSelector` is all we need. Signals (`@preact/signals-react` 3.x needs a Babel transform or `useSignals()` in every component) would add a second reactivity model with no benefit here.

Two field lessons:

- **Per-painter rate caps.** openDAW throttled its global animation-frame loop to about 60 fps in April 2026. On 120 Hz displays it was doubling the work of its 31+ subscribers (meters, canvas painters, live-stream readers). Our loop should run at display rate only for the **playhead transform and active drags**, and cap meters, scopes and step-highlight painters at 60 Hz (`painter.maxHz`).
- **Leaf subscriptions.** Signal's architecture rule is that high-churn data is read by leaf hooks, never passed down as props, because "each prop layer widens re-render scope". Our DOM rows (channel rack, mixer strips) follow it: `useChannel(id)` inside the row, and only ids passed down.

KryptEditor has a lesson here. Its playback loop writes `playhead` into the document store at 60 Hz (`src/editor/Preview.tsx` L215–245). That re-renders every subscriber, and `App.tsx` L146–150 had to work around it so autosave wasn't rescheduled 60×/s. KryptStudio fixes it structurally: **the playhead is not in any store that React components select.**

### 1.4 Layered surfaces, culling, hit-testing

Each editor (piano roll, playlist, automation editor, event lane) is a `<Surface>` of stacked, viewport-sized canvases:

| Layer | Contains | Repaints when |
|---|---|---|
| L0 grid | Bars/beats/steps, key rows (black/white), scale highlight, loop region | Scroll, zoom, resize, time signature or grid change |
| L1 content | Notes / clips / automation curves, ghost notes, clip previews | Doc change in the visible range, selection change, scroll, zoom |
| L2 overlay | Hover, marquee, drag ghosts, snap guides, slice line, note-preview flash | Pointer move during interaction |
| DOM | Playhead line + handle, editable text, popovers | Transform per frame / React |

- **We own scrolling.** The canvases are viewport-sized and the scroll offset is view state. FL-style custom scrollbars with zoom handles are a DOM component. KryptEditor's approach of a native-scroll content div, with absolutely positioned children as wide as the song, doesn't scale for canvas.
- **Culling:** each pattern replica keeps a derived index of notes sorted by `start`, plus a running `maxLength`. The visible set comes from a binary search on `[viewStart − maxLength, viewEnd]` then a key-range filter, which is O(log n + k). Playlist clips get a per-track sorted index.
- **Hit-testing** uses the same index: `row = floor(y / rowH)` and a time window around the pointer. Note edges have a ±4 css-px resize zone, as in FL.
- **Clip previews:** a pattern used 300 times in the playlist is rendered **once** into an offscreen canvas or `ImageBitmap` per `(patternId, docVersionOfPattern, zoomBucket)`. Each clip instance is then a `drawImage`. Use an LRU capped by bytes.
- **Partial redraw:** during playback with no edits, *nothing* repaints except the playhead transform and meters. That is the single biggest win at 144 Hz.

### 1.5 HiDPI, mixed-DPI multi-monitor, text

- Backing store = CSS size × `devicePixelRatio`. Use `ResizeObserver` with `devicePixelContentBoxSize` (Chromium) for exact device pixels, and re-run on a `matchMedia('(resolution: Ndppx)')` change. A popout dragged from a 100% monitor to a 150% monitor changes DPR **per window**.
- Draw 1-px lines on device-pixel centres (`Math.round(x*dpr)+0.5`). Keep a `px()` helper in `render/viewport.ts`.
- Text: Canvas2D `fillText` with JetBrains Mono for note and clip labels (crisper at 9–11 px than Chakra Petch). Chakra Petch is used for headers.
  - `await document.fonts.load(...)` before the first paint, in **each** popout document too.
  - Cache `measureText` widths in a `Map`, and skip labels when they don't fit.
  - Fill styles come from the Krypt tokens via `render/colors.ts`, so canvas and Tailwind never drift.

### 1.6 OffscreenCanvas and workers

- **Use workers for:**
  - Waveform tile rasterization (peaks → `ImageBitmap`, transferred back).
  - Spectrogram and analyzer rasterization.
  - Peak-pyramid building, if the engine doesn't provide it.
  - Large derived indexes on import (e.g. MIDI-file import of 100k events).
- **Do not (yet) move interactive surfaces into a worker.**
  - Pointer events arrive on the main thread, so every interaction would need a postMessage hop.
  - The doc replica would need mirroring.
  - Debugging gets harder.

  Keep painters as **pure functions of `(viewport, data, theme)`**, so moving one to `transferControlToOffscreen()` later is a mechanical change.
- Vite: `worker: { format: 'es' }`, as KryptEditor already does in `vite.config.ts`.

### 1.7 Per-surface recommendation

| Surface | Rendering | Notes |
|---|---|---|
| **Piano roll** | Canvas2D L0/L1/L2 + DOM playhead. Keyboard column = Canvas2D. Event/velocity lane = a separate Canvas2D surface under a react-resizable-panels splitter. | Ghost notes from other channels at about 30% alpha. Labels only when wide enough. WebGL2 instanced content layer is the stage-2 option. |
| **Playlist** | Canvas2D L0/L1/L2. Track headers = virtualized DOM (`@tanstack/react-virtual`). | Clip previews cached as bitmaps (pattern thumbnails, waveform tiles, automation curve paths). Audio clips use waveform tiles. |
| **Channel rack** | Rows = DOM (name button, mute LED, pan/vol knobs, mixer-track spinner), virtualized. Step grid = **one Canvas2D per visible row group**. Graph editor (velocity etc.) = Canvas2D. | Paint-drag of steps and the playing-step highlight in the overlay layer. Steps are a projection of notes (FL stores steps as notes), not separate data. |
| **Mixer** | Strips = DOM, virtualized horizontally. **All meters = one Canvas2D overlay** aligned with the virtualizer's item offsets. Inserts/sends panel = DOM. | 126 strips × per-strip canvases would mean 126 compositor layers updating every frame. One canvas is a single draw pass. |
| **Meters** | Canvas2D (see §5.3 for data and ballistics). | Clip LEDs latch until clicked. Peak-hold ticks. |
| **Waveforms** | Worker-rasterized tiles from a min/max peak pyramid, then `drawImage`. | Level choice: the first pyramid level with `samplesPerPeak ≤ samplesPerDevicePixel`. Draw min/max columns per device pixel. **No per-file normalization** (KryptEditor's `peaks.ts` L45 normalizes to max, which is wrong for a DAW). |
| **Scopes / spectrum / EQ curves** | Canvas2D paths (WebGL2 if a spectrogram needs it). | The engine sends reduced frames (e.g. 256 log-spaced bins at 30–60 Hz). Only subscribed, visible analyzers get data. |
| **Automation clips** | Canvas2D paths sampled per device pixel from a **shared pure evaluator** `evalAutomation(points, tick)`. | The same curve math must exist in Rust, enforced by golden-value tests shared by both test suites. KryptEditor's "preview and export share pure math" rule (`src/editor/README.md`) applies here between UI and engine. |
| **Third-party plugin UIs** | Native HWND (engine). | See §2.4. |
| **Built-in plugins / generic param view** | React DOM + SVG knobs + Canvas2D displays. | Same `controls/` kit. |

### 1.8 What existing web DAWs do

See §11 for findings with sources.

---

## 2. Windowing model

### 2.1 What FL does (target behaviour)

This is what the Image-Line manual says (sources in §12):

- **Floating windows inside the workspace.** FL's main windows (Playlist F5, Channel rack F6, Piano roll F7, Mixer F9, Browser Alt+F8, Plugin picker F8) and every plugin window are "movable (with overlap), resizable, zoomable, dockable and switchable".
- **Detach.** Any window can be set to **Detached** from its window menu (top-left icon), making it an OS window for multi-monitor use. On Windows there's also "Maximize to all monitors".
- **Snapping.** Windows **snap together** when dragged close, and holding **Alt** overrides snapping.
- **Arrangement.** *View → Arrange windows* offers layout presets ("Into workspace", "Desktop (default)", "Alternate", "Custom", "Save custom layout") and *Realign* (Shift+Ctrl+H).
- **Window keys.**
  - F-keys **toggle** windows.
  - Enter maximizes or restores the Playlist.
  - Tab cycles windows; Esc closes the focused one.
  - F12 closes all windows, Alt+F12 closes all plugin windows, and Ctrl+F12 closes unfocused windows.

KryptStudio maps this as follows:

| FL | KryptStudio |
|---|---|
| Floating windows | dockview **floating groups** |
| Detached | dockview **popout groups** |
| Arrange presets | named dockview **layouts** (JSON) |
| Docking | dockview grid docking. This goes beyond FL; for example, the Browser can be docked left by default. |

Snapping-with-Alt-override is ours to build, because dockview's smart-guide snapping is in the paid enterprise package.

### 2.2 Library evaluation

| Library (Oct 2026) | Tiling/tabs | Floating in-workspace | Popout OS windows | React | Fit |
|---|---|---|---|---|---|
| **dockview** 8.5.1, MIT core, released the day before | Yes (grid + tab groups) | **Yes** (floating groups, MIT) | **Yes** (`addPopoutGroup`, MIT) | First-class (`dockview-react`, React 16.8–19) | **Best.** Covers all three FL modes, JSON (de)serialization, custom tab and header components, zero dependencies, mature floating groups. Caveat: since v8 a commercial `dockview-enterprise` holds smart-guide snapping, layout undo, auto-hide edges, pinned and multi-row tabs. We need none of them; we build FL-style snapping ourselves. |
| flexlayout-react 0.11.1, MIT, very active | Yes (tabsets, collapsible "borders") | **Yes, since 0.9 (Apr 2026)**; dock-back and pop-out since 0.10.5 | Yes (same-origin `popout.html`, portals from the main JS context) | React 18/19, ESM-only | **Close runner-up.** Floating is only months old. Borders are a good fit for an FL Browser. Ships `useUndo` and a context-menu builder. |
| golden-layout 2.6.0 | Yes | No | Yes, but separate instances per window with manual state sync | No official binding | Stalled since 2022. Reject. |
| rc-dock 4.1.0, Apache-2.0 | Yes | Yes (float boxes) | Demo shows "new browser window"; mechanism unverified | React ≥ 18 | Viable fallback. |
| react-mosaic 7.2.1 | Tiling + tabs (v7) | No | No | Yes | Not suitable. |
| react-resizable-panels 4.14.4 | Splits only | No | No | React 18/19 | Use *inside* panels (piano roll ↔ event lane, mixer strips ↔ insert panel). Note the v4 API rename relative to KryptEditor's v2. |
| Custom MDI manager | Anything | Yes | We build it | — | About 1–2k LOC to get snapping, z-order, maximize, docking, popout and persistence right. Only if dockview proves too constraining. |

**Decision:** use dockview, wrapped by `src/workspace/WindowManager.ts` so panels never import dockview directly. Swapping to flexlayout-react or a custom manager then touches one folder.

```ts
wm.toggle('pianoRoll', { patternId })   // F7 semantics: show/focus or hide
wm.open('plugin', { instanceId }, { mode: 'floating', at: 'cursor' })
wm.detach(panelId)                      // → popout OS window
wm.dock(panelId, 'left' | 'right' | 'bottom' | 'center')
wm.saveLayout() / wm.loadLayout(json)   // per project (ui.json) + named app layouts
```

FL-style chrome comes from dockview's custom header and tab renderers. Each header carries: title, pattern/channel selector, ◂ ▸ arrows, a detach toggle, maximize and close. Styled with Krypt tokens (`bg-krypt-panel`, hairline borders, gradient rail on the focused window).

### 2.3 Popouts and multi-monitor in Electron

- **The popout needs a same-origin URL.** dockview opens popouts at a `popoutUrl` (default `/popout.html`, a blank page we ship) that must be **same-origin http(s)**; `javascript:`, `data:` and `blob:` are rejected. KryptEditor loads its UI from `file://`, and Chromium gives `file://` pages opaque origins. So **KryptStudio serves the renderer from a custom `app://` scheme** registered `standard: true, secure: true, supportFetchAPI: true` via `protocol.handle`. That is the same mechanism as KryptEditor's `krypteditor://` media protocol (`electron/system/mediaProtocol.ts`). It also gives a secure context (WebGPU) and lets us send COOP/COEP headers if we ever need SharedArrayBuffer. Electron 41.0 regressed cross-origin isolation (fixed and backported), so keep a CI check on `crossOriginIsolated` if we rely on it.
- KryptEditor's `electron/main.ts` L140–146 **denies all `window.open`**. KryptStudio must allow exactly one shape: our own `app://…/popout.html`. Return `{ action: 'allow', overrideBrowserWindowOptions: { frame: false, backgroundColor: '#0A0A0F', autoHideMenuBar: true, parent: mainWindow, webPreferences: { … } } }`, and keep denying everything else. The `will-navigate` lock (L148–151) stays. Handle dockview's `onDidOpenPopoutWindowFail` with a toast and fall back to a floating group. Watch dockview issue #851 (duplicate popouts after a layout reload) when restoring layouts.
- **Same-process popouts** (`window.open`) share the renderer JS heap, so React portals, Zustand replicas and the frame-loop registry just work. Gotchas we must code for:
  1. `requestAnimationFrame` must come from the popout's own `window`. Chromium throttles rAF for hidden or minimized documents, so the opener's rAF stops when the main window is minimized.
  2. KryptEditor-style `window.addEventListener('pointermove')` drag code breaks in popouts. Use `element.setPointerCapture(e.pointerId)` and `el.ownerDocument`.
  3. Keyboard shortcuts must be bound on every window's document.
  4. Fonts and stylesheets must be present in the popout. dockview copies stylesheets; verify Tailwind's injected `<style>` in dev and `fonts.css`.
  5. Context menus and tooltips must portal into the popout's `document.body` (Radix `Portal container`).
  6. DPR differs per monitor (§1.5).
- **All same-process windows share one JS thread.** That is FL's model too, since FL has a single UI thread, and it is fine with the paint discipline above. Because every renderer is a doc *replica* fed by DocHost broadcasts (§4), a later "heavy window in its own process" mode costs little. A separate `BrowserWindow` loads the same bundle with a `?panel=mixer` route and subscribes to the same broadcast. This follows kryptguidelines §6: broadcast to `BrowserWindow.getAllWindows()`, and queue payloads in main and drain them on mount.
- **Frameless chrome:** use `-webkit-app-region: drag` on the header and `no-drag` on its buttons (kryptguidelines §6: never JS-drag a window).
- **Bounds persistence:** store per panel kind, and validate against `screen.getAllDisplays()` on restore. A monitor may be gone, so clamp onto the primary display. **Negative coordinates are valid** (monitors left of or above the primary), so use the kryptguidelines `x === -1 && y === -1` "unplaced" sentinel.
- **Owned windows** (`parent: mainWindow`) stay above the main window and minimize with it, which matches FL detached windows and plugin windows. Optionally offer an "independent window" toggle (no parent) for users who want a mixer on monitor 2 behind other apps.

### 2.4 Third-party plugin editor windows (native HWNDs)

Chromium can't host a foreign HWND inside the DOM, so the plugin editor is a native window created by the engine process.

- **v1 (robust):** the engine creates a top-level window **owned by** the KryptStudio main HWND. The owner handle comes from `BrowserWindow.getNativeWindowHandle()` and is passed to the engine at startup. The engine draws a slim native title bar, or hands off chrome to a companion React strip. FL's wrapper toolbar (presets, ◂ ▸, bypass, detach) can be a tiny frameless `BrowserWindow` glued above the native window, moving together via engine bounds events. Start with a native caption plus a context menu.
- **v2 (FL-identical):** a frameless `BrowserWindow` per plugin renders the FL-style wrapper in React. The engine re-parents the plugin's child HWND (`SetParent`) into that BrowserWindow's native handle below the header. Cross-process child windows work on Win32 but **attach the input queues of the two processes**: a hung plugin can stall our renderer window, and focus and keyboard routing get subtle. Defer until the engine report confirms plugin sandboxing strategy.
- **Keyboard while a plugin has focus:** plugins swallow keystrokes. The engine should forward unhandled `WM_KEYDOWN` for global commands (Space, F5–F9, Ctrl+S) back to the app via the engine protocol, so the transport still works with a plugin focused.
- **DPI:** plugins vary in per-monitor-DPI awareness. The engine must create plugin windows with the right DPI-awareness context, using CLAP `gui.set_scale` and VST3 `IPlugViewContentScaleSupport`. Flagged as a risk.

---

## 3. Controls with FL-grade feel

### 3.1 Behaviour spec (`src/controls/useParamDrag.ts`)

| Interaction | Behaviour |
|---|---|
| Drag | **Vertical** (up = increase). The full range spans about 250 css px by default (user setting). Uses `requestPointerLock({ unadjustedMovement: true })` on `pointerdown` (it is a user activation), so the cursor never hits a screen edge and OS acceleration doesn't distort the feel. Fall back to `setPointerCapture` + `movementY` if the lock is denied. The cursor reappears where it was locked. |
| Fine adjust | **Ctrl held while dragging** gives ×0.1 sensitivity (FL default). FL's alternative, **holding both mouse buttons and dragging**, is also supported. **Shift bypasses snapping/detents** (FL). Remappable in settings. |
| Wheel | One notch = 1/100 of range; Ctrl = 1/1000. **Stepped/enum params** move one step per notch. FL's per-knob wheel behaviour isn't documented in its manual, so this is our default. Non-passive native listener (KryptEditor `Timeline.tsx` L97–120 explains why: React wheel listeners are passive). |
| Reset | **Alt + left-click** (FL default) and **middle-click** (FL quick reset) set the param to its **default**. Double-click does too (a common convention outside FL). Also via the context menu. |
| Typed entry | Context menu "Type in value…", or click on the value tooltip, opens an inline input. Reuse KryptEditor `ValueField`: string buffer, Enter commits, Esc cancels, clamp on commit, and unit-aware parsing such as `-6 dB`, `440 Hz`, `25%`, `L30`. |
| Value tooltip | While hovering or dragging, a portal tooltip near the control *and* the global **hint bar** (FL's top-left hint panel) show the formatted value. For plugin params the text comes from the plugin's own value-to-text (CLAP `value_to_text`, VST3 `getParamStringByValue`). |
| Right-click menu | Mirrors FL's knob menu (items confirmed in the Image-Line manual): **Edit events** (event editor for this param), **Create automation clip**, **Link to controller…** (MIDI learn), **Init song with this position**, **Type in value…**, **Set…** (larger control), plus **Reset** and **Copy / Paste value**. Every item is a *command*, so agents can call the same functions over MCP. |
| Bipolar | Pan and detune fill from centre. Snap-to-centre detent (±2% magnet). |
| Automated state | If an automation clip targets the param, show a small indicator, and during playback the control **follows the engine's live value**. Only for on-screen params: controls register their `ParamRef` with `live/params`, and the engine sends values only for subscribed refs. |
| Step buttons | Press sets the paint mode (on or off, from the first cell), then drag paints. Right-button drag erases. Shift-click opens per-step properties. Implemented on the row's step canvas, not DOM buttons. |
| Keyboard a11y | Focusable, `role="slider"`, `aria-valuenow/min/max/valuetext`. Arrows step, PageUp/PageDown take big steps, Home/End go to min/max. |

### 3.2 Data model for controls

All controls are **normalized 0..1** against a `ParamDescriptor`:

```ts
{ ref: ParamRef, min, max, default, curve: 'lin'|'log'|'exp'|'db'|'stepped', steps?, unit, format(v), parse(s) }
```

Descriptors for third-party plugins come from the engine (VST3 `ParameterInfo`, CLAP `param_info`). The control never mutates the doc directly. It runs a **gesture**:

```
pointerdown → dispatch('param.beginGesture', ref)                 // DocHost opens an undo group
drag (≤60 Hz, rAF-coalesced) → dispatch('param.set', {ref, v}, {group, coalesce:true})
pointerup   → dispatch('param.endGesture', ref)                   // closes group: ONE undo entry
```

During the drag, the control renders its *local* gesture value immediately (zero-latency feel). The doc replica catches up via broadcast. Sound follows within about 1–2 ms through DocHost → EngineAdapter → engine, and the engine applies parameter smoothing. If profiling shows that path jitters, add a **param fast lane** (renderer → engine MessagePort) for the live value, and keep DocHost for the committed value.

### 3.3 Library or custom?

The knob-library landscape in Oct 2026 is thin:

- `react-knob-headless` 0.4.0 is dormant since 2025-06, with a React ≤18 peer.
- `webaudio-controls` is not on npm (vendor-only web components).
- `react-rotary-knob`, `react-dial-knob` and `precision-inputs` are unmaintained.
- Only `@radix-ui/react-slider` is active, and it does linear sliders only.

None of them do Pointer Lock with raw movement, `ParamRef`-driven menus, automation-follow, gesture-grouped undo, or plugin value-to-text. **Build custom** (about 400–600 LOC for the hook plus Knob, Fader, Slider and StepButton). Optionally borrow ARIA patterns from react-knob-headless. Render knobs as small SVGs. The value goes through a CSS custom property (`style.setProperty('--v', n)`) during drags and automation-follow, so no React re-render happens per frame.

Context menus: **Radix Context Menu** (keyboard nav, submenus, collision handling) with Krypt styling, or a small custom menu. Either must accept a portal container so it works in popouts.

---

## 4. Document model, edits, undo, persistence

### 4.1 Normalized schema (`shared/schema/project.ts`)

Time base: **integer ticks at PPQ 960** (FL's internal PPQ is configurable; 960 divides cleanly into triplets and 1/64ths). Audio offsets are in **samples** at the source rate. Tempo-map conversion is the engine's job; the UI keeps a mirrored, read-only tempo map for drawing.

```ts
Project {
  schemaVersion: number; id: string
  meta: { name, author, genre?, bpm, timeSig: [n, d], ppq: 960, createdWith, savedWith }
  channels:   Record<ChannelId, Channel>        // Channel Rack entries
  patterns:   Record<PatternId, Pattern>        // { name, color, order, notes: Record<NoteId, Note> }
  automation: Record<AutomationId, AutomationClip> // { target: ParamRef, points: Record<PointId, AutoPoint>, curveMode }
  playlist: {
    tracks: Record<PlTrackId, PlaylistTrack>    // { name, color, height, muted, locked, order }
    clips:  Record<ClipId, PlaylistClip>        // { trackId, start, length, offset, muted, color?,
                                                //   source: {kind:'pattern',patternId} | {kind:'audio',sampleId,...} | {kind:'automation',automationId} }
    markers, loop, timeSigChanges
  }
  mixer: { tracks: Record<MixerTrackId, MixerTrack> }  // FL-style fixed slots: index 0 = Master, 1..125 inserts
                                                        // { index, name, color, volume, pan, stereoSep, mute, solo,
                                                        //   inserts: (PluginInstanceId|null)[10], sends: Record<MixerTrackId, number> }
  plugins:   Record<PluginInstanceId, PluginInstance>   // { format:'vst3'|'clap'|'builtin', uid, name, bypass, stateRef: 'plugins/<id>.bin', paramCache? }
  samples:   Record<SampleId, SampleRef>                // { name, relPath, absPath, hash, bytes, sampleRate, channels, frames, bundled?: string }
  links:     Record<LinkId, ControllerLink>             // MIDI learn: { source:{device?, channel, cc|note}, target: ParamRef, min, max, curve }
}
Channel  { kind:'sampler'|'instrument'|'audioClip'|'automation'|'layer', name, color, order, mixerTrackId,
           pluginId?, sampleId?, volume, pan, pitch, mute, targetGroup?, defaultKey }
Note     { channelId, key 0..127, start, length, velocity 0..1, pan, release, fineCents, modX, modY, slide?, porta?, color? }
ParamRef = `ch:${ChannelId}:${param}` | `mx:${MixerTrackId}:${param}` | `pl:${PluginInstanceId}:${paramId}` | `tr:tempo` …
```

Rules that keep this agent-safe and future-CRDT-safe:

- **Everything is id-keyed records; there are no arrays of entities.** Immer patch paths then stay stable (`['patterns', p, 'notes', n, 'key']`). Two actors can't collide on array indices.
- **Order is a field**: fractional-index strings (`order: 'a0V'`) for channel rack rows, playlist tracks and patterns. Reordering is a single LWW field write.
- **IDs are globally unique** and minted by whoever creates the entity: ULID or `crypto.randomUUID()`, with an actor prefix for debuggability (`u_…`, `a_…`). KryptEditor's `uid()` (`Date.now()+seq`, `timelineStore.ts` L529–530) is **not safe** across processes.
- **Steps are notes.** The channel-rack step view is a projection of on-grid notes with default length, as in FL. One source of truth.
- **Selection, zoom, scroll and window layout are not in the doc.** They are per-panel view stores, persisted to `ui.json`.
- **Referential integrity is enforced by commands, not by the store.** Deleting a pattern deletes its playlist clips *in the same transaction*.

### 4.2 Where the source of truth lives

| Candidate | Pros | Cons |
|---|---|---|
| Renderer (Zustand, like KryptEditor) | Simplest for a single window | MCP ops would have to round-trip into a renderer. A reload or crash risks the doc. Multiple windows/processes need sync anyway. No authority when the window is closed. |
| Engine (Rust) | One process owns everything that matters for playback | Schema, validation, migrations and undo all in Rust, which slows iteration. UI-only fields don't belong in an RT engine. TS types must be generated. |
| **Electron main ("DocHost")** | TS end-to-end (shared schema with renderer and MCP). Survives renderer reloads. Natural hub for windows, MCP, the engine bridge and file IO. kryptguidelines already centralizes OS and IPC there. | Main-thread latency if commands get heavy. Mitigation: DocHost is **pure TS with no `electron` imports** (`electron/dochost/*`), so it can move into an Electron `utilityProcess` later. |

**Decision: DocHost in main (movable to a utilityProcess).** The renderer and the engine are both replicas. The engine receives a **projection**: the `EngineAdapter` translates doc patches into engine commands. The engine owns only runtime state (transport, meters, plugin internals). It reports user-originated changes back as *events*, which DocHost turns into transactions with `actor: 'engine'|'user-via-plugin'`. Examples:

- A plugin knob turned in its native UI (VST3 `beginEdit/performEdit/endEdit`, CLAP param gesture begin/end) becomes a grouped undo entry.
- Recording produces new notes and audio clips.
- MIDI-learn produces a new `links` entry.

### 4.3 Commands, patches, transactions

```
                                 ┌──────────────────────────── Renderer process ─────────────────────────────┐
  user gesture ─► panel/control ─┤ dispatch(cmd, args, {label, group?}) ── ipc invoke 'doc:exec' ──┐          │
                                 │ preview on overlay layer only (no doc writes during drag)        │          │
                                 │ Zustand doc REPLICA ◄── applyPatches(v, patches) ◄─ broadcast ───┼─────┐    │
                                 │ live/* (transport, meters, params) ◄── MessagePort frames ───────┼──┐  │    │
                                 └──────────────────────────────────────────────────────────────────┼──┼──┼────┘
                                                                                                    ▼  │  │
 ┌─────────────────────────────── Electron main: DocHost (pure TS) ─────────────────────────────────────┐ │
 │ CommandRouter ─► validate args (zod) ─► run command on Mutative/Immer draft ─► patches + inverse      │ │
 │ TxnLog: version++ ; Txn {id, actor, label, group, patches, inverse, ts}                              │ │
 │ History: groups (gesture / agent edit), per-actor stacks, conflict-checked selective undo            │ │
 │ Journal: append NDJSON (flush ≤1 s) ─► Snapshot/autosave (.kstudio zip, atomic) ─► Backups           │ │
 │ Broadcast(version, patches, actor) ─► all windows (getAllWindows) + MCP subscribers ────────────────┘ │
 │ EngineAdapter: patches ─► engine commands ; engine events ─► transactions                             │
 └──────────▲───────────────────────────────────────────────┬────────────────────────────────────────────┘
            │ tools: edit_batch / begin_edit / commit_edit   │ control protocol            telemetry (meters,
            │        / abort_edit / undo_my_last / reads     ▼                             transport, scopes)
 ┌──────────┴──────────┐                       ┌──────────────────────────────┐            ──► main ──► ports
 │ MCP server (agents) │                       │ Rust engine sidecar          │
 └─────────────────────┘                       │ RT graph · plugins · clock · │
                                               │ MIDI devices · meters        │
                                               └──────────────────────────────┘
```

- **Commands** live in `shared/commands/*`. They are *semantic*: `notes.add`, `notes.move`, `notes.quantize`, `pattern.clone`, `playlist.placeClip`, `mixer.route`, `param.set`, `automation.createForParam`. Each is a pure function `(draft, args, ctx) => result` that mutates a draft. The **UI and MCP call the same commands.** MCP tools are thin schemas over them, so agents can't bypass validation.
- **Patches**: run commands through **Mutative** (Immer-compatible patch format, much faster on large trees) or **Immer `produceWithPatches`**. Patches are the wire format to replicas *and* the undo data (inverse patches). Replicas apply them with `applyPatches` into the Zustand doc; structural sharing makes painters' `subscribe(selector)` cheap.
- **No optimistic doc writes in v1.** Renderer → main → renderer IPC for a small message is sub-millisecond to a few ms, so a discrete edit appears within the same or next frame. Continuous gestures render previews locally (overlay layer, or local control value) and commit at the end. That removes the whole rebase/flicker class of bugs. Figma had to solve those with "keep unacknowledged local changes", and we don't need to yet.
- **Conflict policy (user vs agent):** DocHost serializes all transactions, giving a total order. Writes are **last-writer-wins per field**. Updates to deleted entities are a no-op, reported back to that actor. Each command checks preconditions such as "note exists" and "pattern not locked by an open gesture".

Prior art agrees with this shape:

- **openDAW** (AGPL; study it, don't copy it):
  - All edits run inside `editing.modify(fn)` transactions. Each mutation is recorded as an update with `forward()`/`inverse()`, and undo applies inverses in reverse order. Op-based, not snapshots.
  - Continuous gestures "self-seal with an explicit `mark()`", so one drag is one undo step.
  - On `endTransaction` a `SyncSource` ships batched diffs (new / update-primitive / update-pointer / delete) over a MessagePort to the audio engine, which applies them to its own replica. That is our DocHost → EngineAdapter projection.
  - Its schema is declarative with numbered fields and typed pointers, and classes are code-generated. Deletion cascades through mandatory pointers, which is what our commands do for referential integrity.
- **Audiotool Nexus** (the multiplayer protocol behind Audiotool's studio):
  - It exposes exactly three primitives (create, update field, remove) inside `modify()` transactions.
  - A **backend is authoritative** and resolves conflicts.
- **Signal** (MIT) uses full-snapshot undo (`serialize()` + `cloneDeep`). That is simple, but it scales badly at 50k notes and can't do per-actor undo. It's the KryptEditor approach, and the one we're leaving.

### 4.4 Undo/redo — grouping and actors

- **Gesture groups:** a drag, knob turn or lasso-move is one group. `beginGesture` / `endGesture`, or implicit: the first doc write of a pointer gesture opens it and `pointerup` closes it. This is KryptEditor's "push history on first move, not on pointerdown" (`Timeline.tsx` L363–371) generalized. Coalesced `param.set` ops inside a group keep the **first** inverse and the **last** forward value.
- **Agent groups:** MCP exposes two shapes:
  1. `edit_batch({label, ops:[…commands]})` is atomic: one transaction, one undo entry. Prefer this.
  2. `begin_edit(label)` → `txnGroupId` → any number of command tools → `commit_edit` or `abort_edit`. `abort_edit` rolls back by applying inverses in reverse. Edits apply live and are broadcast, so the user watches progress, but all of them land in **one** history entry. Auto-commit after an idle timeout, with a toast.
- **Per-actor undo (recommended default):**
  - **Ctrl+Z undoes the user's own last entry**. An agent's undo tool undoes only that agent's entries.
  - Undoing an older entry applies its inverse patches **only where the field still holds the value that entry wrote**. Fields edited later by someone else are kept and reported, e.g. "2 changes kept because they were edited later".
  - With field-level patches this conflict check is a simple equality test.
- **History panel** (FL has one): a single timeline of all entries with actor badges (user / agent name / plugin), labels and timestamps. Clicking an agent group offers "Revert this agent edit", using the same selective inverse. Also:
  - "Checkpoint before agent edits": DocHost snapshots version N cheaply (journal position), so the user can "Revert all agent changes since …".
  - A **"Pause agent edits"** toggle: DocHost rejects agent transactions with a clear error while paused.
- While an agent group is open, its entities get a subtle purple "agent presence" highlight, and the panel shows an "Agent editing: <label>" pill.
- **Keys.** FL's classic **Ctrl+Z is a toggle** ("Undo/Redo last edit"), and **Ctrl+Alt+Z** steps back through history. With agents interleaving entries, a toggle is confusing.
  - Default keymap: Ctrl+Z = undo my last, **Ctrl+Alt+Z = undo (alias for FL muscle memory)**, Ctrl+Shift+Z / Ctrl+Y = redo.
  - An "FL classic" keymap preset restores the toggle.

### 4.5 CRDTs: worth it now?

| | Yjs | Automerge | Loro | DocHost + ops (chosen) |
|---|---|---|---|---|
| Concurrency model | CRDT (YATA) | CRDT (JSON) | CRDT (Fugue/rich types, movable tree) | Server-ordered LWW per field |
| Per-origin undo | `UndoManager` with `trackedOrigins`, `captureTimeout`, `stopCapturing()` | Limited / app-level | Built-in `UndoManager` (local ops, merge interval) | Built ourselves (above), with semantic labels |
| Validation / integrity | Outside the CRDT; invalid states can merge | Same | Same | **Inside each command, before commit** |
| Schema migrations | Hard (live shared types) | Hard | Hard | Plain JSON migrations |
| Memory for 50k notes | High (one Y.Map per note) | High | Moderate | Plain objects |
| Rust engine peer | `yrs` exists | Rust core | Rust core | Engine gets projected commands |
| What it buys us | Offline multi-device collab, P2P | Same | Same | Everything we need for user + agents on one machine |

Version notes, Oct 2026:

- **Yjs** 13.6.33 (v14 still beta). `UndoManager` with `trackedOrigins`, `captureTimeout` (default 500 ms) and `stopCapturing()`.
- **Automerge** 3.5.0. v3 cut memory more than 10×, but there is **no built-in undo manager**; the only option is the experimental `automerge-repo-undo-redo`.
- **Loro** 1.16.4 (stable 1.x). `UndoManager` covers local-peer edits only, with `mergeInterval`, `groupStart()`/`groupEnd()`, `excludeOriginPrefixes`, and a movable tree with fractional sibling order.

The most telling data point: openDAW added **Yjs-based live collab on top of its own op graph** and then needed a separate **"deterministic reconcile" layer**, because Yjs doesn't know the graph's pointer invariants. A CRDT doesn't replace domain validation; it adds a layer you must reconcile.

**Verdict:** no CRDT in v1. User and agents on one machine is a *single-authority* problem. Figma, with millions of collaborators, deliberately runs a central authority with CRDT-*inspired* LWW per property rather than a true CRDT, and rejected OT as too complex. Our op design keeps the door open for collab later:

- Globally unique client-minted IDs, no index paths, fractional order keys, LWW fields.
- DocHost can become a network server for "Krypt Collab" with the same op protocol.
- Alternatively, swap the replica layer to Loro or Yjs (both have Rust cores and per-origin undo) if offline multi-device collab becomes a goal.

### 4.6 Project file format

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Single JSON | Simple, diffable | Plugin state blobs as base64 bloat it. Can't bundle samples. Whole rewrite per save. | Inside the container only |
| SQLite | Incremental, transactional writes. Blobs. Could store the op journal. Native-module pain is mostly gone: better-sqlite3 13 is N-API with in-package prebuilds, and `node:sqlite` works in Electron 44's Node 24 (release-candidate stability). | Not diffable. Risky under Dropbox/OneDrive sync while open. One more format to migrate. | No (for the project). **Yes later for the Browser's sample-library index** (`node:sqlite` in main or a utilityProcess, so no dependency). |
| **Zip container** | Standard, inspectable, pure JS. JSON + binary plugin blobs + optional samples in one file. "Collect & save with samples" is natural. | Whole-file rewrite on save (≈100 ms for 10 MB JSON + blobs; unchanged entries can be stream-copied) | **Chosen.** Libraries: **yazl** (write) + **yauzl** (read), both Node-side and streaming from disk, so sample bundles never sit in RAM. fflate is the alternative for in-memory or worker use. Avoid jszip (whole archive in memory). |

Layout of `MySong.kstudio`:

```
manifest.json      { format: "kryptstudio-project", schemaVersion, appVersion, savedAt, projectId }
project.json       normalized doc (compact; stable key order for reproducible saves)
ui.json            window layout, per-panel zoom/scroll, last-open pattern (not undoable)
plugins/<id>.bin   opaque plugin state (VST3 component+controller streams / CLAP state), stored not deflated
samples/…          only for "Save with samples" / "Collect all" (stored, not deflated — WAV barely compresses)
```

- **Atomic save:** write `MySong.kstudio.<pid>.tmp`, fsync, rename over the target. This is KryptEditor `electron/system/files.ts` `writeFileAtomicSync` (L53–62) plus an fsync. Keep the KryptEditor **granted-path model** (`files.ts` L214–258): the renderer can only Ctrl+S to paths that came from a dialog or recents.
- **Backups:** rotating `N` previous saves (FL keeps a backup folder) in `userData/Backups/<projectId>/`. Not next to the project: kryptguidelines §5.8 warns that Controlled Folder Access blocks Documents writes silently.
- **Crash recovery (better than KryptEditor's 2.5 s debounced full-JSON autosave):**
  - DocHost **appends every committed transaction** to `userData/Recovery/<projectId>/journal.ndjson`, flushed at most every 1 s.
  - A full snapshot is written every 2–5 min or every N ops, and the journal is truncated.
  - A `session.lock` (pid, project path) is removed on clean exit.
  - On start, a stale lock means: load snapshot + replay journal, then a modal "Recover unsaved changes from 14:32?" (ModalProvider `confirm`).
  - Plugin blobs are captured on snapshot (an engine `getState` call), not per op.
- **Versioning and migrations:**
  - `schemaVersion: int`. `shared/schema/migrations/NNN-description.ts` holds pure `(v_n) → v_{n+1}` functions, chained on load, then validated with **zod**.
  - Fixture projects per version live in `test/fixtures/`, with round-trip tests.
  - Refuse newer files with KryptEditor's message ("saved by a newer version — update the app", `project.ts` L86–88).
  - **Fail loudly instead of half-loading** (`project.ts` L74–91 philosophy).
- **Sample references and relinking:**
  - `SampleRef = { relPath (relative to the project file), absPath, hash, bytes, name, … }`. The hash is xxhash64 of size + first/last 1 MB for speed, with an optional full hash.
  - Resolution order on load:
    1. `relPath` from the project dir
    2. `absPath`
    3. the bundle's `samples/`
    4. the user's library folders, by name + hash
    5. **Missing Samples dialog**: "Search folder…" (recursive scan in main, matching name, then hash), "Locate…" per file, or "Keep as missing".
  - Missing samples stay in the doc as **placeholders**. Never drop clips. KryptEditor's NFC + Windows case-fold path matching (`project.ts` L100–107, `allowlist.ts`) carries over.
- **ID-stable copy/paste between projects**: paste re-mints IDs and remaps references (sample, plugin and pattern refs) inside the command.

---

## 5. Transport and playhead sync with the engine clock

### 5.1 What the engine must publish (contract for the engine report)

```ts
TransportFrame {                       // ~every audio callback, throttled to ≤120 Hz, binary
  seq: u32                             // increments every frame
  jump: u32                            // increments on discontinuity (seek, loop wrap, stop/start)
  playing: bool, recording: bool
  samplePos: f64                       // timeline position (samples) of the first sample of the buffer
  tickPos: f64                         // same position in ticks (engine resolves tempo map)
  ticksPerSec: f64                     // instantaneous rate (tempo automation aware)
  engineTimeNs: u64                    // QPC time when this buffer's first sample is expected to be AUDIBLE
                                       //   = callback time + output latency (driver/device reported)
  outputLatencySamples: u32, sampleRate: u32, bufferSize: u32
  loop: [startTick, endTick] | null
}
```

### 5.2 UI interpolation (`src/live/transport.ts`)

1. **Clock mapping.** Keep `offset ≈ min(arrivalPerfNow − engineTimeMs)` over a sliding window of about 2 s. The minimum filter strips IPC jitter, a standard one-way clock-sync trick. It needs no shared clock, though on Windows both sides are ultimately QPC-based.
2. **Predict at paint time.** `T = rafTimestamp + displayLeadMs`. `displayLeadMs` ≈ one refresh interval, plus a user "visual offset" setting.
   - `predicted = tickPos_k + (T − (engineTime_k + offset)) / 1000 · ticksPerSec_k`.
3. **Smooth, don't snap:** `shown += (predicted − shown) · (1 − e^(−dt/τ))` with τ ≈ 60 ms. Snap immediately when `jump` changes or `|error| > 50 ms`. Never move backwards while playing unless `jump` changed.
4. **What you see is what you hear.** `engineTimeNs` already includes output latency, so the line crosses a note exactly when the note is audible.
5. **Stopped state:** show `tickPos` exactly. Seeks from the UI update the line immediately (local echo) and reconcile on the next frame with the new `jump`.
6. **Consumers:**
   - Playhead DOM transforms (every frame).
   - Follow-scroll: FL-style page flip by default, smooth-scroll option.
   - The time readout in the transport bar: direct `textContent` writes at ≤15 Hz from the frame loop, not React state.
   - Step highlight in the channel rack (overlay layer).

Prior art:

- openDAW's engine writes `isPlaying`, `bpm`, position (PPQN) and a `playbackTimestamp` into a SharedArrayBuffer "SyncStream" that the UI reads each frame. That is the same contract as `TransportFrame`, minus our latency field.
- In pure Web Audio the equivalent anchor is `AudioContext.getOutputTimestamp()` (`contextTime` + `performanceTime`). We don't use it, because our clock lives in the native engine.

KryptEditor's anchor/re-anchor-on-external-seek loop (`Preview.tsx` L215–245) is the seed for steps 2–5. The difference is that the anchor now comes from engine frames instead of `performance.now()` at play start, and the output goes to `live/transport` instead of the doc store.

### 5.3 Meters

- **Engine side:**
  - Per strip, per block: peak = max|x| (optionally true-peak) and RMS. **Accumulate max since the last publish**, so a 1-sample transient between UI frames is never lost.
  - Publish at 60 Hz: `Float32Array[strip*4] = peakL, peakR, rmsL, rmsR` (126 × 16 B ≈ 2 KB per frame).
  - Plus clip flags. The master can add LUFS-M/S.
- **Transport to UI:** v1 = engine → main → a dedicated `MessagePort` per window (`MessageChannelMain`), with ArrayBuffers *transferred*. No `ipcMain.handle` dispatch and no JSON. Optimization later: a shared-memory ring (Win32 file mapping) read from preload via **koffi** (house stack; `sandbox:false` is already the KryptEditor setting), giving zero-copy meters and transport.
- **Ballistics in the frame loop**, in dB and timestamp-based (frame-rate independent, survives rAF throttling):
  - `shown = max(incoming, shown − decay·dt)`. Decay presets:
    - "PPM": 20 dB in 1.7 s ≈ **11.8 dB/s**, the IEC 60268-18 digital PPM and IEC 60268-10 Type I return figure.
    - "Fast" (FL-like default): ≈ 24 dB/s.
    - "BBC Type II": 24 dB in 2.8 s.
  - Peak-hold tick held 1.5 s, then falls.
  - The clip LED latches until clicked.
  - RMS is drawn as an inner bar.
- **Draw** all visible strips into one canvas: a precomputed gradient, a `fillRect` per channel, a dB scale cached on L0.
- **Hidden windows** get no paint, and their ballistics catch up on the next frame from timestamps. The engine stops sending to ports whose window reports `visibilityState === 'hidden'`.
- **Subscription flags (from openDAW).** openDAW's `LiveStream` puts engine telemetry into a SharedArrayBuffer that the UI reads once per animation frame. The UI writes back per-address *subscription flags*, so the engine skips work (FFT, meters) for anything nobody is watching. We do the same over the port: panels subscribe to meter, scope and param ids, and the engine computes and sends only those.

---

## 6. Input

### 6.1 Shortcut system (`src/input/`)

- **Command registry:** `{ id, label, run(ctx), when?: ContextExpr }`. These are the same command ids the menus, the hint bar and MCP use (e.g. `transport.togglePlay`, `view.toggle.pianoRoll`, `edit.undo`, `pianoRoll.tool.paint`).
- **Keymap:** `shared/keymap.ts` holds FL defaults as data. User overrides go in `userData/keymap.json`, with a Settings → Shortcuts editor that detects conflicts. These defaults are verified against the Image-Line shortcuts page:

| Key | Command | Key | Command |
|---|---|---|---|
| F5 | Toggle Playlist | Space | Start / stop |
| F6 | Toggle Channel rack | Ctrl+Space | Start / pause |
| F7 | Toggle Piano roll | L | Pattern ↔ Song mode |
| F8 | Plugin picker | R | Record |
| Alt+F8 | Browser | Ctrl+M | Metronome |
| Ctrl+F8 | Project picker | Ctrl+H | Panic (all notes off) |
| F9 | Toggle Mixer | Ctrl+Z | Undo/redo last (FL toggle; see §4.4) |
| F10 | MIDI settings | Ctrl+Alt+Z | Undo step-by-step |
| F11 | Song info | Ctrl+S / Ctrl+N | Save / save new version |
| F12 / Alt+F12 / Ctrl+F12 | Close all / plugin / unfocused windows | Ctrl+R | Export WAV |
| Enter | Max/min Playlist | Numpad + / − | Next / previous pattern |
| Tab | Cycle windows | F4 | Next empty pattern |
| Esc | Close window | Ctrl+T | Typing keyboard to piano |
| F1 | Help | Alt+Numpad 2–6 | Typing-keyboard octave |
| Shift+Ctrl+H | Realign windows | | |

  **Ctrl+R conflicts with Electron's default-menu reload**, which is one more reason to remove the default menu.
- **Context** = the focused dockview panel's kind, plus flags (`isTyping`, `typingPianoOn`, `gestureActive`, `pluginFocused`). Panel bindings are resolved first, then global ones.
- **Matching:**
  - `KeyboardEvent.code` for layout-independent physical keys: transport, F-keys, piano typing, tool letters like FL's.
  - `key` + modifiers for mnemonic edit commands (Ctrl+Z, Ctrl+C), so AZERTY/QWERTZ users get the letters they expect.
  - Ignore `e.repeat` for toggles.
  - Use KryptEditor's typing-target guard: INPUT/TEXTAREA/SELECT/contentEditable (`Editor.tsx` L352–354).
- **Attach to every window's document** (popouts).
- **Electron specifics:**
  - Remove the default application menu in production, which binds Ctrl+R reload, Ctrl+Shift+I, Ctrl+W and Ctrl+Q accelerators.
  - Use `webContents.on('before-input-event')` to stop a lone **Alt/F10** from activating the hidden menu bar.
  - F12 and devtools are disabled when packaged, as KryptEditor already does in `main.ts` L106.
- A small parser such as `tinykeys`-style `"$mod+Shift+KeyZ"` is enough. Use the library or about 150 LOC of our own (status in §10).

### 6.2 Typing keyboard as piano

- Toggle with **Ctrl+T** (FL), with a toolbar button lit while on. **While on, bare letter keys are captured** for notes and tool shortcuts are suspended, as FL does. Octave via **Alt+Numpad 2–6** (FL). FL's options panel also exposes root note, octave, layout and snap-to-scale; we expose the same.
- Layout (tracker style, physical `code`). FL's manual doesn't print the map; this matches a third-party emulator that claims identical mapping, so verify against FL during QA. 37 keys:
  - Lower octave: `KeyZ`=C, `KeyS`=C#, `KeyX`=D, `KeyD`=D#, `KeyC`=E, `KeyV`=F, `KeyG`=F#, `KeyB`=G, `KeyH`=G#, `KeyN`=A, `KeyJ`=A#, `KeyM`=B, then `Comma`=C+1, `KeyL`, `Period`, `Semicolon`, `Slash`.
  - Upper octave: `KeyQ`=C+1, `Digit2`=C#, `KeyW`=D, `Digit3`=D#, `KeyE`=E, `KeyR`=F, `Digit5`=F#, `KeyT`=G, `Digit6`=G#, `KeyY`=A, `Digit7`=A#, `KeyU`=B, `KeyI`=C+2, `Digit9`, `KeyO`, `Digit0`, `KeyP`, `BracketLeft`, `Equal`, `BracketRight`.
  - Velocity is fixed (settings), with a modifier for accent.
- `keydown` (non-repeat) sends `noteOn(channel = selected channel)` **straight to the engine** over the live port, not through DocHost. `keyup` sends noteOff. On window `blur` and `visibilitychange`, send all-notes-off, so no notes stick.
- Recording from the typing keyboard: the engine timestamps on arrival. Typing-keyboard latency is dominated by the OS key-event path and is fine for sketching; real recording uses MIDI (below).

### 6.3 MIDI input path

| | Web MIDI in Chromium | **Native engine (chosen)** |
|---|---|---|
| Path to sound | Device → Chromium browser process → renderer IPC → **JS main thread** (shared with React/painting) → IPC → main → engine | Device → engine MIDI thread → audio graph |
| Latency / jitter | Adds IPC hops plus main-thread jitter (a busy frame = several ms) | Minimal; sample-accurate timestamps against the audio clock |
| Recording | Must map `event.timeStamp` into engine time; jitter shows in recorded timing | Engine records directly into the take, sample-accurately |
| Device ownership | On Windows 10 and classic WinMM, **ports are single-client**: if Chromium opens a device, the engine can't | Engine is the single owner |
| Windows MIDI Services (multi-client, MIDI 2.0) | — | Rolled out to Windows 11 24H2/25H2 retail from **Feb 2026**. **Not on Windows 10**, so we must still behave on single-client WinMM |

**Decision:** the engine opens and owns every MIDI device. KryptStudio never calls `navigator.requestMIDIAccess()`. It also denies the `midi`/`midiSysex` permission in **both** `session.setPermissionRequestHandler` and `setPermissionCheckHandler` to make that explicit; Electron's docs say both are needed. If a JS-side MIDI fallback were ever wanted (e.g. a diagnostics tool), `@julusian/midi` 3.8 (RtMidi, N-API prebuilds, no rebuild) is the maintained Node option. `midi` (node-midi) is unmaintained and builds from source, which breaks the house rule. The engine forwards a **copy** of incoming events to the UI over the live port at low priority, for:

- Piano-roll and channel keyboard highlights
- The MIDI activity LED
- "Link to controller…" learn mode
- The piano-roll "step record" cursor

### 6.4 Touch and pen basics

- **Pointer Events everywhere** with `setPointerCapture` (works across popouts) and `touch-action: none` on surfaces.
- **Pen:**
  - `pointerType === 'pen'`. The barrel button arrives as `buttons & 2`, so map it to right-click (delete/erase, as in FL).
  - **Pressure → note velocity** when drawing notes (a cheap, delightful touch).
  - Hover is supported.
- **Touch:**
  - Long-press (≈500 ms, <6 px movement) = context menu.
  - Two-finger pinch = zoom anchored at the centroid; two-finger pan = scroll.
  - Precision-touchpad pinch arrives as `ctrlKey` wheel events, already handled by KryptEditor's zoom code (`Timeline.tsx` L102–117).
- A "touch mode" setting enlarges hit targets (knob drag zones, note-edge zones). Full touch UX is post-v1.

---

## 7. Recommended folder structure

This extends kryptguidelines §4.2. The layering rules (§4.3) stay. **`engine/` is a Cargo workspace built by `npm run engine:build` / CI, never by `npm install`**, which keeps the house "no compile at install" rule; the built binary ships in `resources/bin/`.

```
KryptStudio/
├── build/                       # electron-builder assets (installer.nsh)
├── resources/                   # krypt.png/.ico, bin/krypt-engine.exe (built), factory presets/packs, default layouts
├── scripts/                     # make-ico, engine-build.mjs (cargo → resources/bin), gen-engine-types.mjs
├── research/                    # these reports
├── shared/                      # pure TS used by main, renderer, mcp, tests (no DOM, no Node, no Electron)
│   ├── types.ts                 # KryptApi (window.krypt.*), ActionResult  (KryptEditor shared/types.ts pattern)
│   ├── schema/
│   │   ├── project.ts           # Project/Channel/Pattern/Note/... types + zod schemas
│   │   ├── ids.ts               # actor-prefixed ULIDs, ParamRef encode/decode, fractional order keys
│   │   ├── ops.ts               # Patch, Txn, HistoryEntry, Actor, wire messages (doc:exec, doc:patches)
│   │   ├── time.ts              # PPQ, ticks ↔ bars:steps:ticks, snap grids
│   │   ├── automation.ts        # evalAutomation(points, tick) — golden-tested against engine
│   │   └── migrations/          # 001-…ts, index.ts (chain)
│   ├── commands/                # semantic commands (draft mutators) — UI + MCP call the same ones
│   │   ├── notes.ts  patterns.ts  channels.ts  playlist.ts  mixer.ts  automation.ts  params.ts  samples.ts
│   │   └── registry.ts          # id → {argsSchema(zod), run, label(args)}
│   ├── engine-protocol.gen.ts   # generated from engine/ (ts-rs/specta) — never hand-edited
│   └── keymap.ts                # FL-default bindings as data
├── electron/
│   ├── main.ts                  # bootstrap, single-instance, file associations, window creation
│   ├── preload.ts               # contextBridge → window.krypt.* (+ live ports, optional koffi shm reader)
│   ├── ipc.ts                   # ALL ipcMain.handle() in one file
│   ├── windows/                 # main window, popout policy (setWindowOpenHandler), bounds persistence, multi-monitor clamp, plugin-wrapper windows
│   ├── dochost/                 # authoritative store — pure TS, movable to utilityProcess
│   │   ├── DocHost.ts           # exec(cmd) → patches → commit → broadcast
│   │   ├── history.ts           # groups, per-actor stacks, selective undo
│   │   ├── journal.ts           # NDJSON op log + replay
│   │   └── snapshot.ts          # autosave cadence, backups rotation
│   ├── project/                 # bundle.ts (zip r/w), atomic.ts, relink.ts, recovery.ts, grants.ts
│   ├── engine/                  # EngineBridge (spawn via system/, protocol client), EngineAdapter (doc→engine), telemetry fan-out to MessagePorts
│   ├── mcp/                     # in-app MCP host (localhost Streamable HTTP + token) and/or named-pipe endpoint for mcp/ stdio shim
│   └── system/                  # the ONLY OS-touching code: files, dialogs, process spawn, tray, discord, logger, shm (koffi),
│                                #   appProtocol.ts (serves the renderer on app:// — standard+secure — so popouts are same-origin)
├── engine/                      # Rust workspace (sibling report) — e.g. crates/{core,graph,host-vst3,host-clap,midi,ipc}
├── mcp/                         # stdio MCP shim package (spawned by agent clients) → connects to running app via named pipe
│   └── src/{server.ts, tools/*.ts}   # tool schemas = thin wrappers over shared/commands
├── src/                         # renderer
│   ├── app/                     # App.tsx shell, providers, TransportBar (TopBar), HintBar, Settings, About
│   ├── workspace/               # WindowManager facade over dockview, panel registry, FL-style headers, layouts, popout glue
│   ├── panels/
│   │   ├── playlist/            # Playlist.tsx, painters/, tools/, viewStore.ts
│   │   ├── pianoRoll/           # PianoRoll.tsx, painters/{grid,notes,keyboard,eventLane}.ts, tools/{draw,paint,select,slice,...}.ts
│   │   ├── channelRack/  mixer/  browser/  pluginWrapper/  automation/  history/  agentActivity/
│   ├── render/                  # frameLoop.ts, Surface.tsx (layered HiDPI canvases), viewport.ts, colors.ts, text.ts, cache/LRU, webgl2/ (later)
│   ├── live/                    # NON-React stores: transport.ts, meters.ts, params.ts, midiActivity.ts, scopes.ts
│   ├── doc/                     # Zustand replica, applyPatches, selectors/indexes, dispatch() → window.krypt.doc.exec
│   ├── controls/                # useParamDrag, Knob, Fader, Slider, StepButton, ValueTooltip, ParamMenu, TypeInValue
│   ├── input/                   # commands registry, keymap matcher, typingPiano.ts, pointer.ts (capture/lock), touch.ts
│   ├── workers/                 # waveformTiles.worker.ts, spectrogram.worker.ts, peaks.worker.ts
│   ├── components/common.tsx    # Krypt UI kit (from KryptEditor)
│   ├── state/                   # ToastProvider, ModalProvider, AppStateProvider (from KryptEditor)
│   ├── utils/format.ts
│   └── index.css, main.tsx, global.d.ts
├── test/                        # node:assert + esbuild harness (KryptEditor test/ pattern): schema, migrations, commands,
│   └── fixtures/                #   history/selective-undo, journal replay, transport interpolation, automation golden values
├── index.html  popout.html       # popout.html = blank same-origin page dockview opens for detached windows (2nd Vite input)
├── tsconfig.json  tsconfig.node.json  vite.config.ts  tailwind.config.js  package.json
```

Vite: add `electron/` entries for `main`, `preload` and (later) a `dochost` utility-process entry. Add the `mcp/` shim as a separate esbuild target. Keep the `@shared` alias (KryptEditor `vite.config.ts`).

---

## 8. KryptEditor reuse list

Paths are relative to the KryptEditor repository (a sibling Krypt project).

### 8.1 Copy nearly as-is

| What | Where | Use in KryptStudio |
|---|---|---|
| Krypt UI kit (Page, Section, Card, buttons, IconButton, Switch, TextInput, **NumberInput** with string buffer, Empty, Badge) | `src/components/common.tsx` | `src/components/common.tsx` |
| Toasts, in-app modal `confirm()/prompt()` (Electron no-ops native dialogs), app state | `src/state/ToastProvider.tsx`, `ModalProvider.tsx`, `AppStateProvider.tsx` | Same. Recovery prompt, relink dialog, unsaved-changes guard. |
| `cls()`, `IS_MAC`, `MOD_KEY`, byte/time formatters | `src/utils/format.ts` | Add `fmtBST()` (bar:step:tick) |
| **Atomic write** (tmp + rename) | `electron/system/files.ts` L53–62 | `electron/project/atomic.ts` (add fsync) |
| **Granted project paths** (renderer can't mint write access) | `electron/system/files.ts` L214–270 | `electron/project/grants.ts` |
| Autosave with `.bak` rotation + read fallback | `electron/system/files.ts` L272–300 | Snapshot layer under the new journal |
| **Streamed export** (`.part` + positioned writes + rename on commit) | `electron/system/files.ts` L164–212 | Audio export / stem render to disk |
| Atomic settings + `mergeState` + **broadcast to all windows** | `electron/system/settings-store.ts` | App settings, keymap, layouts |
| Logger broadcast → toasts | `electron/system/logger.ts`, `src/App.tsx` L65–73 | Same |
| IPC contract style (`ActionResult`, `ok/err`, one file, `safeOpenExternal`) | `electron/ipc.ts`, `electron/preload.ts`, `shared/types.ts`, `src/global.d.ts` | Same |
| Single-instance lock, `second-instance` and `open-file` intake, launch-file queue drained on mount, reveal-timer fallback, navigation lock, webview ban | `electron/main.ts` L25–52, L83–160 | Same, **but drop close-to-tray** (a DAW must prompt to save on close) and **replace the deny-all `setWindowOpenHandler`** with the popout policy (§2.3) |
| Path allowlist + custom streaming protocol (range requests, `registerScheme()` before ready, `installHandler()` after) | `electron/system/allowlist.ts`, `electron/system/mediaProtocol.ts` | Two uses: (1) the **`app://` renderer protocol** that makes dockview popouts same-origin (§2.3); (2) browser previews of images, plugin thumbnails, fallback sample decode |
| Swallow stray file drops (else Electron navigates to `file://`) | `src/App.tsx` L161–174 | Same |
| Restore-autosave-on-launch flow | `src/App.tsx` L75–120 | Becomes the journal-recovery prompt |
| CSP plugin, electron entries, `@shared` alias, `worker.format: 'es'` | `vite.config.ts` | Same, plus a `connect-src` for the MCP localhost endpoint if UI-visible |
| Test harness (esbuild-bundled pure logic + `node:assert`) and CI/release workflows | `test/entry.editor.ts`, `test/editor.test.mjs`, `.github/workflows/ci.yml`, `release.yml` | Same pattern for schema/commands/history tests |
| Custom-MIME in-app drag types | `src/editor/dndStore.ts` | Browser → channel rack / playlist / mixer slot drags |

### 8.2 Adapt (port the logic, change the substrate)

| What | Where | Adaptation |
|---|---|---|
| **Gesture-scoped history**: push once on the *first move*, not on pointerdown; one entry per drag | `src/editor/Timeline.tsx` L363–371, L420–428; KeyMarker L785–797; Inspector "push on pointerdown/focus" (`Inspector.tsx` L49–54, L1273–1292) | Becomes DocHost **groups** (`beginGesture` / `endGesture`, coalesced sets) |
| Snapshot undo with structural sharing, 100-entry cap, selection pruning after undo | `src/editor/timelineStore.ts` L665, L684–703 | Replaced by patch-based history in DocHost. Keep "prune selection to surviving ids" in replicas. |
| **Ctrl+wheel zoom anchored at the cursor** (exponential delta; non-passive listener; trackpad pinch) | `src/editor/Timeline.tsx` L97–120 | `render/viewport.ts` `zoomAt(x, factor)` for all surfaces |
| **Edge auto-scroll during drags** (rAF, content-space coordinates, re-fire drag update) | `src/editor/Timeline.tsx` L130–168 | Same logic driving our own scroll offsets |
| **Snapping** in pixel space to targets (playhead, clip edges) | `src/editor/Timeline.tsx` L240–261 | Generalize: grid snap + object snap with px threshold |
| **Marquee select** in content coordinates (survives scrolling) | `src/editor/Timeline.tsx` L279–331 | Overlay-layer painter + index query instead of a DOM rect + array scan |
| Multi-select move across lanes (origins map, primary clip snapping both edges, lane delta, kind check) | `src/editor/Timeline.tsx` L333–407 | Playlist clip move / piano-roll note move (pitch = lane) |
| Edge trim with snapping | `src/editor/Timeline.tsx` L409–446 | Note/clip resize tools |
| `memo` comparator that ignores callbacks reading live store state | `src/editor/Timeline.tsx` L658–664 | For DOM rows (channel rack, mixer strips) |
| Waveform drawing loop | `src/editor/Timeline.tsx` L989–1025 | Move into a tile worker; add DPR, min/max columns and tiling |
| Peaks decode-once + in-flight dedupe + "don't cache failures" | `src/editor/peaks.ts` | Same cache shape. Algorithm → multi-resolution min/max pyramid, **no normalization**, all channels. |
| Thumbnail cache pattern | `src/editor/thumbs.ts` | Pattern-preview bitmap cache |
| **Click-to-type value field** (unit-aware, Enter/Esc, clamp on commit) | `src/editor/Inspector.tsx` L1186–1236 | Knob/fader typed entry |
| Keyframe-aware slider (◇ toggle, value = resolved at playhead) | `src/editor/Inspector.tsx` L1093–1180 | "Param is automated" indicator + automation-follow |
| Easing curves + keyframe split/retime helpers (pure, tested) | `src/editor/timelineStore.ts` L268–302, L1568–1625 | Seed for `shared/schema/automation.ts` (FL tension curves) and automation clip split/trim |
| Playback clock with anchor / re-anchor on external seek, 60 Hz write cap | `src/editor/Preview.tsx` L215–245 | `live/transport.ts`, anchored on engine frames, writing to a non-React store |
| Keyboard handler (typing-target guard, mod handling, paste only when the internal clipboard is non-empty) | `src/pages/Editor.tsx` L349–419 | Seed for the command registry; same guards |
| react-resizable-panels with `autoSaveId` | `src/pages/Editor.tsx` L485–505 | Splits *inside* panels (piano roll ↔ event lane) |
| Project validation before apply, newer-schema refusal, missing-media detection with NFC + Windows case-fold | `src/editor/project.ts` L56–131 | Loader step before migrations; becomes the relink flow |
| Dirty tracking + debounced autosave that ignores non-doc changes | `src/App.tsx` L122–159 | Moves to DocHost (journal makes debounce unnecessary). Keep the lesson. |
| Worker setup (ES workers, dynamic imports) | `src/editor/captionWorker.ts`, `src/editor/ttsWorker.ts` | Waveform/spectrogram workers |
| `TopNav` compact top navigation | `src/components/TopNav.tsx` | Base for the transport/top bar (FL's top toolbar) |

### 8.3 Do **not** carry over

- Playhead inside the document store, re-rendering React at 60 Hz (`Preview.tsx` L237–239).
- DOM-per-clip timeline without virtualization (`Timeline.tsx` `ClipBlock`). Fine for tens of clips, not FL scale.
- `window.addEventListener('pointermove'…)` drag plumbing (`Timeline.tsx` L69–78, L318–330). It breaks in popouts; use pointer capture.
- Per-clip canvases sized to clip width, without DPR (`Timeline.tsx` L1007–1010). These are blurry on HiDPI and exceed canvas limits at high zoom.
- `uid()` built from `Date.now()` + counter (`timelineStore.ts` L529–530).
- Close-to-tray, and deny-all `window.open`.

---

## 9. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **All same-process windows share one JS thread**, so a heavy panel janks everything | Stutter on 144 Hz / multi-monitor | Paint budget + dirty flags; workers for raster; stress fixtures in CI-ish perf tests. Doc replicas make "own-process window" mode possible later. |
| 2 | **Native plugin windows** (z-order, focus, keyboard capture, DPI awareness, hung plugin stalls an attached input queue) | Biggest UX risk in a Windows DAW | v1: engine-owned top-level windows owned by our HWND; forward global keys; DPI context per window; v2 re-parenting only after sandboxing is settled. |
| 3 | **User and agent concurrent edits** confuse undo or clobber work | Trust | Per-actor undo with conflict-checked inverses, History panel with actor badges, agent groups as single entries, "Pause agent edits", checkpoint before agent groups. |
| 4 | **Main-process DocHost latency** under heavy commands (quantize 50k notes) blocks window management | Input lag | DocHost is pure TS → move to `utilityProcess`; use Mutative; chunk huge imports. |
| 5 | **Playhead jitter or drift** from IPC jitter and clock mapping | "Feels cheap" | Min-filter offset, exponential smoothing, `jump` counter, output-latency-aware engine timestamps; optional shared memory via koffi. |
| 6 | **UI/engine model drift** (TS schema vs Rust projection; automation curve math) | Wrong playback vs display | Generate TS types from Rust (`ts-rs`/`specta`); golden-value tests for curves shared by both suites; EngineAdapter contract tests. |
| 7 | **Windows 10 single-client MIDI** (no Windows MIDI Services) | Device conflicts | Engine is the sole MIDI owner; never touch Web MIDI; deny the permission. |
| 8 | **dockview limits** for FL-exact behaviour (snapping, magnetic edges, custom maximize) | Rework | `WindowManager` facade; fallback to rc-dock or custom MDI without touching panels. |
| 9 | **Popout gotchas** (rAF, listeners, fonts, portals, DPR) | Subtle breakage in detached windows | `ownerDocument`-aware helpers in `render/` and `input/`; a "popout everything" smoke test. |
| 10 | **Canvas text / large-canvas fill-rate at 4K** | Frame drops | Repaint content only on change; playhead via DOM transform; label culling; WebGL2 content layer if needed. |
| 11 | **GPU process crash / context loss** (Canvas2D `contextlost`, WebGL `webglcontextlost`) | Blank panels | Handle restore events; painters are stateless → just mark dirty. |
| 12 | **Immer/Mutative on 50k-entity docs** | Slow commands | Benchmark early; hand-written patch emitters for hot paths (note drag); keep patches field-level. |
| 13 | **Pointer Lock quirks** (Esc releases lock, needs user activation, possible UI bubble, raw-movement support varies) | Knob feel | Fallback to pointer capture + `movementY`; test in packaged Electron. |
| 14 | **Zip save time** with large bundled samples | Slow Ctrl+S | Samples external by default; "Collect" is explicit; stream-copy unchanged entries; journal makes saves non-critical for safety. |
| 15 | **Electron upgrades** changing rAF throttling, pointer lock, permission APIs | Regressions | Pin Electron; quarterly upgrade with a smoke checklist (popouts, meters in background, plugin windows, MIDI). |
| 16 | **Accessibility** (canvas surfaces are opaque to screen readers) | Exclusion | DOM controls are ARIA-complete; every edit is a command (keyboard + MCP give non-visual paths). |
| 17 | **License contamination.** openDAW and GridSound are **AGPL-3.0**; KryptStudio is MIT | Legal | Study architecture only, never copy code. Signal and `@ryohey/webgl-react` are MIT, so borrowing (with notices in THIRD-PARTY-NOTICES.md) is fine. |
| 18 | **dockview open-core drift.** v8 moved snapping, layout-undo and auto-hide edges to a paid package; future features may follow | Feature gaps | We depend only on the MIT core (grid, floating, popout, serialization); the facade keeps flexlayout-react (MIT) as an exit. |
| 19 | **React 18 vs an ecosystem moving to 19** (`@pixi/react` 8 and `react-konva` 19.3 need React 19; `react-knob-headless` caps at 18) | Dependency friction | Our picks (dockview, Radix, TanStack Virtual, Zustand 5) support 18 and 19. Plan a React 19 bump as a separate, early decision, not mid-project. |
| 20 | **Electron baseline.** KryptEditor is on Electron 30; current stable is **44.7** (Chromium 152, Node 24) | Missing APIs (`node:sqlite`, newer `protocol.handle`, permission fixes) | Start KryptStudio on 44.x; don't copy KryptEditor's `package.json` versions. |

---

## 10. Library versions and maintenance (verified 2026-10)

Versions and release dates come from the npm registry. Activity comes from GitHub push and commit dates, as of 2026-10-11.

| Package | Latest | Released | Maintained | License | Role in KryptStudio |
|---|---|---|---|---|---|
| electron | 44.7.0 (Chromium 152, Node 24.21) | 2026-10-07 | yes (45 beta) | MIT | **Shell — start on 44.x** |
| dockview / dockview-react | 8.5.1 | 2026-10-10 | very active | MIT (enterprise add-on is commercial) | **Window manager** |
| flexlayout-react | 0.11.1 | 2026-09-26 | very active | MIT | Fallback window manager |
| rc-dock | 4.1.0 | 2026-09-30 | yes | Apache-2.0 | Fallback |
| golden-layout | 2.6.0 | 2022-09-26 | stalled | MIT | Rejected |
| react-mosaic-component | 7.2.1 | 2026-09-28 | yes | Apache-2.0 | Rejected (no floating) |
| react-resizable-panels | 4.14.4 | 2026-10-10 | yes | MIT | In-panel splitters |
| zustand | 5.0.15 | 2026-08-13 | yes | MIT | Doc replica + view stores |
| immer | 11.1.21 | 2026-10-02 | very active | MIT | Patches (`enablePatches`, `produceWithPatches`, `applyPatches`) |
| mutative | 1.3.0 | 2025-09-21 | yes (repo active) | MIT | **Preferred** draft/patch engine in DocHost (Immer-compatible patches, ~3.6× faster per README) |
| zundo | 2.3.0 | 2024-11-17 | low | MIT | Not used (snapshot undo) |
| @preact/signals-react | 3.12.0 | 2026-08-04 | yes | MIT | Not used |
| yjs | 13.6.33 | 2026-09-23 | yes | MIT | Not in v1 (future collab option) |
| @automerge/automerge | 3.5.0 | 2026-09-16 | yes | MIT | Not in v1 (no built-in undo) |
| loro-crdt | 1.16.4 | 2026-09-30 | very active | MIT | Not in v1 (best future-collab candidate) |
| pixi.js | 8.22.0 | 2026-10-01 | very active | MIT | Plan C (imperative) |
| @pixi/react | 8.0.5 | 2025-12-01 | slowing | MIT | Incompatible (React ≥19) |
| twgl.js | 7.0.0 | 2025-07-16 | light | MIT | WebGL2 helper for the upgrade path |
| regl | 2.1.1 | 2024-11-12 | dormant | MIT | Rejected |
| konva / react-konva | 10.7.1 / 19.3.0 (18.2.16 legacy) | 2026-10 / 2026-09 | yes | MIT | Not used |
| @tanstack/react-virtual | 3.14.14 | 2026-10-09 | yes | MIT | DOM virtualization |
| @radix-ui/react-context-menu | 2.3.8 | 2026-10-05 | yes | MIT | Param and panel context menus (portal container for popouts) |
| @radix-ui/react-slider | 1.5.0 | 2026-10-05 | yes | MIT | Reference only (custom controls) |
| @floating-ui/react | 0.27.20 | 2026-07-11 | yes | MIT | Tooltips and popovers |
| react-knob-headless | 0.4.0 | 2025-06-25 | dormant (React ≤18) | MIT | ARIA reference only |
| tinykeys | 4.0.1 | 2026-09-25 | revived 2026 | MIT | Optional keymap parser |
| hotkeys-js / react-hotkeys-hook | 4.0.8 / 5.3.3 | 2026-09 / 2026-06 | yes | MIT | Not needed |
| mousetrap | 1.6.5 | 2020-01-23 | unmaintained | Apache-2.0 | Rejected |
| yazl / yauzl | 3.3.1 / 3.4.0 | 2024-11 / 2026-06 | low / yes | MIT | **Project zip write/read (streaming)** |
| fflate | 0.8.3 | 2026-05-16 | yes | MIT | In-memory/worker zip alternative |
| jszip | 3.10.2 | 2026-09-08 | slow | MIT/GPL-3 | Rejected (in-memory) |
| better-sqlite3 | 13.0.3 (N-API, in-package prebuilds) | 2026-08-05 | yes | MIT | Not needed; `node:sqlite` suffices |
| @julusian/midi | 3.8.1 (N-API prebuilds) | 2026-08-10 | yes | MIT | Not used (engine owns MIDI) |
| zod | 4.6.5 | 2026-09-13 | yes | MIT | Schema validation (commands args, project load) |
| @ryohey/webgl-react | 0.7.1 (peer React ≥ 18.1) | 2025-11-15 | light | MIT | Reference/borrow for the WebGL2 instanced-notes upgrade |

---

## 11. Field notes: existing web DAWs and FL Studio behaviour

### openDAW (andremichelle/openDAW) — AGPL-3.0, very active (pushed 2026-10-10)

- **UI:** its own `lib-jsx`. JSX creates real DOM nodes once, with **no virtual DOM and no re-rendering**. Reactivity is through `Inject.*` helpers that patch text, attributes and classes directly.
- **Rendering:** `CanvasPainter` wraps Canvas2D with DPR and resize handling, and redraws on `requestUpdate()` through one shared `AnimationFrame`.
  - The piano roll is one canvas of `fillRect`s.
  - Waveforms use **multi-resolution peaks** (`PeaksPainter.renderPixelStrips` picks the nearest stage per pixel), built off-thread in a `SamplePeakWorker`.
  - WebGL appears only for a Shadertoy visualiser and video.
  - The global frame loop is **capped at about 60 fps** because 120 Hz doubled the work of 31+ subscribers.
- **Document:** `lib-box` is a typed object graph: boxes, fields and typed pointers. Schemas are declared with numbered field keys and code-generated by `box-forge`. Deletion cascades through mandatory pointers. Selection is modelled as boxes.
- **Undo:** `editing.modify()` transactions record forward/inverse updates (op log, not snapshots). Gestures seal with `mark()`.
- **Engine sync:** the full project is serialized at start. After that, `SyncSource` sends batched diffs on each `endTransaction` over a MessagePort to the worklet's `SyncTarget`. The audio core is **Rust → WASM** since July 2026 (≥2× faster on average). Transport and meters reach the UI via **SharedArrayBuffer** streams polled per frame, with subscription flags back to the engine. Cross-origin isolation is required.
- **Collab:** Yjs server plus a **deterministic reconcile** layer for graph invariants.
- **Takeaway:** the closest public validation of our design (op transactions, engine projection by diff, one frame loop, Canvas2D painters, multi-resolution peaks, subscription-gated telemetry). Code can't be reused (AGPL vs MIT).

### Signal (ryohey/signal) — MIT, React 19 + Electron shell

- Per-editor packages: pianoroll, arrange, tempo, velocity, control.
- State moved **off MobX** (it "leaked mutable state into app"). Now Jotai for app/UI state, and a core domain store read via `useSyncExternalStore`, with **leaf-hook subscriptions** rather than prop-drilling high-churn data.
- The piano roll uses **`@ryohey/webgl-react`** (MIT): instanced WebGL2 shapes with per-instance `bounds`/`state` attributes, a WebGL1 fallback, and `HitArea` components for input.
- Undo is **full snapshots** (`serialize()` + `cloneDeep` of atoms).
- Files are Standard MIDI only.
- **Takeaway:** a proven React path for the WebGL upgrade; its undo model is the one to avoid at FL scale.

### Audiotool (Nexus)

- `@audiotool/nexus` (MIT, early alpha): the document is a set of entities with typed fields and pointer fields.
- **Three primitives** (create / update field / remove) inside locked `modify()` transactions.
- The backend is authoritative and resolves conflicts. Protobuf over Connect RPC, with quoted 150–300 ms EU↔US round trips.
- Studio rendering tech is not public (unverified).

### BandLab, Soundtrap, others

- **BandLab** Mix Editor (2017 post): built entirely on Web Audio (WaveShaper amps, Convolver cabinets and reverbs). Mobile apps reimplement Web Audio natively. Framework and rendering are unverified.
- **Soundtrap:** the studio core is in **Dart and JavaScript**, with custom effects via Emscripten/WASM in AudioWorklets (job listing). A W3C 2021 talk reports about 30 ms best-case round-trip latency and unclear `outputLatency` semantics, which supports §6.3's "engine owns MIDI and the clock". Rendering is unverified.
- **Ableton Learning Music:** Elm widgets + Tone.js.
- **GridSound:** AGPL, vanilla JS Web Components.
- **Wavacity:** Audacity compiled to WASM (wxWidgets-wasm).
- **Elementary Audio:** MIT, a declarative JS graph reconciled to a C++ engine.
- **Vital:** JUCE + OpenGL UI.

### FL Studio behaviour (Image-Line manual)

- **Windows:**
  - "Movable (with overlap), resizable, zoomable, dockable and switchable".
  - Per-window **Detached** option for multi-monitor; "Maximize to all monitors".
  - Magnetic snapping, with Alt to override.
  - *View → Arrange windows* presets and *Realign* (Shift+Ctrl+H).
  - F12 / Alt+F12 / Ctrl+F12 window closing.
  - The mixer's "Dock to left/middle/right" is per *mixer track*, not per window.
  - Any FL 2024/2025 side-panel docking feature is unverified.
- **Shortcuts:** see §6.1. F8 is the **Plugin picker**, *not* the Browser (Alt+F8). Ctrl+Z is an undo/redo **toggle**; Ctrl+Alt+Z steps back.
- **Knobs and faders:**
  - Drag up/down.
  - **Ctrl+drag** (or both mouse buttons) for fine adjust.
  - **Shift** bypasses snapping.
  - **Alt+click** resets to default; **middle-click** is a quick reset.
  - Right-click menu: Type in value, Set, Edit events, Create automation clip, Init song with this position, Link to controller.
  - Per-knob mouse-wheel behaviour isn't documented (unverified).
- **Typing keyboard to piano:** Ctrl+T. Octave via Alt+Numpad 2–6. Options for root note, octave, layout and snap-to-scale. The exact key map comes from a third-party emulator (unverified, §6.2).

---

## 12. Sources

**KryptEditor (local, read for this report):** `src/editor/{timelineStore,Timeline,Preview,Inspector,project,projectStore,peaks,thumbs,mediaStore,dndStore}.ts(x)`, `src/pages/Editor.tsx`, `src/App.tsx`, `src/components/{common,TopNav}.tsx`, `src/state/*`, `src/utils/format.ts`, `electron/{main,ipc,preload}.ts`, `electron/system/{files,settings-store,allowlist,mediaProtocol,logger}.ts`, `shared/types.ts`, `vite.config.ts`, `tsconfig.json`, `test/*`, `.github/workflows/ci.yml`. House rules: `kryptguidelines.md` §2–§6.

**Windowing / Electron**
- dockview popout groups — https://dockview.dev/docs/core/groups/popoutGroups
- dockview enterprise announcement — https://dockview.dev/blog/dockview-enterprise
- dockview duplicate-popout issue — https://github.com/mathuo/dockview/issues/851
- FlexLayout popouts — https://raw.githubusercontent.com/caplin/FlexLayout/master/docs/popout-windows.md
- FlexLayout changelog — https://raw.githubusercontent.com/caplin/FlexLayout/master/CHANGELOG.md
- golden-layout popouts — https://golden-layout.github.io/golden-layout/popouts/
- rc-dock — https://github.com/ticlo/rc-dock
- react-mosaic releases — https://github.com/nomcopter/react-mosaic/releases
- Electron `window.open` / `setWindowOpenHandler` — https://www.electronjs.org/docs/latest/api/window-open
- Electron MessagePorts — https://www.electronjs.org/docs/latest/tutorial/message-ports
- Electron utilityProcess — https://www.electronjs.org/docs/latest/api/utility-process
- Electron session permissions — https://www.electronjs.org/docs/latest/api/session
- Electron releases — https://releases.electronjs.org/releases.json
- Electron cross-origin-isolation regression and fix — https://github.com/electron/electron/issues/50242 · https://github.com/electron/electron/pull/50789
- WebGPU in Electron — https://github.com/electron/electron/issues/43567 · https://github.com/electron/electron/issues/44880
- OffscreenCanvas transfer issue — https://github.com/electron/electron/issues/47705
- `node:sqlite` fix in Electron — https://github.com/electron/electron/pull/47706 · https://nodejs.org/docs/latest-v24.x/api/sqlite.html

**Rendering / state / undo / CRDT**
- PixiJS renderers (WebGPU marked experimental) — https://pixijs.com/8.x/guides/components/renderers · https://github.com/pixijs/pixijs/releases
- Zustand transient updates and `subscribeWithSelector` — https://github.com/pmndrs/zustand
- Immer patches — https://immerjs.github.io/immer/patches · https://github.com/immerjs/immer/releases
- Mutative — https://github.com/unadlib/mutative
- zundo — https://github.com/charkour/zundo
- Yjs UndoManager — https://docs.yjs.dev/api/undo-manager
- Automerge 3 — https://automerge.org/blog/automerge-3/
- Figma multiplayer (server-authoritative, LWW per property, OT rejected) — https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- Remotion current-time / re-render guidance — https://v3.remotion.dev/docs/player/current-time
- Blink canvas size limits (32,767 px per side; 32768×8192 area) — https://chromium.googlesource.com/chromium/blink/+/HEAD/Source/core/html/HTMLCanvasElement.cpp
- Canvas vs WebGL redraw demo (weak evidence) — https://2dgraphs.netlify.com/

**Web DAWs**
- openDAW — https://github.com/andremichelle/openDAW
- openDAW SDK README — https://github.com/andremichelle/openDAW/blob/main/packages/studio/sdk/README.md
- openDAW `create-element.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/lib/jsx/src/create-element.ts
- openDAW `inject.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/lib/jsx/src/inject.ts
- openDAW `painter.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/studio/core/src/ui/canvas/painter.ts
- openDAW `PitchEditor.tsx` — https://github.com/andremichelle/openDAW/blob/main/packages/app/studio/src/ui/timeline/editors/notes/pitch/PitchEditor.tsx
- openDAW `PeaksPainter.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/lib/fusion/src/peaks/PeaksPainter.ts
- openDAW `frames.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/lib/dom/src/frames.ts
- openDAW performance notes — https://github.com/andremichelle/openDAW/blob/main/docs/performance.md
- openDAW `lib-box` README — https://github.com/andremichelle/openDAW/blob/main/packages/lib/box/README.md
- openDAW `editing.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/lib/box/src/editing.ts
- openDAW `sync-source.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/lib/box/src/sync-source.ts
- openDAW `sync-target.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/lib/box/src/sync-target.ts
- openDAW graph docs — https://github.com/andremichelle/openDAW/blob/main/docs/graph.md
- openDAW live-collab reconcile — https://github.com/andremichelle/openDAW/blob/main/docs/live-collab-deterministic-reconcile.md
- openDAW `EngineWorklet.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/studio/core/src/EngineWorklet.ts
- openDAW `MeterWorklet.ts` — https://github.com/andremichelle/openDAW/blob/main/packages/studio/core/src/MeterWorklet.ts
- openDAW live-stream README — https://github.com/andremichelle/openDAW/blob/main/packages/lib/fusion/src/live-stream/README.md
- openDAW `AudioUnitBox.ts` schema — https://github.com/andremichelle/openDAW/blob/main/packages/studio/forge-boxes/src/schema/std/AudioUnitBox.ts
- openDAW WASM engine announcement — https://buttondown.com/opendaw/archive/opendaws-audio-engine-now-powered-by-webassembly/
- Signal ARCHITECTURE.md — https://github.com/ryohey/signal/blob/main/ARCHITECTURE.md
- Signal piano-roll shaders — https://github.com/ryohey/signal/tree/main/app/src/features/piano-roll/components/canvas/shaders
- Signal `Notes.tsx` — https://github.com/ryohey/signal/blob/main/app/src/features/piano-roll/components/canvas/Notes.tsx
- Signal `useHistory.tsx` — https://github.com/ryohey/signal/blob/main/app/src/hooks/useHistory.tsx
- Signal `historyAtom.ts` — https://github.com/ryohey/signal/blob/main/app/src/hooks/historyAtom.ts
- Signal `file.ts` — https://github.com/ryohey/signal/blob/main/app/src/actions/file.ts
- webgl-react — https://github.com/ryohey/webgl-react
- Audiotool Nexus overview — https://developer.audiotool.com/js-package-documentation/documents/Overview.html
- Audiotool developer portal — https://developer.audiotool.com/
- Audiotool Nexus SDK examples — https://github.com/audiotool/nexus-sdk-examples/
- What is Audiotool — https://www.audiotool.com/LetsBuild/what-is-audiotool
- BandLab sound team post — https://blog.bandlab.com/inside-our-tech-the-sound-team/
- Soundtrap job listing — https://www.studentjob.se/lediga-jobb/785810-online-music-studio-developer-for-the-soundtrap-hub-i-stockholm
- W3C latency talk (Soundtrap) — https://www.w3.org/2021/03/media-production-workshop/talks/ulf-hammarqvist-audio-latency.html
- Ableton Learning Music — https://learningmusic.ableton.com/
- GridSound — https://github.com/gridsound/daw
- Wavacity — https://github.com/ahilss/wavacity
- Elementary Audio — https://github.com/elemaudio/elementary
- Vital — https://github.com/mtytel/vital

**Clock, meters, input**
- `getOutputTimestamp` — https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp
- `outputLatency` — https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency
- A tale of two clocks — https://web.dev/articles/audio-scheduling
- Peak programme meter ballistics — https://en.wikipedia.org/wiki/Peak_programme_meter
- Pointer Lock and `unadjustedMovement` — https://developer.mozilla.org/en-US/docs/Web/API/Element/requestPointerLock
- Windows MIDI Services rollout and known issues (Feb 2026; multi-client, WinMM compatibility, Win11 24H2/25H2 only) — https://devblogs.microsoft.com/windows-music-dev/windows-midi-services-rollout-known-issues-and-workarounds/ · https://blogs.windows.com/fr/windowsexperience/2026/02/17/making-music-with-midi-just-got-a-real-boost-in-windows-11/
- @julusian/midi — https://registry.npmjs.org/@julusian/midi
- better-sqlite3 v13 — https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0
- webaudio-controls — https://github.com/g200kg/webaudio-controls

**FL Studio (Image-Line manual)**
- Main windows — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/main_windows.htm
- Interface basics (detach, snapping, knob modifiers) — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_interface.htm
- View menu (arrange windows, F12 variants) — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/menu_view.htm
- Shortcuts — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm
- Mixer — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/mixer.htm
- Event editor — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/automation_eventeditor.htm
- Automation clips — https://www.image-line.com/support/flstudio_online_manual/html/playlist_automationclip.htm
- Controller linking — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/automation_linking.htm
- Toolbar panels (typing keyboard options) — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/toolbar_panels.htm
- Third-party typing-keyboard map (unverified) — https://github.com/tpbeldie/UFLVK-Emu

**npm registry (versions in §10)** — `https://registry.npmjs.org/<package>` for each row.
