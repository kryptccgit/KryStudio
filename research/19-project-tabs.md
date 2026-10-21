# Project tabs + panel undo (written 2026-10-14)

**User asks:**
1. "When I closed the [Channel Rack] I pressed Ctrl+Z but it didn't reopen."
2. "Multi-tab different projects at the same time, like Google [Chrome]: a + button up there to open a new tab. On program close we save state, so users can open and easily work on multiple beats at the same time."

The contract is in `shared/types.ts`: `ProjectTab`, `TabsState`, `KryptApi.tabs`, the `tabs*` channels, and the preload/mock bindings.

## Design

### ONE DocHost, swapped contents

There is a single DocHost, and every main service keeps its reference to it (MCP, agent, engine projection, session, live input, vocals, mashup …). A TabManager in main (`electron/project/tabs.ts`) keeps each INACTIVE tab's state in memory:
- project;
- DocHost history (undo/redo stacks, coalescing state);
- path, saved version / dirty, cover assets, the project service's per-project fields.

To switch tabs:
1. Export the active state.
2. Import the target's state with a new `DocHost.swap(state)`. It emits a `'reset'`-kind change (so the renderer replaces its replica and the engine reloads the project, exactly like opening a file), but it KEEPS that tab's history. Versions stay monotonic.
3. Stop the transport.

Undo is per tab and survives switching.

### Guards

Refuse a switch, with a human message and a toast, when any of these is true:
- an agent call is running, or an agent edit group is open on the active tab: "An agent is editing 'X' — wait for it or stop it in the Agents panel";
- a recording is in progress;
- a long job (Audio → Project, Auto Mashup, render) is running on it.

`ProjectTab.busy` shows why.

### New tab, open, close

- **New tab** (+, Ctrl+N, File ▸ New): a new project from the default start, or from a template. It becomes the active tab.
- **File ▸ Open, Home ▸ Projects, Recent:**
  - opens in a NEW tab, unless the active tab is an untouched new project (then it replaces it);
  - an already-open file just activates its tab.
- **Audio → Project and Auto Mashup:** their "new project" result opens in a new tab.
- **Close:** a dirty tab asks Save / Don't save / Cancel.
- **Last tab:** closing the last tab leaves a fresh Untitled tab (never zero tabs).
- **Reopen:** a closed tab is kept in `closed` (with its state, for this session), and `reopenClosed` brings it back.

### Session restore

The open tab set is saved on quit and on every tab change (atomic writes under `userData/session/`):
- `tabs.json`: order, active tab, titles and paths;
- `tab-<id>.kstudio` for every tab that is dirty or never saved. It uses the existing container encoder plus the cover assets.

On launch, every tab is restored, with the active tab activated and the others loaded lazily on first activation. A clean saved project reloads from its file; a dirty one from its snapshot, still marked dirty. Undo history is not persisted across restarts.

Crash recovery (`electron/project/recovery.ts`) keeps working for the active tab. Its snapshot/journal must not fight the session files, so make recovery per-tab or session-aware, and document which you chose.

### MCP and agents

- Agents act on the active tab. `get_project` lists the open tabs in one line.
- Add NO switch tool in v1, unless it's trivial and guarded. Agents changing what the user sees is surprising.
- The window title and Discord RPC follow the active tab.

### Renderer

**Tab strip:** a browser-like strip in the TitleBar, in place of the centred title:
- each tab has its title, a dirty dot, a busy spinner and a close ×;
- middle-click closes a tab;
- drag to reorder, and a + button;
- right-click a tab for Close, Close others, Duplicate (optional), Reveal file, Save.

Tabs shrink, then scroll, when there are many.

**Shortcuts:**
- Ctrl+N: new tab. File ▸ New is now "New tab".
- Ctrl+Tab / Ctrl+Shift+Tab: next / previous tab.
- Ctrl+1..9: go to that tab, unless taken; check `src/input/keymap.ts`.
- Ctrl+W: close the tab, if free.
- Ctrl+Shift+T: reopen the most recently closed thing, a tab or a panel.

**Per-tab view state** (selected channel / pattern, piano-roll channel, zoom, scroll): reset safely on a switch, as on open. Remember it per tab if that's easy.

**Panel undo:** the WindowManager records closed panels (id, kind, placement or floating bounds, plugin target) with a timestamp.
- **Ctrl+Z:** if the most recent of {last closed panel, last USER doc edit in this tab} is the panel close, reopen that panel where it was. Otherwise, do the normal doc undo.
- **Ctrl+Shift+Z / Ctrl+Y:** don't redo panel closes. Keep it simple.
- **Show it:** a status-bar hint "Reopened Channel Rack (Ctrl+Z)".

## Agents

| Agent | Owns |
|---|---|
| tabs-core | `electron/project/tabs.ts` (+ tests). `DocHost.swap` / export / import (+ `test/dochost.test.ts` cases). Project-service integration (per-tab path, dirty, autosave, recovery, covers). Session files + restore. The guards. IPC `tabs*` + `EVENT.tabsState`. The Audio → Project new-tab path. The `get_project` tabs line. Window title. `test/tabs*.test.ts`. |
| tabs-ui | The TitleBar tab strip (`src/app/tabs/**`), shortcuts + File menu + Home "open" paths using `window.krypt.tabs`, the unsaved-changes dialog, the panel-close undo in `src/workspace/WindowManager.ts` + the `edit.undo` routing, the Guides updates (Basics / shortcuts: tabs, Ctrl+Z reopens panels), `test/tabs-ui.test.ts`. |

**Rules:** the same as `research/17-wave-12-2b.md` §4.

**Running alongside:** the Auto Mashup agents (mashup-core in `electron/mashup`, `electron/ipc.ts`; mashup-ui in `src/mashup`, the Home Audio Tools screen, the Tools menu, the playlist menu). Keep edits to the shared files small and re-read before editing. The lead wires the mashup "new project → new tab" path at integration.
