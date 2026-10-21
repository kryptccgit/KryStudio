import type { GuideArticle } from '../articles';

export const AI: GuideArticle[] = [
  {
    id: 'ai-results',
    title: 'Getting great results from the AI',
    summary: 'Prompts that work, small steps, building from a reference song, closeness and mix matching, style focus, originality checks, and undoing what an agent did.',
    group: 'AI and audio',
    icon: 'sparkles',
    body: `
An agent in Krypt Studio works like a fast producer sitting next to you. It builds what you ask for in the open project, you hear it, and you steer. This guide is about steering well. To connect an agent first, see [[guide:ai-agents|AI agents]].

[[action:agentPanel|Open the agent chat]] [[action:agents|Connect an agent]]

## One prompt, a finished song

When you ask for a song or a beat, the agent builds the whole thing before it answers: sounds for every part, patterns for every section, the arrangement, transitions at each section change, the mix, and a check of the result. It doesn't stop to ask questions along the way. It picks whatever you left open, and every edit can be undone.

Your **next** prompt edits that song. Ask for "just a loop" or "one pattern" and you get only that.

## What a good first prompt has

You don't need special words, but the more of these you give, the closer the first version lands:

| Give it | Example |
|---|---|
| A genre or a feel | "trap", "lo-fi", "melodic house", "dark and sparse" |
| Tempo and key (optional) | "at 145 in F minor" |
| The standout sound | "a bell melody", "sliding 808s", "a big supersaw lead" |
| The shape | "about 2 minutes", "with a breakdown before the last drop" |
| A reference (optional) | a song file you drop in: see below |

Prompts that work well:

- "Make a dark trap beat at 145 in F minor with a bell melody and sliding 808s, about 2 minutes."
- "A warm lo-fi beat at 80 BPM: dusty drums, soft electric piano chords, vinyl crackle."
- "An afrobeats groove at 105 with bouncy percussion, a warm bass and a short marimba hook."
- "Just a 4-bar house drum loop." (only that, no song)

## Change one thing at a time

After the first version, small requests beat big ones. Name the part, the section or the bars, and describe the feel in plain words:

- "The hats are too busy in the verses: half as many, more swing."
- "Make the drop at bar 33 hit harder."
- "Swap the lead for a pluck."
- "Darker chords in the hook."
- "Add a riser and a crash into every hook."
- "The kick and the 808 fight. Fix the low end."

If a change misses, say what's wrong with it ("too bright", "the melody wanders") rather than starting over. Every request is one entry in History, so you can always step back.

## Use the agent's ears

Agents can't hear the way you do, but they can render the song and read the numbers. Ask them to:

- "Review the song": the agent renders it and scores it from 0 to 100, with the top issues (loudness, low end, sections that repeat too long, missing transitions) and the fix for each.
- "Check the mix and fix the top two problems."
- "Compare my mix with the reference": loudness, low end, highs and width side by side.
- "How close is it to the reference?": the review's closeness score, and the dimension to fix first.
- "Match the mix to the reference": part levels, tone, width and loudness, set in a few rounds.

Then listen yourself. A good score means the song is technically sound; only you can say whether it's good. More in [[guide:ai-limits|What the AI can and can't do]].

## Make something like a song you love

Give the agent a song file and say "make something like this": drop it into Claude Code, onto the agent chat's message box, or onto Home and pick **Use as a reference for the AI**. The agent then works through a fixed path:

1. **Study it** (\`study_reference\`): tempo, key, swing, sections, drum feel, chords and mix, read on your PC. The song lands on a muted **Reference** track: unmute it to compare.
2. **Build the bed in one step** (\`build_from_reference\`): drums with the reference's rhythm and accents, its chord progression, a bass on its rhythm (the notes follow the chords), the arrangement with markers and transitions, the closest matching sounds, the bus and master effects, and the level of each part. It is one undo step.
3. **Write an original melody** on an empty **Lead** channel: the reference melody's range, density and phrase lengths, never its notes.
4. **Check originality** (\`check_originality\`): the new melody against the reference's own melody, and against your library.
5. **Match the mix** (\`match_mix\`): it renders, compares the level of each part and the master's tone, width and loudness with the reference, and sets them, for up to three rounds.
6. **Review the song** (\`review_song\`): with a reference, the review adds a **closeness** score from 0 to 100, split into tempo, key, groove, harmony, arrangement, sounds and mix, each with the measured value and a fix.

While a reference is studied, the tempo is locked to it: an agent can't set a tempo more than 3% off the reference's reading (or half or double it) unless you ask for that tempo.

| It follows closely | It never copies |
|---|---|
| Tempo, key and swing | The melody and the hook |
| The drum programming | The lyrics |
| The chord progression | The exact bassline |
| The bass rhythm | The audio: its stems are never used as samples |
| Sections, energy, transitions, the sounds and the mix balance | |

Your own song is different: tell the agent it's yours and it may keep its exact bass and melody. Songs in your Reference Library count as yours. The steps for each app are in [[guide:ai-agents#make-a-song-like-this-one|AI agents]].

> Want an editable copy of the song itself, every part written out? That's [[guide:audio-to-project|Turn a song into a project]].

!> Use songs you own or have the rights to. The agent never copies the melody, lyrics or hook, but a song that ends up too close to a record can still infringe it.

## Teach it your style

Import songs you made or love into the **Reference Library**, and set a collection as the **AI focus** (Tools ▸ AI focus). Agents then compose in that collection's style: its tempos, swing, keys, drum patterns, chords and structure. Add a short brief like "dark, sparse, lots of space" to steer it further. See [[guide:reference-library|Reference library & focus]].

[[show:titlebar.tools|Show me the Tools menu]]

## Keep it original

- **Tools ▸ Check originality…** compares your melodies with the deep-analysed songs in your library, and flags runs of 8 or more matching notes, even transposed.
- Ask the agent to "check originality", and it runs the same check. With a reference studied, it also compares your melodies with the reference's own melody.
- With a style focus on, every agent edit is checked against your references when it finishes, and close matches come back as a warning.

The check is a production aid, not legal advice. Drums and chord progressions are never flagged, because everybody uses them.

[[action:checkOriginality|Check originality now]]

## Undo what the agent did

- Each request is one named entry in **Edit ▸ History…**, tagged with the agent's name. **Revert** undoes one entry.
- **Revert all AI edits** undoes everything that agent did and keeps your own edits [[show:history.revertAgent|Show me]]
- You can also just say "undo that" or "revert everything you did".
- [[Ctrl+Z]] only undoes **your** edits, never an agent's.
- The **Kill switch** in the Agents panel disconnects every agent at once.

## Ready-made prompts

Claude Code shows Krypt Studio's prompts as slash commands:

| Command | What it does |
|---|---|
| \`/krypt-studio:beat\` | A finished song from a genre, tempo, key, mood or idea |
| \`/krypt-studio:like\` | A song like the one whose path you give |
| \`/krypt-studio:mixcheck\` | A mix pass driven by the song check |
| \`/krypt-studio:arrange\` | Your patterns arranged into sections, with transitions |
| \`/krypt-studio:focus\` | A song in your library style focus |
| \`/krypt-studio:mashup\` | One song's vocal on another's beat |

## Keep what you like

- "Save this lead as a preset called Night Bell": the agent saves it as your own preset, ready for every project.
- Agents can't save your project. Press [[Ctrl+S]] when you like where it's going.
`,
  },
  {
    id: 'ai-limits',
    title: "What the AI can and can't do",
    summary: 'An honest list: what agents can change, how they "listen", and what only you can do.',
    group: 'AI and audio',
    icon: 'bot',
    body: `
Agents in Krypt Studio are capable, but they aren't magic, and they don't do everything. Knowing where the edges are saves you time and surprises.

## What agents can do

They use the same commands as your own clicks, so whatever they do shows up live and can be undone.

| Area | They can |
|---|---|
| Notes and patterns | Write whole patterns, add notes, quantize, add groove and swing, transpose, arpeggiate, strum, chop and humanize |
| Sounds | Pick presets and samples by role and genre, load factory, pack and folder samples, set any knob, save presets, and use your installed VST3 / CLAP plugins |
| Arrangement | Arrange patterns into sections, add markers, place clips, insert or delete bars, draw automation, and add transitions at section changes |
| Mix | Add effects and chain presets, set levels and pans, route to buses and sends, and set up sidechain ducking |
| Audio | Bring in audio, find tempo and key, split stems, turn audio into notes, stretch and pitch clips, match a vocal to a beat and tune it with Krypt Tune |
| Checking | Render a preview, review the whole song, compare it with a reference, and check originality |
| Releasing | Fill in the song info, set or generate a cover, and export a WAV or MP3 |
| Library | Read your reference library and style profiles, and queue your songs for analysis |

## How agents "listen"

An agent can't hear sound the way you do. It "listens" by rendering the song and reading measurements:

- loudness (LUFS), true peak and clipping;
- the balance of lows, mids and highs, and the stereo width;
- an energy curve over time, and the energy of each section;
- the key, the chords in each bar and notes that are out of key;
- clashes in the low end, robotic velocities, loops that repeat too long, sections without a transition.

So it can tell that "the low end is 3 dB under the reference" or "the hats have flat velocities", but not that a melody is catchy or a sound is cheesy. That's your job. When something sounds off to you, tell it what you hear.

It also can't see your screen, and it doesn't hear what you play live.

## What only you can do

| Only you can | Where |
|---|---|
| Save, open or close projects | [[Ctrl+S]], **File** menu |
| Download sound packs | Home ▸ Sounds & Plugins ▸ Sound packs |
| Download AI models (for stems and deep analysis) | Model Manager |
| Install and scan plugins | Plugin Manager |
| Record audio or MIDI | The record button |
| Change settings, including what files agents may open | Settings ▸ Agents (MCP) |
| Choose where an export goes | The Export dialog ([[Ctrl+R]]) |

Agents export into **Music ▸ Krypt Studio** (or next to your project, if you choose that in Settings ▸ Project ▸ **Agent exports go to**). They never pick the folder and never overwrite a file.

[[action:settings|Open Settings]]

## Sound packs

Agents know which packs exist and which ones you have (\`list_packs\`). They use installed packs, and they may suggest one when a real piano or drum kit would help. They can't download a pack: that's always your click, in Home ▸ Sounds & Plugins. A preset that needs a pack you don't have is skipped when they pick sounds.

[[action:sounds|Open Sound packs]]

## Things that need a model

Some tools run on-device AI models. Two come with the app; one is a download you make in the Model Manager:

| Model | Used for | Install |
|---|---|---|
| Beat This! (small) | Beats and tempo | Built in |
| Basic Pitch | Turning audio into notes | Built in |
| HT-Demucs | Splitting stems, mashups, deep library analysis, sharper drum reading of reference songs | Download in the Model Manager |

Without HT-Demucs, an agent asked for stems tells you to install it. It never downloads a model itself.

[[action:modelManager|Open Model Manager]]

## Which files agents can open

By default an agent can open any audio file on your PC that you point it at. **Settings ▸ Agents (MCP) ▸ File access** can change that to **Ask me** or **Browser folders only**. In every mode:

- the files your project already uses always work;
- network paths are refused;
- only audio files open, and images only for a cover;
- agents never delete your files.

The full table is in [[guide:ai-agents#which-files-agents-can-open|AI agents]].

## Limits worth knowing

- A review renders up to 256 bars, a preview up to 64.
- The built-in chat takes up to 30 steps per message. A big request can run out of steps; just say "continue".
- The built-in chat uses your own API key (Anthropic, OpenAI or OpenRouter), so its use is billed to that account. Connected apps like Claude Code use their own plans.
- When nothing changed, the agent's tool says "No change:" instead of pretending. If an answer claims something you can't see, ask it to check with \`get_project\`.
- The originality check is a production aid, not legal advice.

## Privacy

Agents reach Krypt Studio only on your PC. What an agent reads from your project goes to the AI service of the app you use (for example Anthropic for Claude), under that app's terms. Krypt Studio itself has no telemetry and sends nothing anywhere.

Next: [[guide:ai-results|Getting great results from the AI]]
`,
  },
];
