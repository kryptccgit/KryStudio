// ──────────────────────────────────────────────────────────────────────
// The tours (research/22 §1, and "Master a song" from research/23 §3). Written for someone who has never
// opened a music app: one action per step, plain words, every term
// explained the first time. Pure data + predicates (test/tours.test.ts).
// ──────────────────────────────────────────────────────────────────────

import type { SingletonKind } from '../workspace/panels';
import type { AiChoice, Tour, TourCtx, TourId, TourSnapshot, TourStep } from './types';
import { AGENT_PROVIDERS } from '@shared/agent/providers';

const vis = (s: TourSnapshot, k: string): boolean => s.visible.includes(k);
const panelSel = (k: SingletonKind) => (): string => `[data-tour-panel="${k}"]`;

// ── 1. Start here: your first beat ────────────────────────────────────

const firstBeat: Tour = {
  id: 'first-beat',
  title: 'Start here: your first beat',
  blurb: 'Make a drum beat, play it, change the speed and save it. Click by click.',
  minutes: 4,
  steps: [
    {
      id: 'new-project',
      anchor: { guide: 'titlebar.newTab', chrome: true },
      do: 'key',
      keys: 'Ctrl+N',
      command: 'file.new',
      title: 'Start a new project',
      text: 'A **project** is one song, saved as one file. Press [[Ctrl+N]] on your keyboard, or click the **+** up here.',
      done: (s, b) => s.projectId !== b.projectId || s.tabCount > b.tabCount,
      act: { kind: 'command', id: 'file.new' },
      actLabel: 'Make one for me',
      recover: { message: 'Press Ctrl+N, or use File ▸ New tab.', label: 'Make a new project', action: { kind: 'command', id: 'file.new' } },
    },
    {
      id: 'channel-rack',
      anchor: { selector: panelSel('channelRack'), guide: 'channelRack.steps', panel: 'channelRack' },
      do: 'read',
      onEnter: { kind: 'open', panel: 'channelRack' },
      title: 'This is the Channel Rack',
      text: 'Each **row** is one sound: Kick, Clap, Hat… The little **boxes** are steps (moments in time, left to right): a lit box plays its sound.',
      notes: ['Closed it by accident? Press [[F6]] to open it again.'],
    },
    {
      id: 'kick',
      anchor: { selector: (s) => (s.kick ? `[data-tour-steps="${s.kick.id}"]` : null), guide: 'channelRack.steps', panel: 'channelRack' },
      do: 'click',
      title: 'Click 4 boxes on the Kick row',
      text: 'The **Kick** is the deep "boom" of a beat. Click **4 boxes** on its row: try boxes **1, 5, 9 and 13** (one on every beat).',
      progress: (s) => (s.kick ? `${s.kick.name}: ${Math.min(s.kick.steps, 4)} of 4 boxes lit` : null),
      done: (s) => !!s.kick && s.kick.steps >= 4,
      act: { kind: 'steps', row: 'kick', steps: [0, 4, 8, 12] },
      recover: (s) =>
        s.kick ? null : { message: 'This project has no sounds in the Channel Rack yet. A new project comes with a drum kit.', label: 'Start a new project', action: { kind: 'command', id: 'file.new' } },
    },
    {
      id: 'play',
      anchor: { guide: 'transport.play' },
      do: 'key',
      keys: 'Space',
      command: 'transport.togglePlay',
      title: 'Listen: press Space',
      text: 'Press [[Space]] (the long bar on your keyboard) to play your beat. It loops round and round.',
      done: (s) => s.playing,
      act: { kind: 'command', id: 'transport.play' },
      actLabel: 'Play it for me',
    },
    {
      id: 'stop',
      anchor: { guide: 'transport.play' },
      do: 'key',
      keys: 'Space',
      command: 'transport.togglePlay',
      title: 'Stop: press Space again',
      text: 'Press [[Space]] again to stop. Space always starts and stops the music.',
      done: (s) => !s.playing,
      act: { kind: 'command', id: 'transport.stop' },
      actLabel: 'Stop it for me',
    },
    {
      id: 'clap',
      anchor: { selector: (s) => (s.clap ? `[data-tour-steps="${s.clap.id}"]` : null), guide: 'channelRack.steps', panel: 'channelRack' },
      do: 'click',
      title: 'Add a clap',
      text: 'Now click **2 boxes** on the **Clap** row: boxes **5 and 13** sound great. Want more? Light every other box on the **Hat** row too.',
      progress: (s, b) => (s.clap ? `${s.clap.name}: ${Math.min(Math.max(0, s.clap.steps - (b.clap?.steps ?? 0)), 2)} of 2 new boxes` : null),
      done: (s, b) => !!s.clap && s.clap.steps >= Math.min(16, (b.clap?.steps ?? 0) + 2),
      act: { kind: 'steps', row: 'clap', steps: [4, 12] },
    },
    {
      id: 'tempo',
      anchor: { guide: 'transport.tempo' },
      do: 'click',
      title: 'Change the speed (tempo)',
      text: 'The **tempo** is how fast the music goes, in beats per minute (**BPM**). Drag this number up or down, or double-click it and type one, like 120.',
      progress: (s) => `Tempo now: ${Math.round(s.bpm * 100) / 100} BPM`,
      done: (s, b) => s.bpm !== b.bpm,
      act: { kind: 'tempo' },
      actLabel: 'Change it for me',
    },
    {
      id: 'save',
      anchor: { guide: 'titlebar.file', chrome: true },
      do: 'key',
      keys: 'Ctrl+S',
      command: 'file.save',
      title: 'Save your beat',
      text: 'Press [[Ctrl+S]]. In the window that opens, type a name, pick a folder and click **Save**.',
      done: (s, b) => !!s.savedPath && !s.dirty && (s.savedPath !== b.savedPath || b.dirty),
      act: { kind: 'command', id: 'file.save' },
      actLabel: 'Open the save window',
    },
    {
      id: 'next',
      do: 'read',
      title: 'You made your first beat!',
      text: "That's the heart of it: sounds in rows, steps in a loop. Next, turn your beat into a whole song, or learn where every window lives.",
      next: ['song', 'windows'],
    },
  ],
};

