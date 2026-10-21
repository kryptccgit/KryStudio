// Genre walkthroughs (guides-content-1). See research/14-sounds-and-guides.md §3 for the markup and the rules.
// The {{playbook:…}} cards are built live from shared/playbooks (src/guides/facts.ts): tempo, swing, keys, drums,
// structure, loudness and the first three mistakes. The text here adds the feel, the why, more pitfalls and a
// build walkthrough with real controls; it doesn't restate the card's numbers.
import type { GuideArticle } from '../articles';

export const GENRES: GuideArticle[] = [
  {
    id: 'genre-trap',
    title: 'Trap and drill',
    summary: 'Half-time drums, rolling hats, sliding 808s and dark melodies: how trap and drill work, and how to build each one.',
    group: 'Genres',
    icon: 'flame',
    body: `
Trap grew out of Southern US hip-hop; drill took its tempo and turned it colder. Both are **half-time**: the tempo is fast, but the snare or clap lands once per bar, so the body of the beat feels slow and heavy while the hats race on top.

The cards below are the same recipes the AI follows, read live from the app.

## Trap

{{playbook:trap}}

### The feel

Space and weight. A trap beat is mostly empty: a kick, a clap on beat 3, an 808 and a short melody with rests. The excitement comes from the hats (rolls and triplet bursts) and from parts dropping in and out, not from piling on notes.

### Why it works

- The half-time clap gives the vocal a slow pocket to sit in, while the hats keep the energy up.
- The 808 is both the bass and the low drum. Starting each 808 note with a kick makes them one big hit.
- A short, repeated melody is easy to rap or sing over. The space is where the vocal goes.

### Pitfalls

- **A quiet, clean 808** disappears on phones. Saturate it so its harmonics carry.
- **Full drums from bar 1:** start with the melody alone (filtered), so the first hook hits.
- **Reverb on the kick or 808**, or pads below 150 Hz: keep the low end dry and mono.

## Drill

{{playbook:drill}}

### The feel

Tension. Sliding 808s carry the tune, snares land in unexpected places, and hats skip in triplet groups with gaps. Above it: dark strings or piano in harmonic minor.

### Why it works

- The **808 slides** are the hook. Keep the top melody simple so they speak.
- The **off-grid second snare** and the **triplet hat gaps** make it lurch forward instead of rolling like trap.
- **Harmonic minor**'s raised 7th gives the dark, cinematic pull.

### Pitfalls

- **An 808 that never slides** sounds like trap. Mono, a longer glide, slides up an octave or a fifth and back.
- **Straight 16th hats.** Drill hats live on a triplet grid.
- **A busy kick:** drill kicks are sparse; leave gaps for the slides.

## Build a trap beat in Krypt Studio

1. **Set up.** A new project in a new tab ([[Ctrl+N]]). Set the tempo (the card's typical BPM) and, in **Project info** ([[F11]]), the genre "Trap", so agents and their preset picks follow it.
2. **Melody first.** Load a bell or pluck preset on the **Keys** channel ("Crystal Bell", "Night Pluck"). In the Piano Roll ([[F7]]) set the **Scale highlight** to a minor key and write a 2-bar motif with rests. Duplicate it with [[Ctrl+B]] and change the ending.
3. **Drums.** In the Channel Rack ([[F6]]): kick on step 1 plus a couple of syncopated hits, clap on step 9, hat on **Fill each 2 steps**. Swap the hat for "Trap Hat" from the preset browser.
4. **Hat rolls.** Open the hat in the Piano Roll. With **Snap** on **1/8 beat**, draw 32nd rolls at bar ends; with **1/6 beat**, a triplet burst before the clap. Shape the **Vel** lane, then **Tools ▸ Groove ▸ Hip hop** on the hats only.
5. **808.** In the Piano Roll on the **808** channel, turn on **Ghost notes**, start each note with a kick, and use the **slide** toggle for a glide up at the end of the phrase.
6. **Mix.** In the Mixer ([[F9]]): **808 Grit** on the 808 insert (right-click ▸ **Load chain…**), a Krypt Duck sidechained to the kick (see [[guide:compression#sidechain-duck-under-the-kick|sidechain]]), and **Trap Loud** on the master.
7. **Arrange.** Clone the pattern for intro, hook and verse variations and lay them out on the Playlist ([[F5]]). Put a reverse cymbal from **Factory sounds** before each hook and mute the 808 for the last beat before it.

[[show:pianoRoll.snap|Show me the snap setting]] [[show:mixer.chainPresets|Show me the chain presets]]

## Turn it into drill

1. Keep the tempo; switch the key to harmonic minor in the scale highlight.
2. Load "Drill Slide 808" and raise the **Glide** under **Voice** in its plugin window. Write short notes that slide up an octave and back.
3. Rewrite the hats with **Snap** on **1/6 beat**: groups of two or three hits, then a gap.
4. Snare on step 9, plus one early hit in the second bar.
5. Replace the bell with dark strings or piano ("Cinematic Strings", "Dark Piano"), wide and wet.

> **Ask the AI:** "make a dark trap beat in F# minor at 140" or "turn this into drill". The agent follows the same recipe, builds the whole song, then runs \`review_song\` and fixes what it finds. Revert it all in **Edit ▸ History** if you don't like it.

More: [[guide:bass-808|Bass and 808s]] · [[guide:drums|Drum programming]] · [[guide:transitions|Transitions]].
`,
  },
  {
    id: 'genre-hiphop',
    title: 'Hip-hop, boom bap and lo-fi',
    summary: 'Swung, sample-style drums, jazzy chords and dusty sound: how boom bap and lo-fi work, and how to build them.',
    group: 'Genres',
    icon: 'mic',
    body: `
Boom bap comes from the sample-based hip-hop of the late 80s and 90s; lo-fi slowed it down into calm, instrumental loops. Both are about **groove and texture**: swung drums that feel played, and chords that sound like they came off an old record.

## Boom bap

{{playbook:boom-bap}}

### The feel

Head-nod. A hard kick, a snare that cracks on 2 and 4, swung hats with ghost notes, and a short loop of minor 7th chords under it. The drums are loud and in front; everything else sits behind them, a little dusty.

### Why it works

- **Swing** plus a real-drummer groove makes the loop bounce instead of tick.
- **The loop is the music.** A short chord loop repeated for a whole verse leaves the middle of the mix open for the rapper.
- **The bass follows the kick**, so the low end hits as one.

### Pitfalls

- **Bright, wide, clean keys.** Roll off the top and add tape warmth so they sit behind the drums.
- **Too much melody.** A short horn or string phrase in the hook is plenty.
- **Big washy reverb.** Boom bap is dry: a short room at most.

## Lo-fi

{{playbook:lofi}}

### The feel

Calm and worn. Soft drums that sit behind the beat, jazzy 7th and 9th chords, a simple round bass, maybe a lazy melody, all with rolled-off highs and a bed of vinyl crackle or tape hiss.

### Why it works

- **Extended chords** (maj7, m9) sound warm and unresolved, so a 4-bar loop can repeat for minutes without wearing out.
- **Late, soft drums** relax the listener; nothing is accented hard.
- **Texture** glues it together, and taking it away in the break is an effect in itself.

### Pitfalls

- **Too loud.** Lo-fi is mastered quietly; slamming it ruins the softness.
- **Hard, punchy drums.** Soften the kick and snare, lower velocities, no hard accents.
- **Too long.** Two or three minutes, a loop with drums dropping in and out.

## Build a boom bap beat in Krypt Studio

1. **Tempo and swing.** Set the tempo from the card, then turn up the **Swing** knob in the Channel Rack header to the card's value.
2. **Drums.** Kick on step 1 and around beat 3, snare on steps 5 and 13 (try "Dusty Kick" and "Dusty Snare"). Hats on 8ths or 16ths; lower the off-beat hats in the **Vel** lane and add a couple of quiet ghost snares.
3. **Groove the whole kit.** In the Piano Roll, select all the drum notes of each channel and pick **Tools ▸ Groove ▸ Hip hop**.
4. **The loop.** On a keys channel ("Lofi Keys", "Mellow E-Piano"), use the **Chord stamp** on **Chord m7** or **Chord m9** for a 2-chord loop. Chop it into short stabs with **Tools ▸ Chop…**.
5. **Bass.** A warm bass that starts with the kick, short notes on the roots.
6. **Sound.** On the keys insert, load the **Lofi Tape** chain; on a Drum Bus, **Dusty Tape** or **Dirty Crunch**; a **Tight Room** reverb send; **Hip-Hop Punch** on the master.
7. **Arrange.** Fill or drop the kick at the end of every 8 bars. Intro and outro: the loop alone, low-passed. **Load chain…** ▸ **Low-Pass Sweep** on the keys insert with **Append** (so the tape chain stays), and automate its **Cutoff** (right-click the knob ▸ **Create automation clip**).

## Make it lo-fi

1. Lower the tempo and raise the swing a little more. Use **Tools ▸ Groove ▸ Soul** on the drums, bass and keys.
2. Spread the chords with smooth voice leading (maj7 and 9th chords) and **Strum…** ([[Alt+S]]) them slightly.
3. Lower all drum velocities. Swap to softer kicks and snares.
4. Add a vinyl or tape texture loop from **Factory sounds** under everything, quietly. Drop it out in the break.
5. Master with **Lofi Warm**. For the ending, **Krypt Gate/Time** with the **Tape stop** pattern on the last beat.

[[show:channelRack.swing|Show me the swing knob]] [[show:browser.factory|Show me the factory sounds]]

> **Ask the AI:** "make a lo-fi beat in F major, soft and dusty" or "give this boom bap loop more swing". Agents apply the genre's groove template to the drums, bass and keys, the way the card shows.

More: [[guide:chords|Chords and progressions]] · [[guide:drums#groove|Groove]] · [[guide:sampling|Sampling and chopping]].
`,
  },
  {
    id: 'genre-electronic',
    title: 'House, techno and EDM',
    summary: 'Four on the floor, offbeat bass, 8-bar phrasing and builds that land: house, deep house, tech house, techno and EDM.',
    group: 'Genres',
    icon: 'zap',
    body: `
House began in the clubs of Chicago in the 1980s, and techno, tech house and EDM all grew from the same four-on-the-floor kick. They share one rule: **music for DJs and dance floors, built in 8-bar phrases**.

## What they share

- **The kick on every beat**, a clap on 2 and 4, an open hat on every offbeat.
- **The bass between the kicks**, ducking under each one.
- **Changes on phrase boundaries**: something enters or leaves every 8 or 16 bars, never at bar 6.
- **DJ-friendly intros and outros**: mostly drums, so a DJ can mix in and out.

## House

{{playbook:house}}

Bouncy and warm: syncopated piano or organ stabs, an offbeat bassline, shuffling hats. Keep the chord loop short and let the stab rhythm do the work.

## Deep house

{{playbook:deep-house}}

Softer and later at night: a rounder kick, real swing, minor 9th and 11th chords, a melodic bass. Movement comes from slow filter sweeps, not big builds. Avoid snare rolls and big risers here.

## Tech house

{{playbook:tech-house}}

Groove first: busy, syncopated percussion and a funky 16th-note bass riff that is the hook. Little or no harmony. A stutter on the last beat of a build is a classic move.

## Techno

{{playbook:techno}}

Hypnotic and driving: a heavy kick, a rumbling offbeat bass, a short sequence. The notes barely change; the **sound** does: filter cutoff, resonance, delay feedback and reverb, automated over 16 to 32 bars.

## EDM

{{playbook:edm}}

Breakdown, build, drop. The breakdown states the hook softly with no kick, the build adds a snare roll, a rising high-pass and a riser, a beat of silence, and the drop lands with everything at once: kick, sub, huge pumping chords and a short high lead.

## Build a house groove in Krypt Studio

1. **Tempo and swing** from the card (EDM stays straight).
2. **Kick:** right-click the Kick ▸ **Fill** ▸ **Fill each 4 steps**. **Clap** on steps 5 and 13.
3. **Hats:** a closed hat on 16ths, and an open hat with **Fill each 4 steps, from step 3** (the offbeats). Choke the open hat with the closed one using **Cut group** and **Cut by** under **Voice**.
4. **Groove:** **Tools ▸ Groove ▸ Dance** (or **Funk** for deep and tech house) on the hats and percussion only. The kick stays tight.
5. **Bass:** notes on the offbeats, between the kicks. Add **Krypt Duck** in **Sidechain follow** mode keyed from the kick.
6. **Stabs:** on a keys or stab preset ("House Piano", "House Stab", "Organ Stab"), one or two chords with a syncopated rhythm, using the **Chord stamp** (**Chord m7** or **Chord m9**).
7. **Mix:** **Club Tight** on a Drum Bus, **Club Loud** on the master (**Festival Max** for EDM).

## Build and drop (EDM, house, tech house)

1. Route the music (not the drums) to a **Music Bus** insert.
2. Load the **High-Pass Sweep** chain on it, then right-click the filter's **Cutoff** ▸ **Create automation clip** and draw it rising over the build, snapping back on the drop.
3. Write a snare roll in the last bars: quarters, then 8ths, 16ths and 32nds (Piano Roll **Snap**), velocity rising.
4. Drag a **riser** from **Factory sounds** so it **ends** on the drop: a 4-bar riser starts 4 bars before it.
5. Leave the last beat empty. On the drop downbeat: an impact and a crash.
6. Pump the chords: **Pumping Chords** chain, or **Krypt Duck** in **Tempo shape** mode.

[[show:playlist.markers|Show me the marker bar]] [[show:mixer.chainPresets|Show me the chain presets]]

## Pitfalls beyond the card

- **Swung or humanised kicks** in EDM and techno: the kick is the clock.
- **A 32-bar drop with no change:** add or remove one element every 8 bars.
- **Muddy supersaws:** high-pass the chords around 200 Hz and keep everything below about 120 Hz mono.
- **Techno that changes notes instead of sound:** automate the filter, not the melody.

> **Ask the AI:** "make a deep house track in F minor" or "add an 8-bar build before the second drop". The agent places transitions with \`add_transition\` (risers end exactly on the boundary) and draws the filter sweep for you.

More: [[guide:transitions|Transitions]] · [[guide:arrangement|Song structure]] · [[guide:compression|Compression and sidechain]].
`,
  },
  {
    id: 'genre-pop-rnb',
    title: 'Pop, R&B and afrobeats',
    summary: 'Songs built around a voice: hooks and choruses that lift, extended chords, and the afrobeats groove.',
    group: 'Genres',
    icon: 'sparkles',
    body: `
Pop, R&B and afrobeats are **song** genres: everything serves a voice and a hook. The beat leaves room for a singer, sections are short, and the chorus has to feel bigger than the verse.

## Pop

{{playbook:pop}}

### The feel

One big, singable hook, clear four-chord harmony, short sections. Verses are thin; the chorus opens up with claps, wide chords and a synth doubling the hook. Polished and bright, every part in its own space.

### Why it works

- **The hook comes first.** Write the 2-bar chorus melody before anything else, then make every section lead to it.
- **Contrast does the lifting.** A thin verse makes the same chorus sound huge.
- **One chord loop per section** keeps the melody the star.

### Pitfalls

- **Long intros.** Get to the first chorus quickly.
- **A muddy middle:** piano, chords and pad pile up at 200–500 Hz. High-pass and cut so the vocal range stays clear.
- **A dull master.** Pop wants air and controlled lows.

## R&B

{{playbook:rnb}}

### The feel

Smooth and intimate: a laid-back groove, a soft kick, quiet but busy hats, a warm bass and rich chords (maj9, m9, m11) on electric piano. Pads and a guitar-like pluck answer the vocal between its phrases.

### Why it works

- **Extended chords** carry emotion without needing many of them.
- **Soft, swung drums** keep it relaxed.
- **Call and response** with the voice: the instruments speak only when the singer breathes.

### Pitfalls

- **A busy arrangement** that fights the vocal. Keep the midrange open.
- **Choruses that don't lift:** add the pad, a shaker and the pluck, and open the hats.
- **A hard, bright mix.** Warm, soft, not slammed.

## Afrobeats

{{playbook:afrobeats}}

### The feel

Warm and bouncy. A syncopated kick, a rim and congas playing against it, a constant shaker with accents, all with a gentle swing. Bright major-7th chords are played as rhythm, and a melodic bass moves with the kick.

### Why it works

- **Counter-rhythm:** the percussion plays against the kick, so the groove keeps moving forward.
- **Chords as rhythm:** offbeat stabs and a picked pattern add to the groove instead of sitting still.
- **Short hooks** repeated in call and response.

### Pitfalls

- **A four-on-the-floor kick.** That's house; afrobeats kicks are syncopated.
- **Held, static chords.** Play them rhythmically.
- **A root-only bass.** Let it walk between roots, fifths and passing notes.

## Build a pop chorus in Krypt Studio

1. Set the tempo from the card. Pick a key that suits the singer.
2. **Chords:** on a piano or chord preset ("House Piano", "Supersaw Chords"), use the **Chord stamp** to write I – V – vi – IV, one chord per bar (see [[guide:chords|Chords and progressions]]).
3. **Hook:** on a pluck ("Future Pluck"), a 2-bar melody that starts on the 3rd or 5th of the key. Repeat it, changing the ending.
4. **Drums:** kick, clap and snare on 2 and 4, hats, and **Tools ▸ Groove ▸ Pop** lightly on the hats.
5. **Contrast:** clone the pattern for the verse and remove the clap, the pluck and half the chords.
6. **Mix:** **Pop Polish** on the master; a **Bright Plate** reverb send and a **Dotted Eighth** delay send for the hook and vocal.

## Make it R&B or afrobeats

- **R&B:** lower the tempo, switch the chords to **Chord maj9** and **Chord m9** with smooth voicing, **Tools ▸ Groove ▸ Soul** on the drums, bass and keys, the **R&B Silk** master.
- **Afrobeats:** a syncopated kick, a rim and conga part against it, a shaker on 16ths with accents in the **Vel** lane, then **Tools ▸ Groove ▸ Afrobeat** on every drum and the bass. Chords as offbeat stabs on keys or a pluck ("Highlife Pluck", "Afro Keys Chords").

## Vocals

These genres live on the voice. To tune a vocal, match it to the beat, or build a mashup, see [[guide:vocals|Vocals, tuning & mashups]].

> **Ask the AI:** "write a pop chorus in G with a hook the pluck doubles" or "make an afrobeats groove at 104". Agents build from the same recipe as the card and can tune a vocal with Krypt Tune.

More: [[guide:melodies|Melodies and hooks]] · [[guide:arrangement|Song structure]].
`,
  },
  {
    id: 'genre-more',
    title: 'More genres',
    summary: 'Phonk, reggaeton, future bass, dubstep, drum & bass and synthwave: the feel, the key moves and where to start.',
    group: 'Genres',
    icon: 'book',
    body: `
Krypt Studio has a recipe for 18 genres. These six don't fit the families in the other genre guides, but the AI knows them just as well. Each card is read live from the recipe the AI follows.

## Phonk

{{playbook:phonk}}

Loud, gritty and short. The hook is a pitched cowbell riff (try the "Phonk Cowbell" preset) playing three or four notes in **Phrygian**, the minor scale with a lowered 2nd: set it in the Piano Roll's **Scale highlight**. Drive the 808 ("Phonk 808") and finish with **Phonk Slam** on the master.

- Pick where the grit lives. Distortion on the drums, the 808 and the master at once flattens the kick.
- Tame the cowbell around 3–5 kHz with **Krypt EQ** so it's loud without piercing.

## Reggaeton

{{playbook:reggaeton}}

Everything rides the **dembow**: a kick on every beat and a snare on steps 4, 7, 12 and 15 of each bar. Under it, an 808-style sub on the roots of a minor loop; plucked chords hit on the same accents ("Dembow Pluck", "Dembow Stab").

- Stop the dembow for the last beat before each chorus, and drop the kick in pre-choruses, so the chorus returns with impact.
- Keep it straight: a light **Latin** groove (**Tools ▸ Groove ▸ Latin**) on the snare, hats and percussion only.

## Future bass

{{playbook:future-bass}}

Bright and emotional, in half-time. Big detuned chords with 7ths and 9ths play syncopated stabs that pump hard with the kick. Start from "Future Stab" or "Supersaw Chords", load the **Pumping Chords** chain, and put a high pluck lead with octave jumps on top.

- The pump **is** the sound: Krypt Duck on the chords, deep.
- Builds use triplet snare rolls (**Snap** on **1/6 beat**) into a beat of silence.

## Dubstep

{{playbook:dubstep}}

Heavy half-time bass music. A huge snare on beat 3, a clean sine **sub** for the weight and a separate growling **mid bass** for the character, playing short call-and-response phrases with silence between hits ("Wobble Bass", "FM Growl", "Pure Sub").

- Keep the sub mono and alone below about 100 Hz; high-pass the growl above it.
- Vary the growl every phrase: automate its filter, or alternate two patches.
- The breakdown must be quiet for the drop to hit: this genre wants the biggest section contrast of all.

## Drum & bass

{{playbook:dnb}}

Fast, rolling breakbeats: the **two-step** (kick on 1 and the "and" of 3, snare on 2 and 4) dressed with ghost snares, shuffled hats and a ride. Underneath, a clean sub and a moving reese bass ("Reese", "Rolling Bass").

- Short, tight drum sounds. At this tempo long tails smear.
- **Tools ▸ Groove ▸ Funk** on the hats, ride and percussion makes the break roll.
- Long sections and long DJ intros: think in 16 and 32 bars.

## Synthwave

{{playbook:synthwave}}

Nostalgic and cinematic. A steady drum-machine beat with a big roomy snare on 2 and 4 and tom fills, a pulsing 8th-note bass bouncing between octaves ("Synthwave Bass"), slow pads, a 16th-note arpeggio ("Synthwave Arp", or **Tools ▸ Arpeggiate…** on a chord) and a singable lead with chorus and delay.

- Chorus, delay and reverb are part of the style: **Krypt Chorus** on the pads and lead, a **Big Hall** send.
- Keep the drums steady. **Retro Glow** on the master keeps it warm rather than loud.

## Start any of them

1. Set the genre in **Project info** ([[F11]]) so agents and their preset picks follow it.
2. Set the tempo and swing from the card.
3. In the preset browser (click the preset name in a plugin window), click the genre to see the presets made for it.
4. Use the card's drum list as your step-grid plan, then build up the parts it lists.
5. Load the master chain made for the genre ([[guide:mastering#the-master-chain|master chains]]).

> **Ask the AI:** "make a synthwave track in A minor" or "make a drum & bass roller at 174". One prompt builds a finished song from the recipe; then ask for changes one at a time.

More: [[guide:genre-trap|Trap and drill]] · [[guide:genre-hiphop|Hip-hop, boom bap and lo-fi]] · [[guide:genre-electronic|House, techno and EDM]] · [[guide:genre-pop-rnb|Pop, R&B and afrobeats]].
`,
  },
];
