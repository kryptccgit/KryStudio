// Mixing and mastering (guides-content-1). See research/14-sounds-and-guides.md §3 for the markup and the rules.
// Numbers here match the code: review_song's bands (electron/mcp/tools/craftReview.ts), the playbook targets
// (shared/playbooks/*), the factory chains (shared/sounds/factory/chains.ts) and the stock effect params (catalog.gen.json).
import type { GuideArticle } from '../articles';

export const MIXING: GuideArticle[] = [
  {
    id: 'mix-levels',
    title: 'Levels and gain staging',
    summary: 'Get a balance that works before any effect: headroom, the order to bring parts in, panning, and where volume lives in Krypt Studio.',
    group: 'Mixing',
    icon: 'sliders',
    body: `
Most of a good mix is just the right volumes. EQ and compression fix problems; levels make the song. Get the balance right first and everything after it is easier.

## Where volume lives

A sound passes several volume controls on its way to your speakers. Each one has a job:

| Control | Where | Use it for |
|---|---|---|
| Note velocity | the **Vel** lane in the Channel Rack and Piano Roll | dynamics inside a part |
| Instrument **Gain** | the plugin window (most stock instruments have one) | the instrument's output level |
| Channel volume | the knob on the Channel Rack row, or **Channel** in the plugin window | quick moves before the mixer |
| Insert fader | the Mixer ([[F9]]) | the mix balance |
| **Krypt Utility** Gain | an effect slot | trimming level between effects |
| Master fader and chain | the Master strip | the overall level and loudness |

Do the balance on the **insert faders**. Use the earlier stages only to keep each signal at a healthy level.

[[show:mixer.master|Show me the master insert]]

## Gain staging

**Gain staging** means keeping a sensible level at every step, so nothing clips on the way and nothing is so quiet that you have to crank it later.

- Watch the meters. Each Mixer strip has a peak meter with a hold line; a **red cap** means that insert clipped.
- Leave **headroom**: with everything playing, the master should peak around **−6 dB before the master chain**. The limiter and the master chain make it loud later; that is their job, not the faders'.
- If a part is too hot going into its effects, turn it down at the source (instrument Gain or channel volume) or put **Krypt Utility** first in its chain.
- If everything is too loud, pull all the channels down together, not the master fader alone.

## Build the balance

1. Start with the most important part. In beat-driven genres that's the **kick**; in pop and R&B, the vocal or the hook.
2. Set it so it peaks around −12 dB on the master meter, leaving room for the rest.
3. Bring in the **bass or 808** until it sits with the kick, neither one winning.
4. Add the **snare or clap**, then the **hats**, then the **chords and pads**, then the **melody**, then the ear candy.
5. For each new part, push it too loud, then too quiet, and settle where it is clear but not in your face.

A starting point for beat-driven music, relative to the kick:

| Part | Level |
|---|---|
| 808 or bass | about the same, ducking under each kick |
| Snare or clap | 1–3 dB under |
| Closed hats | 8–10 dB under the clap |
| Melody or hook | 4–6 dB under the clap, but clearly heard |
| Pads and textures | 10–12 dB under: felt more than heard |

Each genre guide's recipe card has the plan for that genre.

## Panning and width

- **Centre:** kick, snare, bass, 808, lead vocal, main hook. The low end always stays in the middle.
- **A little off centre:** hats, percussion, a second guitar or keys part.
- **Wide:** pads, doubled parts, reverb and delay returns.

Each Mixer strip has a pan knob and a stereo separation knob (left = narrower, all the way to mono; right = wider). Too much width cancels out on phone speakers and in clubs; \`review_song\` checks for it.

## Check your balance

- **Listen quietly.** At low volume, only the important parts should still come through.
- **Listen in mono.** Put **Krypt Utility** on the master with **Mono** on, listen, then remove it. If a part disappears, it is too wide.
- **Take breaks.** Ears adapt to anything in a few minutes.
- **Compare with a song you like** in the same genre, at the same loudness. AI agents can do this with \`compare_to_reference\`.

!> Krypt Studio has no loudness (LUFS) meter in the Mixer yet; the meters show peaks. When you export, the finished toast shows the file's peak and loudness in LUFS, and an AI agent can measure a render with \`render_preview\` or \`review_song\`.

> **Ask the AI:** "check my mix levels" or, in Claude Code, \`/krypt-studio:mixcheck\`. The agent renders the song, reads the loudness, peaks and band balance, and suggests (or makes) the moves. Every change is undoable in **Edit ▸ History**.

Next: [[guide:eq|EQ]].
`,
  },
  {
    id: 'eq',
    title: 'EQ',
    summary: 'Cut before you boost, a frequency map of a mix, and the seven bands of Krypt EQ.',
    group: 'Mixing',
    icon: 'wave',
    body: `
An **EQ** turns frequency ranges up or down. It is how you give every part its own space, so the bass, the chords and the melody stop masking each other.

## Cut before you boost

- **Cutting** removes what's in the way. Mixes get clearer when each part loses what it doesn't need.
- **Boosting** adds level and often harshness. If you boost, do it gently and broadly.
- Two parts fighting? Cut a little from one where the other lives, instead of boosting the other.
- Judge EQ in the full mix, not with the part soloed. A pad that sounds thin alone often sits perfectly in the song.

## The frequency map

These ranges match the bands \`review_song\` measures:

| Range | Name | What lives there | Typical moves |
|---|---|---|---|
| under 30 Hz | rumble | nothing you can hear, but it eats headroom | low cut on the master around 20–30 Hz |
| 30–60 Hz | sub | the weight of the kick and 808 | only kick, 808 and sub belong here |
| 60–250 Hz | low | body, punch, the bass note | high-pass everything that isn't kick or bass at 150–200 Hz |
| 250–500 Hz | low mids | warmth, and too much becomes mud | cut 2–4 dB around 300 Hz on pads, keys and chords |
| 500 Hz–2 kHz | mids | the note and presence of most parts | the reference band: other bands are judged against it |
| 2–6 kHz | high mids | bite, clarity, and harshness | small cuts around 3–4 kHz on harsh leads and claps |
| 6–20 kHz | highs | sizzle and air | a gentle shelf up for air, down for warmth or lo-fi |

## Krypt EQ

**Krypt EQ** has seven bands, left to right:

| Band | What it does |
|---|---|
| **Low cut** | Removes everything below **Freq**. **Slope** is 12, 24 or 48 dB per octave. Off until you switch it **On**. |
| **Low shelf** | Lifts or lowers everything below its frequency |
| **Peak 1**, **Peak 2**, **Peak 3** | Bells: boost or cut around a frequency. **Q** sets the width: low Q is broad and musical, high Q is narrow and surgical |
| **High shelf** | Lifts or lowers everything above its frequency |
| **High cut** | Removes everything above **Freq**. Off until switched **On** |
| **Output** | Overall level after the EQ |

Gains go to ±18 dB. You rarely need more than 3 to 4.

!> Krypt EQ's window shows knobs only: there's no curve or spectrum display yet. Use your ears, and the slot's green light to compare with and without the EQ.

## Moves you'll use every day

1. **Clean the lows:** on pads, keys, leads, plucks, vocals and hats, switch **Low cut** on at about 150 Hz (higher for hats).
2. **Remove mud:** **Peak 1** at about 300 Hz, −3 dB, **Q** around 1.
3. **Tame harshness:** **Peak 3** at about 3.5 kHz, −2 dB.
4. **Add air:** **High shelf** +1.5 to +2 dB at about 10 kHz.
5. **Find a problem:** turn one peak up 8–10 dB with a high Q, sweep the frequency until the ugly ring jumps out, then turn it into a cut of a few dB.

## EQ in Krypt Studio

1. Open the Mixer ([[F9]]) and click the insert you want to shape.
2. Click **Add effect** ▸ **Krypt EQ**. Its window opens.
3. Play the song in a loop and make one move at a time.
4. Toggle the slot's green light to bypass it. If the "after" isn't better, undo.

[[show:mixer.fxSlots|Show me the effect slots]]

Many effect-chain presets start with a tuned EQ already: right-click an insert ▸ **Load chain…**. And when you load an instrument preset **With effects**, its EQ comes along.

## Make room, not volume

When two parts compete (say the chords and the vocal, or the kick and the 808), decide which one owns that range:

- **Kick and 808:** both live in the sub. Let one own the lowest notes, and duck the 808 under the kick (see [[guide:compression|Compression and sidechain]]).
- **Chords and lead:** cut the chords a little in the lead's range (often 1–3 kHz).
- **Pads under everything:** high-pass higher than you think and cut the low mids. Pads should fill, not cover.

> **Ask the AI:** "the low end sounds muddy, fix it". The agent renders the song, compares each band with the genre's target and adds the EQ moves, like a low cut at 150 Hz on the pad or a 300 Hz dip on the keys.
`,
  },
  {
    id: 'compression',
    title: 'Compression and sidechain',
    summary: 'What a compressor does, Krypt Comp\'s controls, bus glue and parallel compression, and ducking the bass under the kick.',
    group: 'Mixing',
    icon: 'layers',
    body: `
A **compressor** turns a sound down when it gets loud. That evens out a part, makes drums punch, and glues a group of sounds together. A **sidechain** lets one sound (usually the kick) control the compressor on another (usually the bass).

## How it works

When the signal goes over the **threshold**, the compressor reduces it by the **ratio**: at 4:1, a part 8 dB over the threshold comes out only 2 dB over. **Attack** is how quickly it reacts; **release**, how quickly it lets go.

- **Slow attack** (20–30 ms) lets the start of each hit through, then clamps the tail: **more punch**.
- **Fast attack** (under 5 ms) catches the hit itself: **smoother, softer**.
- **Release** that matches the beat makes the compression breathe in time; too long and it never recovers.

## Krypt Comp

| Control | What it does |
|---|---|
| **Threshold** | Where compression starts (−60 to 0 dB) |
| **Ratio** | How hard it pushes down (1:1 to 20:1) |
| **Attack** / **Release** | Reaction times (0.1–200 ms / 5–2000 ms) |
| **Knee** | Soft knee eases into compression; 0 is hard |
| **Makeup** | Adds level back after compression |
| **Auto makeup** | On by default: keeps the loudness about the same, so you hear the change in shape, not just a volume drop |
| **Detector** | **Peak** reacts to hits; **RMS** to the average level |
| **Use sidechain input** | Lets another insert drive it (see below) |

!> Krypt Studio doesn't show gain reduction yet. Listen for the level dipping on hits, and bypass the slot (its green light) to compare.

## Starting points

| Job | Ratio | Attack | Release | How much |
|---|---|---|---|---|
| Even out a vocal or lead | 3–4:1 | 5–15 ms | 80–150 ms | the loud words come down 3–6 dB |
| Glue a drum bus | 2–4:1 | 20–30 ms | 50–100 ms | a few dB on the hits |
| Steady a bass | 4:1 | 5–10 ms | about 100 ms | the loudest notes level out |
| Master glue | 1.5–2:1 | about 30 ms | 100–200 ms | 1–2 dB, barely moving |

Turn **Threshold** down until you hear it working, then back off a little.

## Buses and parallel compression

A **bus** is an insert that several channels play into, like a **Drum Bus**. One compressor there glues the kit together.

1. In the Mixer ([[F9]]), click **+** after the last strip to add an insert. Rename it "Drum Bus".
2. Click a drum insert, then the arrow under **Drum Bus**. Do that for each drum.
3. Remove each drum's route to the Master in the **Routing** list, so the drums only reach the master through the bus.
4. On the bus: right-click ▸ **Load chain…** ▸ **Punchy Glue** (or **Club Tight** for dance music).

**Parallel compression** blends a heavily compressed copy with the original: punch without losing the dynamics. Set Krypt Comp hard (high ratio, low threshold), then turn the slot's small **mix** knob down to about 30–50 %.

## Other dynamics tools

- **Krypt Transient** makes hits snappier or softer and tails longer or shorter, without a threshold. Great on drums.
- **Krypt Clipper** shaves peaks off loud drums and 808s so the limiter has less work.
- **Krypt Squash** is aggressive three-band upward and downward compression. A little (Depth 10–20 %) adds density; a lot is an effect.

## Sidechain: duck under the kick

When the kick and the bass hit together, they fight for the same low frequencies. **Ducking** the bass for a moment each time the kick hits lets both through. Turned up further, it becomes the "pumping" sound of EDM and future bass.

### With Krypt Duck (the easy way)

1. Make sure the kick has its own mixer insert (new channels get one).
2. Select the 808 or bass insert and click **Add effect** ▸ **Krypt Duck**.
3. Set **Mode** to **Sidechain follow**.
4. Under the slot, in the **Sidechain** menu, pick the kick's insert.
5. **Depth** sets how far it ducks: about 30 % is −3 dB, 50 % is −6 dB (right for an 808 under the kick). 80 % and up is an obvious pump.
6. **Release** sets how fast it comes back: 80–180 ms for most tempos.

### Pumping in time, without a sidechain

Krypt Duck's default mode, **Tempo shape**, pumps on every 1/8, 1/4, 1/2 or bar (**Rate**) while the song plays. **Curve** goes from a snappy recovery to a long, swelling pump. Use it on pads and chords: the **Pumping Chords** chain is built this way.

### With Krypt Comp

Add **Krypt Comp**, set **Use sidechain input** to **On**, and pick the kick in its **Sidechain** menu. Fast attack (1 ms), ratio 4:1 or more, release around 100 ms. It reacts more naturally to how loud the kick is.

[[show:mixer.fxSlots|Show me the effect slots]]

> \`review_song\` checks that the parts a genre ducks (usually the 808, bass and sub, sometimes the lead) really are sidechained to the kick.

> **Ask the AI:** "sidechain the bass to the kick" or "make the chords pump". The agent's \`sidechain\` tool sets up Krypt Duck (or a sidechained Krypt Comp) for you.
`,
  },
  {
    id: 'space',
    title: 'Space: reverb, delay and sends',
    summary: 'Reverb and delay, inserts versus sends, pre-delay and decay, tempo-synced echoes, and keeping the low end dry.',
    group: 'Mixing',
    icon: 'headphones',
    body: `
Reverb and delay put sounds in a room. Used well, they give a mix depth: some parts close, others far away. Used badly, they turn everything to soup.

## Reverb

**Reverb** is thousands of tiny echoes blurred together, like a sound in a room or hall. **Krypt Reverb** has:

| Control | What it does |
|---|---|
| **Mode** | **Room** (small, natural), **Hall** (big, long, lush) or **Plate** (bright, dense: classic on vocals and snares) |
| **Size** | How big the space feels |
| **Decay** | How long the tail lasts (0.1 to 20 s) |
| **Pre-delay** | A gap before the reverb starts. 10–30 ms keeps a voice or snare clear in front of its own reverb |
| **Damping** | Rolls off the highs of the tail: lower is darker and further away |
| **Low cut** | Removes lows from the reverb: keeps it out of the bass |
| **Diffusion** and **Width** | How smooth and how wide the tail is |

Match the decay to the tempo: fast songs want shorter tails, or the reverb of one hit smears into the next.

## Delay

**Delay** repeats the sound. **Krypt Delay** syncs to the tempo by default:

| Time | Effect |
|---|---|
| **1/8** | a tight rhythmic echo |
| **1/8D** (dotted eighth) | echoes fall in the gaps of straight 8ths: the classic lead and pluck delay |
| **1/4** | big, clear throws on the last word or hit of a phrase |
| **1/4T**, **1/8T** | triplet echoes that swing against straight parts |

**Feedback** sets how many repeats. **Ping-pong** bounces them left and right. **Low cut** and **High cut** keep the echoes out of the way; darker repeats sit further back. **Modulation** adds a little tape wobble.

## Insert or send

You can put reverb or delay right on a part's insert and set the slot's **mix** knob. That is fine for one special effect. For the main space of a song, use **sends**:

- One reverb insert, set **100 % wet**, that many parts feed a little of.
- Every part sounds like it is in the same room, which glues the mix.
- One reverb uses less CPU than ten.
- You can EQ, duck or automate the reverb on its own.

## Make a send in Krypt Studio

1. Open the Mixer ([[F9]]) and click **+** after the last strip to add an insert. Rename it "Reverb".
2. Right-click it ▸ **Load chain…** and pick a reverb return: **Bright Plate** (vocals, snares, claps), **Big Hall** (leads, pads, breakdowns), **Tight Room** (drums and percussion) or **Dark Space** (long, dark atmospheres). These are already 100 % wet and low-cut.
3. Click the insert you want to send from (say, the snare). Every other strip now shows an arrow.
4. Click the arrow under **Reverb**. A small knob appears next to it: that's the send amount. Start low.
5. Leave the snare's route to the Master alone: the dry snare still plays, and the send adds its reverb.

Do the same with a "Delay" insert and the **Dotted Eighth**, **Quarter Ping-Pong** or **Tape Echo** chain.

[[show:mixer.chainPresets|Show me the chain presets]]

## Keep it clean

- **No reverb on the kick, 808 or sub.** The low end stays dry and mono.
- **Low-cut the returns** (the chains already cut below 250–350 Hz).
- **Less than you think.** If you can clearly hear the reverb as its own sound, it is often too much. Mute the send: if the mix suddenly feels dry and flat, the amount was right.
- **Front and back:** dry, bright and loud sits in front; wet, dark and quiet sits behind. Keep the lead and vocal more upfront than the pads.
- **Throws:** to echo just one word or hit, automate the send knob. Right-click it ▸ **Create automation clip**, then draw a short spike.

## Width without reverb

- **Krypt Chorus** thickens and widens pads and leads.
- **Krypt Imager** sets the width per band: keep the lows at 0 % (mono) and widen the highs a little.
- The **stereo separation** knob on each Mixer strip widens or narrows a whole insert.

Too wide is a real problem: parts can cancel out on phones and in clubs. \`review_song\` checks the stereo correlation of your mix.

> **Ask the AI:** "add a plate reverb send for the snare and vocal, and a dotted-eighth delay on the lead". The agent creates the send inserts with \`apply_chain\` and routes the parts with \`route\`.
`,
  },
  {
    id: 'mastering',
    title: 'Mastering and loudness',
    summary: 'LUFS and true peak, the master chain for your genre, the limiter, and what review_song checks before you export.',
    group: 'Mixing',
    icon: 'mixer',
    body: `
**Mastering** is the last polish on the whole song: a little tone shaping, a little glue, and enough loudness to stand next to other songs, without clipping. In Krypt Studio it all happens on the **Master** insert.

!> Mastering can't fix a mix. If the low end is muddy or the vocal is buried, go back to the faders and EQ first.

## Loudness: LUFS

Peak meters show the loudest instant. Ears care about the **average**. **LUFS** (loudness units relative to full scale) measures perceived loudness the way ears hear it. **Integrated LUFS** is the average over the whole song.

- Numbers are negative: **−8 LUFS is louder than −14**.
- Streaming services turn loud songs down to a reference level (around −14 LUFS), so being louder than everyone gains less than you'd think.
- Genres still have habits. Club and bass music is mastered loud; lo-fi and R&B stay softer and keep their dynamics.

These are the integrated loudness targets \`review_song\` uses for each genre:

| Target | Genres |
|---|---|
| −7 LUFS | EDM, dubstep, phonk |
| −8 LUFS | trap, drill, house, tech house, techno, future bass, drum & bass |
| −9 LUFS | boom bap, pop, afrobeats, reggaeton, deep house |
| −10 LUFS | R&B, synthwave, and any song without a genre |
| −13 LUFS | lo-fi |

## True peak

Digital audio can peak **between** samples when it is played back or converted to MP3. **True peak** (dBTP) measures those in-between peaks. Keep the true peak at or under **−1 dBTP**: that is what \`review_song\` checks, and it leaves room for MP3 and streaming encoders.

New projects put **Krypt Limiter** first on the Master with its **Ceiling** at −1 dB and **True peak** on, which meets the −1 dBTP target. The factory master chains do the same. Projects made before this change start at −0.3 dB: set **Ceiling** to −1 dB there.

## The master chain

A typical chain, in order:

1. **EQ:** a low cut around 20–30 Hz, small tone moves.
2. **Glue compression:** gentle (about 2:1, slow attack), 1–2 dB.
3. **Colour** (optional): tape drive, Krypt Squash.
4. **Krypt Imager:** mono below about 120–150 Hz.
5. **Krypt Clipper:** shaves the sharpest peaks.
6. **Krypt Limiter:** sets the final loudness, ceiling −1 dB, true peak on.

The factory **master chains** are built exactly like that, one per sound:

| Chain | Made for |
|---|---|
| **Club Loud** | house, tech house, techno |
| **Festival Max** | EDM |
| **Bass Weight** | dubstep, future bass |
| **Trap Loud** | trap, drill |
| **Phonk Slam** | phonk |
| **Hip-Hop Punch** | boom bap |
| **Pop Polish** | pop, afrobeats, reggaeton |
| **R&B Silk** | R&B |
| **Deep Warm** | deep house |
| **DnB Roller** | drum & bass |
| **Retro Glow** | synthwave |
| **Lofi Warm** | lo-fi |
| **Streaming Clean** | anything dynamic, about −14 LUFS |

## Master your song

1. Finish the mix with headroom: the master should peak around −6 dB with no chain.
2. In the Mixer ([[F9]]), right-click the **Master** ▸ **Load chain…**. Master chains are listed first. Pick one for your genre and choose **Replace**.
3. Play the loudest part of the song. If it sounds squashed or distorted, lower **Krypt Limiter**'s **Gain** (its input). If it's too quiet, raise it a dB at a time.
4. Export ([[Ctrl+R]]). The toast tells you the file's peak and loudness in LUFS. Compare with the target above and adjust the limiter **Gain** by the difference.
5. Listen to the export on another system: earbuds, a phone, a car.

[[show:mixer.master|Show me the master insert]] [[action:export|Export audio…]]

> Leave **Normalize** off in the export dialog when your limiter already sets the level; it would move the level again.

> **Auto Master** does steps 2 to 4 for you: the **Auto** button on the Master strip (or **Tools ▸ Auto Mix…** in Master mode) builds the chain for a preset or a prompt, measures the render and sets the limiter to the target, then shows before and after. See [[guide:auto-mix|Auto Mix & Master]].

!> Krypt Studio has no live loudness meter yet (Krypt Analyzer's window doesn't show its display yet). Use the export toast, or ask an AI agent to measure a render.

## What review_song checks

When an AI agent finishes a song, it runs \`review_song\`: it renders the whole song through your real mixer and grades it against the genre's targets. On the mix side it checks:

- **Loudness:** integrated LUFS against the genre target.
- **Peaks:** true peak over −1 dBTP, and clipping.
- **Tonal balance:** sub, low, low mids, high mids and highs, each against the mids (500 Hz–2 kHz).
- **Stereo:** a correlation too low to be mono-safe.
- **Master chain:** no limiter, or only the bare default limiter.
- **Sidechain:** parts the genre ducks under the kick that aren't ducked.

It checks the arrangement and the sounds too (section lengths, energy, transitions, flat hat velocities, out-of-key notes). It returns a score, the top issues with a fix for each, and what already works. It never changes the project by itself. See [[guide:ai-results|Getting great results from the AI]].

> **Ask the AI:** "master this for streaming" or "review the song and fix the top issues". The agent loads the right master chain with \`apply_chain\`, sets the limiter, and checks the result with \`review_song\`.
`,
  },
];