// ── 2. Find your way: windows and shortcuts ───────────────────────────

const WINDOWS: Array<{ kind: SingletonKind; key: string; name: string; what: string }> = [
  { kind: 'channelRack', key: 'F6', name: 'Channel Rack', what: 'Your sounds, one row each, with the step boxes for beats.' },
  { kind: 'pianoRoll', key: 'F7', name: 'Piano Roll', what: 'Melodies and chords: notes drawn on a sideways piano. It edits the sound you picked in the Channel Rack.' },
  { kind: 'playlist', key: 'F5', name: 'Playlist', what: 'Your whole song from left to right: you place your patterns (your beat loops) here.' },
  { kind: 'mixer', key: 'F9', name: 'Mixer', what: 'Volume, left / right and effects for every sound, like a mixing desk.' },
  { kind: 'browser', key: 'Alt+F8', name: 'Browser', what: 'Sounds and presets (ready-made instrument settings). Drag one onto the Channel Rack to use it.' },
  { kind: 'session', key: 'F3', name: 'Session', what: 'Launch loops live, scene by scene. You can ignore it at first.' },
];

function windowSteps(w: (typeof WINDOWS)[number]): TourStep[] {
  return [
    {
      id: `open-${w.kind}`,
      do: 'key',
      keys: w.key,
      command: `view.toggle.${w.kind}`,
      title: `Press ${w.key}: the ${w.name}`,
      text: `Press [[${w.key}]] on your keyboard. The same key opens and closes it, so if it vanishes, press it again.`,
      done: (s, b) => vis(s, w.kind) && (!vis(b, w.kind) || s.keys.includes(w.key) || s.assisted),
      act: { kind: 'open', panel: w.kind },
      actLabel: 'Open it for me',
    },
    {
      id: `close-${w.kind}`,
      anchor: { selector: panelSel(w.kind), panel: w.kind },
      do: 'key',
      keys: w.key,
      command: `view.toggle.${w.kind}`,
      title: `This is the ${w.name}`,
      text: `${w.what} Press [[${w.key}]] again to close it.`,
      done: (s) => !s.open.includes(w.kind),
      act: { kind: 'close', panel: w.kind },
      actLabel: 'Close it for me',
    },
  ];
}

const windows: Tour = {
  id: 'windows',
  title: 'Find your way: windows and shortcuts',
  blurb: 'Every window, the key that opens it, and how to get a lost window back.',
  minutes: 3,
  steps: [
    {
      id: 'intro',
      do: 'read',
      onEnter: { kind: 'leaveHome' },
      title: 'Every window has a key',
      text: 'Krypt Studio is made of **windows**: one for beats, one for notes, one for the song… Each one opens and closes with a single key. Let\'s try them.',
    },
    ...WINDOWS.flatMap(windowSteps),
    {
      id: 'open-guides',
      do: 'key',
      keys: 'F1',
      command: 'help.guides',
      title: 'Press F1: the Guides',
      text: 'Press [[F1]] any time you are stuck. The Guides explain every part of the app in plain words.',
      done: (s) => vis(s, 'guides'),
      act: { kind: 'command', id: 'help.guides' },
      actLabel: 'Open it for me',
    },
    {
      id: 'close-guides',
      anchor: { selector: () => '[data-tour-tab="guides"]', panel: 'guides' },
      do: 'click',
      title: 'Close a window with its ×',
      text: 'Every window has a little **×** on its tab, up here. Click it to close the Guides.',
      done: (s) => !s.open.includes('guides'),
      act: { kind: 'close', panel: 'guides' },
      actLabel: 'Close it for me',
    },
    {
      id: 'lost',
      do: 'key',
      keys: 'Ctrl+Z',
      command: 'edit.undo',
      title: 'Lost a window? Press Ctrl+Z',
      text: 'Press [[Ctrl+Z]]: the window you just closed comes back. (Ctrl+Z also takes back your last change.)',
      done: (s, b) => s.open.length > b.open.length,
      act: { kind: 'command', id: 'edit.undo' },
      actLabel: 'Bring it back for me',
    },
    {
      id: 'home',
      anchor: { guide: 'titlebar.home', chrome: true },
      do: 'key',
      keys: 'Ctrl+Shift+H',
      command: 'view.home',
      title: 'Home: the start screen',
      text: 'Press [[Ctrl+Shift+H]], or click the little **house** up here. Home has your projects, AI, guides and settings.',
      done: (s) => s.homeOpen,
      act: { kind: 'command', id: 'view.home' },
      actLabel: 'Show Home for me',
      keepEsc: true,
    },
    {
      id: 'leave-home',
      anchor: { guide: 'titlebar.home', chrome: true },
      do: 'key',
      keys: 'Esc',
      title: 'Back to the Studio',
      text: 'Press [[Esc]], or click the **house** again. Home covers the Studio; nothing underneath is lost.',
      done: (s) => !s.homeOpen,
      act: { kind: 'leaveHome' },
      actLabel: 'Take me back',
      keepEsc: true,
    },
    {
      id: 'reset',
      anchor: { guide: 'titlebar.view', chrome: true },
      do: 'click',
      title: 'Everything back in its place',
      text: 'Click **View**, then **Reset layout** at the bottom. It puts every window back where it started.',
      done: (s) => ['playlist', 'browser', 'mixer', 'channelRack'].every((k) => s.open.includes(k)),
      act: { kind: 'resetLayout' },
      actLabel: 'Reset it for me',
    },
    {
      id: 'end',
      do: 'read',
      title: 'You know your way around',
      text: '[[F5]] Playlist · [[F6]] Channel Rack · [[F7]] Piano Roll · [[F9]] Mixer · [[Alt+F8]] Browser · [[F1]] Guides. The **View** menu lists every window too.',
      next: ['first-beat', 'song'],
    },
  ],
};

// ── 3. Make a song from your beat ─────────────────────────────────────

const song: Tour = {
  id: 'song',
  title: 'Make a song from your beat',
  blurb: 'Put your beat on the Playlist, play the whole song and export it as a WAV file.',
  minutes: 3,
  steps: [
    {
      id: 'mode',
      anchor: { guide: 'transport.mode' },
      do: 'click',
      keys: 'L',
      command: 'transport.toggleMode',
      title: 'Switch to Song mode',
      text: '**Pattern** mode loops one beat. **Song** mode plays your whole song. Click **Song** up here, or press [[L]].',
      notes: ['No beat yet? Take "Start here: your first beat" first.'],
      done: (s) => s.mode === 'song',
      act: { kind: 'mode', mode: 'song' },
      actLabel: 'Switch it for me',
    },
    {
      id: 'playlist',
      anchor: { selector: panelSel('playlist'), guide: 'playlist.tracks', panel: 'playlist' },
      do: 'read',
      onEnter: { kind: 'open', panel: 'playlist' },
      title: 'This is the Playlist',
      text: 'Your song, from left to right. Each lane is a **track**; each block on it plays a **pattern** (the beat loop you made).',
    },
    {
      id: 'paint',
      anchor: { guide: 'playlist.grid', panel: 'playlist' },
      do: 'click',
      title: 'Place your beat',
      text: 'Click once in the **first lane**, at the very left. Your beat appears there as a block.',
      progress: (s) => `Blocks on the Playlist: ${s.patternClips}`,
      done: (s, b) => s.patternClips >= Math.max(1, b.patternClips + 1),
      act: { kind: 'clips', count: 4 },
      actLabel: 'Place 4 for me',
    },
    {
      id: 'play-song',
      anchor: { guide: 'transport.play' },
      do: 'key',
      keys: 'Space',
      command: 'transport.togglePlay',
      title: 'Play your song',
      text: 'Press [[Space]]. A line moves across the Playlist as the song plays. Click more blocks to make it longer.',
      done: (s) => s.playing,
      act: { kind: 'command', id: 'transport.play' },
      actLabel: 'Play it for me',
    },
    {
      id: 'stop-song',
      anchor: { guide: 'transport.play' },
      do: 'key',
      keys: 'Space',
      command: 'transport.togglePlay',
      title: 'Stop',
      text: 'Press [[Space]] again to stop.',
      done: (s) => !s.playing,
      act: { kind: 'command', id: 'transport.stop' },
      actLabel: 'Stop it for me',
    },
    {
      id: 'export',
      anchor: { guide: 'titlebar.file', chrome: true },
      do: 'key',
      keys: 'Ctrl+R',
      command: 'file.exportWav',
      title: 'Export: a file to share',
      text: 'Press [[Ctrl+R]] (or **File ▸ Export audio…**). It turns your song into a WAV file anyone can play.',
      done: (s) => s.exportOpen,
      act: { kind: 'command', id: 'file.exportWav' },
      actLabel: 'Open it for me',
    },
    {
      id: 'export-go',
      do: 'read',
      place: 'corner',
      title: 'Click Export',
      text: 'The usual settings are fine. Click **Export**, then pick a name and a folder. A message tells you when the file is ready.',
      next: ['ai'],
    },
  ],
};

// ── 4. Set up AI ──────────────────────────────────────────────────────

export const AI_APPS: Record<Exclude<AiChoice, 'api-key'>, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
};

const isClient = (c: TourCtx): boolean => !!c.choice && c.choice !== 'api-key';
const isKey = (c: TourCtx): boolean => c.choice === 'api-key';
const app = (c: TourCtx): string => (c.choice && c.choice !== 'api-key' ? AI_APPS[c.choice] : 'your AI app');

export const CONSOLE_URL = 'https://console.anthropic.com/';
export const FIRST_REQUEST = 'Make a lo-fi beat at 85 BPM in Krypt Studio';

const ai: Tour = {
  id: 'ai',
  title: 'Set up AI',
  blurb: 'Connect Claude Code, Claude Desktop, Cursor or VS Code, or chat right here with an API key.',
  minutes: 3,
  steps: [
    {
      id: 'choose',
      do: 'choose',
      title: 'Set up AI: pick one',
      text: 'An AI can build beats, songs and mixes while you watch, and every change can be undone. Which one do you want to use?',
      choices: [
        { id: 'claude-code', label: 'Claude Code', detail: 'Claude in your terminal. Uses your Claude plan.' },
        { id: 'claude-desktop', label: 'Claude Desktop', detail: 'The Claude app for Windows. Uses your Claude plan.' },
        { id: 'cursor', label: 'Cursor', detail: 'The code editor with AI built in.' },
        { id: 'vscode', label: 'VS Code', detail: 'With GitHub Copilot or another AI that can use tools (MCP).' },
        { id: 'api-key', label: 'Chat right here (API key)', detail: 'The chat inside Krypt Studio. Needs an API key from Anthropic, OpenAI or OpenRouter: you pay per use.' },
      ],
      notes: [
        '**Claude Code** and **Claude Desktop** use your Claude plan: nothing extra to pay here.',
        'An **API key** is pay-as-you-go: every message costs a little money, billed by Anthropic.',
      ],
    },

    // (a) / (b): an MCP client
    {
      id: 'agents-open',
      when: isClient,
      anchor: { guide: 'transport.agent' },
      do: 'click',
      title: 'Open the Agents panel',
      text: 'Click the **AI** button up here. It opens **Agents**: the place where AI apps connect to Krypt Studio.',
      done: (s) => vis(s, 'agent'),
      act: { kind: 'open', panel: 'agent' },
      actLabel: 'Open it for me',
    },
    {
      id: 'connect-tab',
      when: isClient,
      anchor: { guide: 'agent.connect' },
      do: 'click',
      title: 'Click Connect',
      text: 'Click the **Connect** tab. It lists the AI apps Krypt Studio can set up for you.',
      done: (s) => vis(s, 'agent') && s.agentTab === 'connect',
      act: { kind: 'agentTab', tab: 'connect' },
      actLabel: 'Show it for me',
    },
    {
      id: 'install',
      when: isClient,
      anchor: { selector: (_s, c) => (c.choice ? `[data-tour-client="${c.choice}"]` : null), panel: 'agent' },
      do: 'click',
      title: (c) => `Click Install next to ${app(c)}`,
      text: (c) =>
        c.choice === 'claude-code'
          ? 'Find **Claude Code** in the list and click **Install**. It runs one setup command for you (Claude Code must already be installed).'
          : `Find **${app(c)}** in the list and click **Install**. Krypt Studio adds itself to ${app(c)}'s settings and keeps a backup.`,
      notes: [(c) => `No Install button? Click **Copy** and paste it into ${app(c)}'s MCP settings (the Guides explain how).`],
      done: (s, b, c) => (!!c.choice && s.installedClients.includes(c.choice)) || s.mcpClientIds.some((id) => !b.mcpClientIds.includes(id)),
      act: { kind: 'installClient' },
      actLabel: 'Install it for me',
      recover: (s, c) => (vis(s, 'agent') ? { message: `${app(c)} is listed on the Connect tab.`, label: 'Show the Connect tab', action: { kind: 'agentTab', tab: 'connect' } } : null),
    },
    {
      id: 'restart',
      when: isClient,
      do: 'read',
      title: (c) => (c.choice === 'claude-code' ? 'Start a new Claude Code session' : `Restart ${app(c)}`),
      text: (c) =>
        c.choice === 'claude-code'
          ? 'Open a terminal and type `claude`, or start a **new** session if one is open. Claude Code connects to Krypt Studio when a session starts.'
          : `Close **${app(c)}** completely (also from its icon near the clock), then open it again. It only reads its settings when it starts.`,
      notes: ['Keep Krypt Studio open: the AI talks to it while it runs.'],
    },
    {
      id: 'ask',
      when: isClient,
      anchor: { guide: 'agent.status', panel: 'agent' },
      do: 'type',
      title: (c) => `Ask ${app(c)} for a beat`,
      text: (c) => `In ${app(c)}, type \`${FIRST_REQUEST}\` and press [[Enter]]. When it connects, its name shows up here.`,
      notes: [(c) => (c.choice === 'claude-desktop' ? 'Claude Desktop may ask before it uses Krypt Studio: click **Allow**.' : 'It may ask before it uses Krypt Studio: say yes.')],
      progress: (s) => (s.mcpClientNames.length ? `Connected: ${s.mcpClientNames.join(', ')}` : 'Waiting for it to connect…'),
      done: (s, b) => s.mcpClientIds.some((id) => !b.mcpClientIds.includes(id)),
    },

    // (c): the built-in chat with an API key
    {
      id: 'get-key',
      when: isKey,
      do: 'read',
      title: 'Get an API key',
      text: 'Pick a company and open its key page: **Anthropic** (Claude), **OpenAI** (ChatGPT) or **OpenRouter** (many AIs with one key). Sign in, create a key and copy it.',
      links: [
        { label: 'Anthropic: console.anthropic.com', url: CONSOLE_URL },
        { label: 'OpenAI: platform.openai.com', url: AGENT_PROVIDERS.openai.keyUrl },
        { label: 'OpenRouter: openrouter.ai', url: AGENT_PROVIDERS.openrouter.keyUrl },
      ],
      notes: [
        'It costs money per use: you add credit on that site, and each message uses a little of it. You can set a monthly limit there.',
        'A ChatGPT or Claude subscription is not an API key.',
        'Your key is stored encrypted on this PC and only sent to the company it is from.',
      ],
    },
    {
      id: 'agents-chat',
      when: isKey,
      anchor: { guide: 'transport.agent' },
      do: 'click',
      title: 'Open the AI chat',
      text: 'Click the **AI** button up here, then the **Chat** tab.',
      done: (s) => vis(s, 'agent') && s.agentTab === 'chat',
      act: { kind: 'agentTab', tab: 'chat' },
      actLabel: 'Open it for me',
    },
    {
      id: 'paste-key',
      when: isKey,
      anchor: { guide: 'agent.apiKey', panel: 'agent' },
      do: 'type',
      title: 'Paste your key, then click Save',
      text: 'Click the company your key is from (**Anthropic**, **OpenAI** or **OpenRouter**), then click the box, press [[Ctrl+V]] to paste your key and click **Save**.',
      done: (s) => s.hasApiKey,
      recover: (s) => (vis(s, 'agent') && !s.hasApiKey ? { message: 'The key box is on the Chat tab.', label: 'Show the Chat tab', action: { kind: 'agentTab', tab: 'chat' } } : null),
    },
    {
      id: 'first-message',
      when: isKey,
      anchor: { guide: 'agent.chat', panel: 'agent' },
      do: 'type',
      title: 'Ask for a beat',
      text: 'Type what you want, like `Make a chill lo-fi beat at 85 BPM`, and press [[Enter]]. Watch the Studio: it builds it right there.',
      done: (s, b) => s.chatSent > b.chatSent,
      recover: (s) => (vis(s, 'agent') ? { message: 'The chat is on the Chat tab.', label: 'Show the Chat tab', action: { kind: 'agentTab', tab: 'chat' } } : null),
    },

    {
      id: 'safety',
      when: (c) => !!c.choice,
      do: 'read',
      title: "You're set up",
      text: 'Every AI change is marked with its name: **History ▸ Revert AI edits** takes back everything it did. The **Kill switch** at the top of Agents disconnects every AI at once.',
    },
  ],
};

// ── 5. Master a song ──────────────────────────────────────────────────
// Home ▸ Audio Tools ▸ Master a song… opens a dialog with numbered steps: the tour points at them
// (data-guide automix.song / automix.run / automix.ab) so the card sits above or below, never over the button to click.
// Choosing the song (step ①) never starts anything; Master my song does.

/** The result's default button: Keep (next step 2) while the result is undecided, then Export… (step 3) (src/automix/AutoMixDialog.tsx). */
export const MASTER_DEFAULT_BUTTON = '[role="dialog"][aria-label="Master a song"] [data-autofocus]';

const master: Tour = {
  id: 'master',
  title: 'Master a song',
  blurb: 'Make a finished song sound polished and loud enough to share: choose it, pick a style, compare before and after, export.',
  minutes: 3,
  steps: [
    {
      id: 'home',
      anchor: { guide: 'titlebar.home', chrome: true },
      do: 'key',
      keys: 'Ctrl+Shift+H',
      command: 'view.home',
      title: 'Go to Home',
      text: 'Press [[Ctrl+Shift+H]], or click the little **house** up here. Mastering starts on the Home screen.',
      notes: ['Have your finished song ready as a file: WAV, MP3, M4A or FLAC.'],
      done: (s) => s.homeOpen,
      act: { kind: 'showHome' },
      actLabel: 'Show Home for me',
      keepEsc: true,
    },
    {
      id: 'tools',
      anchor: { guide: 'home.audioTools', chrome: true },
      do: 'click',
      title: 'Open Audio Tools',
      text: 'Click the **Audio Tools** card. Mastering lives there, with the other tools for finished audio.',
      done: (s) => s.master.open || (s.homeOpen && s.homeScreen === 'audio'),
      act: { kind: 'showHome', screen: 'audio' },
      actLabel: 'Open it for me',
      recover: { message: 'The **Audio Tools** card is on the main Home screen.', label: 'Show the Home screen', action: { kind: 'showHome' } },
      keepEsc: true,
    },
    {
      id: 'open',
      anchor: { guide: 'home.masterSong', chrome: true },
      do: 'click',
      title: 'Click Master a song…',
      text: 'On the **Master a song** card, click **Master a song…**. A window opens where you choose the sound.',
      done: (s) => s.master.open,
      act: { kind: 'masterSong' },
      actLabel: 'Open it for me',
      recover: { message: 'The **Master a song** card is on Home ▸ **Audio Tools**.', label: 'Show Audio Tools', action: { kind: 'showHome', screen: 'audio' } },
      keepEsc: true,
    },
    {
      id: 'song',
      anchor: { guide: 'automix.song' },
      do: 'click',
      title: 'Choose your song',
      text: 'Click **Choose your song…**. In the window that opens, click your song, then **Open**. Nothing is mastered yet.',
      notes: ['Or drag the file from Windows Explorer onto this step.'],
      done: (s) => s.master.songPicked,
    },
    {
      id: 'style',
      anchor: { guide: 'automix.run' },
      do: 'read',
      title: 'Pick a style',
      text: 'Under **Pick a style**, click the card that fits your song, like **Streaming Clean** or **Loud Trap / Drill**. Not sure? Leave **Auto**: Krypt listens and picks.',
      notes: [
        'The number on each card is its loudness in **LUFS** (a loudness number): closer to 0 is louder.',
        'Want it to sound like a song you love? Open **Sound like a song you love (optional)** and click **Pick a reference song…**.',
      ],
    },
    {
      id: 'run',
      anchor: { guide: 'automix.run' },
      do: 'click',
      title: 'Click Master my song',
      text: 'Click **Master my song** (bottom-right). If it is greyed out, the line next to it says what is missing.',
      done: (s) => s.master.phase !== 'idle',
    },
    {
      id: 'wait',
      do: 'wait',
      place: 'corner',
      title: 'Mastering…',
      text: 'The window ticks off each step: measuring, tone EQ, glue, width, loudness, checking. It takes a few seconds, in a new tab, so your project and your file stay safe.',
      progress: (s) =>
        s.master.phase === 'running'
          ? 'Working on it…'
          : s.master.phase === 'idle'
            ? "It hasn't started. Click Back, then Master my song."
            : s.master.phase === 'failed'
              ? "It didn't finish: the window says why. Click Back to try again."
              : s.master.phase === 'cancelled'
                ? 'Cancelled. Click Back to try again.'
                : null,
      done: (s) => s.master.phase === 'done',
    },
    {
      id: 'compare',
      anchor: { guide: 'automix.ab' },
      do: 'click',
      title: 'Compare Before and After',
      text: "Under **What to do next**, press **Play**, then click **Before** and **After** to hear the difference. After is usually louder: turn your speakers down a little so loudness doesn't fool you.",
      done: (s, b) => s.master.ab !== b.master.ab,
    },
    {
      id: 'keep',
      anchor: { selector: () => MASTER_DEFAULT_BUTTON, guide: 'automix.ab' },
      do: 'click',
      title: 'Keep it',
      text: 'Like it? Click **Keep** (step 2). Not sure? **Undo** switches it off, and **Master another** (bottom-left) tries a different style.',
      done: (s) => s.master.verdict !== 'open',
    },
    {
      id: 'export',
      anchor: { selector: () => MASTER_DEFAULT_BUTTON, guide: 'automix.ab' },
      do: 'click',
      title: 'Export your master',
      text: 'Click **Export…** (step 3). The **Export audio** window opens, set up for the whole song.',
      done: (s) => s.exportOpen,
    },
    {
      id: 'export-go',
      do: 'read',
      place: 'corner',
      title: 'Click Export',
      text: 'Pick **24-bit** (a WAV) or **MP3** next to **Format**, click **Export…**, then choose a name and a folder. Your mastered song is ready to share.',
      notes: ['Several songs for one record? **Master an album…** on the same Home card keeps them sounding like one album.'],
    },
  ],
};

export const TOURS: Record<TourId, Tour> = { 'first-beat': firstBeat, windows, song, ai, master };
export const TOUR_ORDER: TourId[] = ['first-beat', 'windows', 'song', 'ai', 'master'];

export function tourById(id: string): Tour | undefined {
  return (TOURS as Record<string, Tour>)[id];
}
