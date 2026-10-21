import type { GuideArticle } from '../articles';

export const BASICS: GuideArticle[] = [
  {
    id: 'rhythm-tempo',
    title: 'Rhythm and tempo',
    summary: 'BPM, bars, beats and steps, swing, half-time and triplets, and where each one lives in Krypt Studio.',
    group: 'Music basics',
    icon: 'music',
    body: `
Rhythm is **when** things happen. Tempo is **how fast** the beat goes. Every other choice in a track sits on top of these two, so they are worth getting right first.

## Tempo and BPM

Tempo is measured in **BPM**, beats per minute. At 120 BPM a beat lasts exactly half a second. Tempo sets the mood more than any sound does:

| Tempo | How it feels | Where you hear it |
|---|---|---|
| 65–98 | Relaxed, head-nodding | lo-fi, boom bap, slow R&B |
| 88–118 | Bouncy, mid-tempo | reggaeton, afrobeats, pop, synthwave |
| 118–140 | Driving, made for dancing | house, techno, EDM |
| 130–160 | Fast, but usually felt at half speed | trap, drill, phonk, dubstep, future bass |
| 170–178 | Very fast and rolling | drum & bass |

In Krypt Studio the tempo is the **BPM** number in the transport bar. Drag it up or down, scroll on it, or double-click it and type. New projects start at 140.

[[show:transport.tempo|Show me the tempo box]]

> Not sure what tempo a song or loop is? Drop it on the Playlist, right-click the clip and choose **Detect tempo & key**. You get the tempo plus its half-time and double-time readings. See [[guide:audio-tools|Audio tools]].

## Bars, beats and steps

Most modern music is in **4/4**: four beats to a bar. Each beat splits into four **16th notes**, and in the Channel Rack each square is one 16th, called a **step**. So one bar is 16 steps.

| Count | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| Step | 1 | 5 | 9 | 13 |
| The "and" (8th offbeat) | 3 | 7 | 11 | 15 |

Learn this table and you can read any drum pattern: "clap on 2 and 4" means steps 5 and 13; "kick on the and of 3" means step 11.

Music moves in **phrases** of 4 and 8 bars. Listeners feel when a phrase ends, so changes that land on bar 1, 5, 9 or 17 sound natural, and changes at bar 6 sound like mistakes. The [[guide:arrangement|Song structure]] guide goes deeper.

!> New projects are in 4/4 and the Studio has no time signature control yet. An AI agent can change it with \`set_tempo\` if you need 3/4 or 6/8.

## Swing

Straight 16ths are evenly spaced. **Swing** pushes every second 16th a little late, so the rhythm limps in a pleasant way: long-short, long-short. It is the difference between a stiff loop and one that makes your head move.

- The **Swing** knob in the Channel Rack header swings every channel. At 100 % the late 16ths move half a step; about 67 % puts them exactly on a triplet shuffle.
- Each channel has its own **Swing mix** in its plugin window (under **Channel**). Set it to 0 on the kick to keep it straight while the hats swing.
- The Piano Roll's **Quantize…** dialog ([[Alt+Q]]) also has a **Swing** slider, which writes the swing into the notes themselves.

[[show:channelRack.swing|Show me the swing knob]]

Swing is only one kind of feel. **Tools ▸ Groove** in the Piano Roll moves notes the way real drummers play them. The [[guide:drums|Drum programming]] guide shows how.

## Half-time and double-time

In **half-time** the snare or clap lands once per bar, on beat 3 (step 9), instead of on 2 and 4. A 140 BPM beat then feels like 70: fast hats on top, a slow, heavy body underneath. Trap, drill, dubstep and future bass all work this way.

**Double-time** is the reverse: parts move twice as fast as the beat suggests, like 32nd-note hat rolls or a drum & bass break over a slow pad.

## Triplets

A triplet fits three notes in the space of two. They break up straight rhythms: trap hat bursts, shuffles, swung grooves.

- **8th triplets**: three per beat. Set the Piano Roll **Snap** to **1/3 beat**.
- **16th triplets**: six per beat. Set **Snap** to **1/6 beat**.
- **32nd notes** for fast rolls: **1/8 beat**.

[[show:pianoRoll.snap|Show me the snap setting]]

The Channel Rack's step grid only plays straight 16ths, so write triplets in the Piano Roll. A quick way: draw one note, then **Tools ▸ Chop…** ([[Alt+U]]) ▸ **Equal pieces** and pick 3 (or 6).

## Try it

1. Set the tempo to 140.
2. Open the Channel Rack ([[F6]]). Put the kick on step 1 and the clap on step 9: that's half-time.
3. Turn on every second step of the hat. Then every step.
4. Turn the **Swing** knob up slowly and listen to the hats start to bounce.
5. Now move the clap to steps 5 and 13 and drop the tempo to 90: the same sounds, a boom bap feel.

> **Ask the AI:** "set the tempo to 92 and give the drums a hip-hop swing". Agents use \`set_tempo\`, \`set_swing\` and the groove templates, and every change is one undo step.
`,
  },
  {
    id: 'keys-scales',
    title: 'Keys and scales',
    summary: 'Major and minor, the modes producers use, how to pick a key, and the Piano Roll scale highlight.',
    group: 'Music basics',
    icon: 'piano',
    body: `
A **key** is the home base of a song: one note that feels like "rest" and a set of notes that sound right around it. A **scale** is that set of notes. You don't need theory to make music, but knowing the key keeps your bass, chords and melody from fighting.

## Notes and octaves

There are 12 notes, then they repeat an octave higher: C, C#, D, D#, E, F, F#, G, G#, A, A#, B. A sharp (#) is one step up; the same note can be called a flat (♭) of the note above, so C# and Db are the same key on the piano.

Krypt Studio's Piano Roll names **middle C "C4"** (MIDI note 60). Each octave counts up from C, so the note below C4 is B3. 808s and sub basses live around C1 to C3; melodies around C4 to C6.

## Major and minor

Scales are built from steps: a **whole step** is two piano keys, a **half step** is one.

| Scale | Step pattern | Starting on | Notes |
|---|---|---|---|
| Major | whole, whole, half, whole, whole, whole, half | C | C D E F G A B |
| Natural minor | whole, half, whole, whole, half, whole, whole | A | A B C D E F G |

C major and A minor use the same seven notes: A minor is the **relative minor** of C major. Every major key has one, three half steps down. Which one you hear depends on which note feels like home.

Major tends to sound bright and settled; minor sounds darker and more serious. Most trap, drill, techno and EDM is in minor. Pop, afrobeats and future bass lean major.

## The modes producers use

A **mode** is a scale with one or two notes changed. Each change gives the key its own colour:

| Scale | Change | Colour | Common in |
|---|---|---|---|
| Natural minor | (the plain minor) | sad, serious | trap, EDM, techno |
| Harmonic minor | minor with a raised 7th | dramatic, eerie | drill, trap leads, reggaeton |
| Dorian | minor with a raised 6th | soulful, jazzy | lo-fi, deep house, boom bap |
| Phrygian | minor with a lowered 2nd | dark, menacing | phonk, techno, drill |
| Lydian | major with a raised 4th | dreamy, floating | future bass |
| Mixolydian | major with a lowered 7th | bluesy, relaxed | funky house, rock-leaning grooves |
| Minor pentatonic | five notes of minor | hard to play wrong | hooks, bass riffs |
| Major pentatonic | five notes of major | open, bright | lo-fi and pop melodies |
| Blues | minor pentatonic plus one bent note | gritty | riffs, fills |

Pentatonic scales leave out the two notes most likely to clash, which is why a melody written in one almost always sits well over the chords.

## Picking a key

- **For a singer:** the key that sits in their range wins over everything else. Try the hook a few semitones up and down.
- **For the low end:** the root note of the key is where your 808 or sub lives. F, F# and G put the lowest root at about 44 to 49 Hz, which hits hard on big speakers and still shows up on small ones.
- **For a genre:** each genre has habits, and the genre guides show them on their recipe cards. Trap leans on F#, C# and G minor; R&B on flat major keys.
- **For you:** honestly, any key works. Pick one and stay in it.

## The scale highlight

The Piano Roll can shade the notes of a key so you can see what fits:

1. Open the Piano Roll ([[F7]]).
2. Pick the key's root in the **Scale root** menu and the scale in the **Scale highlight** menu (Major, Minor, Harmonic minor, Melodic minor, Dorian, Phrygian, Lydian, Mixolydian, Locrian, the pentatonics, Blues or Chromatic).
3. Rows in the key are shaded. It only highlights: you can still place any note.

[[show:pianoRoll.scale|Show me the scale highlight]]

Once a scale is set, the **Tools** menu works with it:

- **Snap to (your key)** moves out-of-key notes to the nearest note in the key.
- **Select ▸ Out-of-key notes** finds the strays so you can decide yourself.
- **Flip vertically (in key)** ([[Shift+Alt+Y]]) mirrors a melody and keeps it in the key.
- **Randomize…** ([[Alt+R]]) has a **Stay in key** option for quick variations.

## Finding the key of something

- **A sample or song:** right-click it on the Playlist (or in the Browser) and choose **Detect tempo & key**.
- **Your own pattern:** an AI agent's \`render_preview\` reports a key estimate and lists out-of-key notes; \`review_song\` flags them too.

> **Ask the AI:** "what key is my pattern in?" or "snap the lead to F# minor". The agent uses the same scale snap as the Tools menu, and you can undo it in **Edit ▸ History**.

Next: build chords from your key in [[guide:chords|Chords and progressions]].
`,
  },
  {
    id: 'chords',
    title: 'Chords and progressions',
    summary: 'Triads, sevenths and extended chords, progressions by roman numeral, voicings and inversions, and the chord stamp.',
    group: 'Music basics',
    icon: 'chords',
    body: `
A **chord** is three or more notes played together. A **progression** is a loop of chords. Together they set the emotion of a track: the same drums feel hopeful over one progression and threatening over another.

## Triads

The basic chord is a **triad**: a root, a third and a fifth. The third decides major or minor.

| Chord | Semitones from the root | Sound | Chord stamp |
|---|---|---|---|
| Major | 0, 4, 7 | bright, settled | Chord maj |
| Minor | 0, 3, 7 | darker, sad | Chord m |
| Diminished | 0, 3, 6 | tense, unstable | Chord dim |
| Augmented | 0, 4, 8 | unresolved, dreamy | Chord aug |
| Sus2 / sus4 | 0, 2, 7 / 0, 5, 7 | open, undecided | Chord sus2 / sus4 |
| Power chord | 0, 7 | neutral, heavy | Chord 5 |

## Sevenths and beyond

Add another third on top and you get a **seventh chord**. Keep stacking for 9ths, 11ths and 13ths. These add colour and softness, and they are the sound of R&B, lo-fi, neo soul and deep house.

| Chord | Semitones | Feel |
|---|---|---|
| maj7 | 0, 4, 7, 11 | warm, dreamy |
| m7 | 0, 3, 7, 10 | smooth, mellow |
| 7 (dominant) | 0, 4, 7, 10 | bluesy, wants to move on |
| m9 / maj9 | add the 9th (14) | lush, jazzy |
| add9 | major plus the 9th, no 7th | bright, open |

## Chords in a key

Build a triad on each note of a scale, using only notes from that scale, and you get the chords that belong to the key. Musicians number them with **roman numerals**: upper case for major, lower case for minor, ° for diminished.

| Degree in major | C major | Degree in minor | A minor |
|---|---|---|---|
| I | C | i | Am |
| ii | Dm | ii° | Bdim |
| iii | Em | III | C |
| IV | F | iv | Dm |
| V | G | v (V in harmonic minor) | Em (E) |
| vi | Am | VI | F |
| vii° | Bdim | VII | G |

Numerals let you move a progression to any key. "i – VI – III – VII" is Am – F – C – G in A minor and F#m – D – A – E in F# minor.

In harmonic minor the v chord becomes major (V). Its raised 7th pulls hard back to the root: that pull is the drama in drill and reggaeton.

## Progressions that work

| Progression | Mood | Common in |
|---|---|---|
| I – V – vi – IV | uplifting, familiar | pop |
| vi – IV – I – V | bittersweet, euphoric | EDM, pop |
| i – VI – III – VII | epic minor | EDM, trap |
| i – VI, two bars each | dark and spacious | trap |
| i – iv – VI – V | dramatic, tense | drill (harmonic minor) |
| ii7 – V7 – Imaj7 | jazzy, resolved | lo-fi, boom bap |
| i7 – iv7 vamp | soulful, hypnotic | house, deep house |
| IV – V – iii – vi | hopeful but sad | future bass |

Two chords can carry a whole song. One chord per bar in a 4-bar loop is the most common rhythm; trap and techno often imply the harmony with just the bass and melody.

## Voicing and inversions

A **voicing** is which octave each note sits in and in what order. The same Am can be three notes bunched together or spread over two octaves.

- **Inversions** put a note other than the root at the bottom. Am with C at the bottom is the first inversion; with E at the bottom, the second.
- **Voice leading:** when the chord changes, move each note the shortest distance and keep shared notes where they are. Progressions sound smooth instead of jumpy.
- **Stay out of the bass's way.** Keep chords above about C3 when an 808 or bass plays. \`review_song\` flags "low-register clashes" when two parts pile up below C3.
- **Leave the root to the bass.** R&B and lo-fi keys often skip the root entirely and let the bass play it.

## Chords in Krypt Studio

1. Open the Piano Roll ([[F7]]) on a keys, pad or chord channel.
2. Set the **Scale highlight** to your key, so you can see which roots belong.
3. Pick a chord in the **Chord stamp** menu (for example **Chord m7**). Draw ([[P]]) and Paint ([[B]]) now place the whole chord on the note you click.
4. The stamp always builds the same shape, so switch it as you go: **Chord m** on the minor degrees, **Chord maj** on the major ones.
5. **Inversions:** select a chord's top note and press [[Ctrl+Shift+Down]] to drop it an octave, or the bottom note and [[Ctrl+Shift+Up]].
6. **Strum…** ([[Alt+S]]) staggers the notes like a played chord. **Arpeggiate…** ([[Alt+A]]) turns a chord into a pattern of single notes.
7. Turn on **Ghost notes** in the toolbar to see the bass under your chords.

[[show:pianoRoll.tools|Show me the Piano Roll toolbar]]

Need a sound? The preset browser's **chord** presets (like "Lofi Chords", "Deep Chords" or "Supersaw Chords") are made for this.

> **Ask the AI:** "write a 4-bar i – VI – III – VII progression in A minor on the keys, with smooth voicing". Agents can write chord symbols like \`Am7\` or \`Fmaj7\` directly in a pattern.

Next: put a melody on top in [[guide:melodies|Melodies and hooks]].
`,
  },
  {
    id: 'melodies',
    title: 'Melodies and hooks',
    summary: 'Motifs, repetition and variation, call and response, rhythm first, range and space.',
    group: 'Music basics',
    icon: 'vocal',
    body: `
A **hook** is the part people remember and hum later. In most beats it is a short melody: a bell loop, a synth riff, a vocal line. Good hooks are simpler than you think.

## Start with a motif

A **motif** is a tiny idea: three to six notes over one or two bars. Don't try to write a whole melody at once. Find a small shape you like, then build everything else out of it.

Strong motifs usually have one thing that sticks out: a jump, a repeated note, an odd rhythm or a held note.

## Rhythm first

Rhythm makes a hook catchy more than pitch does. Try this: write the melody's rhythm on **one note** first. If it already grooves on a single note, any pitches you choose will work. If it doesn't, no pitches will save it.

- Mix long and short notes.
- Start some phrases off the beat (on the "and"), not always on beat 1.
- Leave gaps. A rest is part of the rhythm.

## Repetition and variation

Listeners need to hear an idea a few times before it sticks, but exact repeats get boring. The most common shape is **repeat, then change the ending**:

1. Bar 1–2: the motif.
2. Bar 3–4: the same motif with a different last note or two.

Over a longer section, keep the motif and vary one thing at a time: the ending, the octave, one note's rhythm, or the instrument playing it.

## Call and response

A **call** is a phrase that feels unfinished; the **response** answers it. The answer can be:

- the same instrument, with an ending that resolves;
- another instrument, often an octave lower or higher;
- the drums, a vocal chop or an FX hit filling the gap.

Call and response keeps a loop moving without adding more notes at the same time.

## Range and contour

- **Keep it singable.** Most memorable hooks stay within about an octave. One big jump stands out; constant jumps sound random.
- **Shape it.** A melody that rises builds energy; one that falls relaxes. Many hooks rise to one high point, then come back down.
- **End on stable notes.** Notes 1, 3 and 5 of the scale feel finished. Ending on 2, 4 or 7 leaves the listener hanging, which is useful at the end of a call.
- **Hit chord tones on strong beats.** On beats 1 and 3, use a note from the chord playing underneath. In between, any scale note works.

## Register and space

Where a melody sits decides what it competes with:

| Part | Typical octave |
|---|---|
| Bells, plucks, music boxes | C5 to C7 |
| Leads and synth hooks | C4 to C6 |
| Counter-melody | an octave under the main hook |
| Vocal range | roughly C3 to C5 |

If a vocal will go on top, leave space: fewer notes, more rests, and keep the busiest melodic parts out of the vocal's octave. In trap, R&B and pop, the beat's melody is often only a 2-bar loop with long gaps.

## Write a hook in Krypt Studio

1. Open the Piano Roll ([[F7]]) on a lead, bell or pluck channel. The preset browser's **lead**, **bell** and **pluck** presets are good starting sounds.
2. Set the **Scale highlight** to your key, and turn on **Ghost notes** to see the chords.
3. Set **Snap** to **Step**. With Paint ([[B]]), draw the rhythm on one row.
4. Drag notes up and down onto shaded rows until you like the shape. Click the piano keys on the left to audition.
5. Select the two bars and press [[Ctrl+B]] to duplicate them. Change the last notes of the copy.
6. Shape the dynamics in the **Vel** lane under the grid: a little louder on the important notes.
7. Stuck? Select the notes and try **Tools ▸ Randomize…** ([[Alt+R]]) with **Stay in key** on and only **Pitch** turned up, or **Flip horizontally** ([[Alt+Y]]). Undo what you don't like.

[[show:pianoRoll.velocity|Show me the velocity lane]]

> Hum it. If you can't hum the hook after hearing it three times, simplify it.

## Before you call it done

- Is there one clear idea, repeated enough to remember?
- Does it leave room for the drums and the vocal?
- Does the second half answer the first?
- Is it your own? **Tools ▸ Check originality…** compares your melodies with the deep-analysed songs in your reference library. See [[guide:reference-library|Reference library & focus]].

> **Ask the AI:** "write a 2-bar bell hook in F# minor with space for a vocal, then a counter-melody an octave lower for the second hook". Agents write original melodies and can run the originality check for you.
`,
  },
  {
    id: 'bass-808',
    title: 'Bass and 808s',
    summary: 'Root notes, locking to the kick, glides, tuning the 808 to the key, and sub versus mid bass.',
    group: 'Music basics',
    icon: 'zap',
    body: `
The bass joins the drums to the harmony. It is the part people feel more than hear, and it is where most home mixes go wrong. An **808** is a bass made from a tuned kick drum with a long tail; it plays the bassline and adds weight at the same time.

## What the bass plays

- **Roots first.** Play the root of each chord, usually on the downbeat where the chord changes. That alone makes chords sound clear.
- **Fifths and octaves** add movement without changing the harmony.
- **Passing notes** (scale notes between two roots) lead into the next chord. Save them for the end of a phrase.
- **Short versus long.** Short notes feel bouncy (house, afrobeats); long notes feel heavy (trap, dubstep).

## Lock it to the kick

The kick and bass share the low end, so they must agree:

- Start bass notes **with** the kick, or put them clearly **between** kicks. Two long low notes on top of each other turn to mud.
- In house and techno the bass sits on the **offbeats**, between the four-on-the-floor kicks.
- Make the bass **duck** a few dB under each kick with a sidechain. The [[guide:compression|Compression and sidechain]] guide shows how.

## The Krypt 808

The **Krypt 808** instrument is a tuned sine body with a pitch sweep at the start:

| Control | What it does |
|---|---|
| **Tune** | Shifts the whole instrument in semitones |
| **Decay** | How long the tail rings |
| **Punch (pitch sweep)** and **Punch decay** | The fast pitch drop at the start: more punch, more "knock" |
| **Click** | A short transient so it cuts through |
| **Drive** | Saturation; adds harmonics phones can play |
| **Tone** | Darker or brighter |
| **Note length** | **One-shot** rings for the full Decay; **Gate** stops at the end of the note |

It plays at true pitch: **C2 is 65.4 Hz**. Write 808 lines between about C1 and C3. In the Channel Rack's step grid an 808 channel plays C2; use the Piano Roll for real basslines.

New projects already have an **808** channel. The preset browser has more, like "Clean 808", "Distorted 808", "Long 808" and "Drill Slide 808".

## Glides

A **glide** (slide) bends the pitch from one note into the next. It is the signature of trap and drill 808s.

- In the channel's plugin window, under **Voice**: **Mono** on and some **Glide** time. Overlapping notes then slide. New 808 channels start in mono with a 60 ms glide; 60–150 ms is the usual range.
- In the Piano Roll, the **slide** toggle in the toolbar makes new notes glide from the previous note. **Tools ▸ Slide on / off** sets it on selected notes. On the Krypt 808, slide notes always glide.
- Use glides as punctuation: a slide up to the octave or the 5th at the end of a phrase, then back to the root.

## Tune it to the key

An 808 in the wrong key makes the whole track feel off, even when nobody can say why.

- **Krypt 808:** play the right notes. The root of your key should be the 808's main note.
- **Sampled 808s:** the Browser shows the root note of tonal sounds. In the channel's plugin window, set **Root key** (under **Channel**) to that note, and the sample plays at the pitch you write.
- **Tuned kicks:** a kick sample with a clear pitch can clash with the 808. Use the channel's **Pitch** knob to move it onto the root or the 5th.

Note frequencies help when choosing an octave:

| Note | E1 | F1 | F#1 | G1 | A1 | B1 | C2 |
|---|---|---|---|---|---|---|---|
| Hz | 41.2 | 43.7 | 46.2 | 49.0 | 55.0 | 61.7 | 65.4 |

Below about 40 Hz many speakers give up. If the 808 vanishes on the root, move the line up an octave.

## Sub and mid bass

| Band | Range | What it does | Who hears it |
|---|---|---|---|
| Sub | under 60 Hz | weight you feel | headphones, cars, clubs |
| Low | 60–250 Hz | the note and the punch | most speakers |
| Low mids and up | 250 Hz–1 kHz | the harmonics that carry the bassline | phones and laptops too |

A clean sine 808 is pure sub, so it disappears on a phone. Add **Drive** on the 808, or a **Krypt Drive** on its insert, so its harmonics carry the line. In bass music the job is often split: a clean **sub** (the "Pure Sub" or "Warm Sub" presets) under a growling **mid bass** that is high-passed above it.

- Keep everything under about 150 Hz **mono**: put **Krypt Imager** on the bass with **Low width** at 0 %.
- Only the kick and the bass live down there. High-pass everything else (see [[guide:eq|EQ]]).
- No reverb on the 808 or the sub.

## Write an 808 line

1. Select the **808** channel and open the Piano Roll ([[F7]]). Turn on **Ghost notes** to see the kick.
2. Set the **Scale highlight** to your key.
3. Put a long root note on the first kick of the bar. Add short repeats on the other kicks.
4. Turn on **slide** and add a note at the end of the phrase that glides up to the octave.
5. In the Mixer ([[F9]]), right-click the 808's insert ▸ **Load chain…** ▸ **808 Grit** for saturation that phones can hear, then sidechain it to the kick.

> **Ask the AI:** "make the 808 glide up an octave into the hook" or "sidechain the 808 to the kick". Agents write slides with the same slide flag and set up the duck with \`sidechain\`.
`,
  },
  {
    id: 'drums',
    title: 'Drum programming',
    summary: 'Kick and snare placement for each feel, hats, ghost notes, velocity and groove in the step sequencer and Piano Roll.',
    group: 'Music basics',
    icon: 'drum',
    body: `
Drums decide the genre faster than anything else. The same chords become house, trap or boom bap depending on where the kick and snare land. Start with the skeleton, then add life.

## The skeleton: kick and snare

| Feel | Kick | Snare or clap | Genres |
|---|---|---|---|
| Backbeat | 1 and 3, plus pickups (steps 1, 9) | 2 and 4 (steps 5, 13) | boom bap, pop, synthwave |
| Four on the floor | every beat (1, 5, 9, 13) | 2 and 4 | house, techno, EDM |
| Half-time | 1, plus syncopated hits that start 808 notes | beat 3 (step 9) | trap, drill, dubstep, future bass |
| Two-step | 1 and the "and" of 3 (steps 1, 11) | 2 and 4 | drum & bass |
| Dembow | every beat | steps 4, 7, 12 and 15 | reggaeton |
| Afro bounce | 1, the "and" of 2, 3 and a pickup | a rim pattern against the kick | afrobeats |

Steps count 16ths: see [[guide:rhythm-tempo#bars-beats-and-steps|Rhythm and tempo]]. Get these right first. A clap on 2 and 4 at 140 BPM is a fast pop beat, not trap, however good the sounds are.

## Hats

Hats carry the speed and the energy:

- **8ths** feel relaxed, **16ths** drive, **32nd rolls** and **triplet bursts** add excitement (trap, drill).
- An **open hat on every offbeat** (steps 3, 7, 11, 15) is the house pulse.
- **Choke** the open hat with the closed one, as a real hi-hat does: in each hat channel's plugin window, under **Voice**, give them the same **Cut group** and **Cut by**. New projects' **Hat** channel already uses 1 for both.
- Drop the hats for a beat before a big moment. Silence is a drum hit too.

## Velocity and ghost notes

Hits at one level sound like a machine gun. Real drummers play some notes louder:

- **Accent the beats**, play the off-16ths softer.
- **Ghost notes** are very quiet snare hits (velocity around 40–60 %) just before or after the backbeat. They make boom bap, R&B and drum & bass roll.
- Ramp velocity up through a snare roll so it builds.

\`review_song\` flags hats whose velocities barely change.

## Groove

**Swing** delays every second 16th (see [[guide:rhythm-tempo#swing|swing]]). **Groove templates** go further: they move each step and change its loudness the way real drummers play. In the Piano Roll, **Tools ▸ Groove** offers **Hip hop**, **Funk**, **Soul**, **Jazz**, **Shuffle**, **Latin**, **Reggae**, **Afrobeat**, **Rock**, **Pop** and **Dance**, taken from recordings of real drummers (the Groove MIDI Dataset).

- Trap, drill, EDM: groove the **hats** only. Keep the kick and clap tight.
- Boom bap, lo-fi, R&B, afrobeats: groove the **whole kit**, and often the bass and keys too.

## Fills and variation

A 2-bar loop for 16 bars sounds stuck. Every 4 or 8 bars, change something in the last bar: a snare fill, a hat roll, a missing kick, an open hat. The Browser's **Factory sounds** have fills and crashes too. More on this in [[guide:transitions|Transitions]].

## Program a beat in Krypt Studio

1. Open the Channel Rack ([[F6]]). New projects already have **Kick**, **Clap**, **Hat**, **Snare** and **808**. For other drums, add a channel and pick from the preset browser (try "Trap Hat", "Dusty Snare" or "Big Clap"), or drag a sound from **Factory sounds** in the Browser.
2. Click steps to place hits. **Shift+click** gives a step an accent. Right-click erases.
3. For a steady hat, right-click the channel's name ▸ **Fill** ▸ **Fill each 2 steps**. **Fill each 4 steps, from step 3** gives you the offbeat open hat.
4. Click **Vel** in the header and drag across the lane to shape the hat's velocities.
5. For rolls and triplets, open the hat in the Piano Roll ([[F7]]): set **Snap** to **1/8 beat** for 32nds or **1/6 beat** for 16th triplets, or draw a note and use **Tools ▸ Chop…** ([[Alt+U]]) ▸ **Equal pieces**.
6. Select the hat notes and pick **Tools ▸ Groove ▸ Hip hop** (or the template for your genre).
7. Make a variation: the pattern picker's copy button clones the active pattern. Change the last bar of the clone.

[[show:channelRack.steps|Show me the step grid]] [[show:channelRack.patterns|Show me the pattern picker]]

> Layer two sounds for a fat snare: a snare and a clap on the same step, the second one a few dB quieter. Route both to a **Drum Bus** insert and load the **Punchy Glue** chain on it. See [[guide:compression|Compression and sidechain]].

> **Ask the AI:** "make the hats bouncier", "add a hat roll before every hook" or "put a fill at the end of every 8 bars". Agents write the pattern and apply the genre's groove template.
`,
  },
  {
    id: 'sound-design',
    title: 'Sound design basics',
    summary: 'Oscillators, filters, envelopes and LFOs, and how to shape them with the stock synths.',
    group: 'Music basics',
    icon: 'sparkles',
    body: `
Every synth sound is built from a few blocks: something that makes a tone, something that removes part of it, and something that shapes it over time. Learn the blocks once and you can read any synth.

## Oscillators: the raw tone

An **oscillator** makes a repeating wave. Its shape decides the character:

| Wave | Sounds like | Use it for |
|---|---|---|
| Sine | pure, round, no harmonics | sub bass, 808s, soft leads |
| Triangle | soft, a little hollow | flutes, gentle plucks, subs with a bit of edge |
| Saw | bright and buzzy, full of harmonics | leads, pads, supersaws, basses |
| Square / pulse | hollow, woody, retro | game sounds, reeds, synthwave basses |
| Noise | hiss, no pitch | hats, risers, breath, texture |

Two oscillators **detuned** a few cents apart beat against each other and sound wider. Many detuned voices at once (**unison**) give the huge "supersaw" sound.

## Filters: remove what you don't want

A **filter** cuts part of the sound:

- **Low pass** removes highs: darker, softer, further away. The most used filter.
- **High pass** removes lows: thinner, makes room for the bass.
- **Band pass** keeps a slice: telephone or radio sounds.
- **Notch** removes a slice.

**Cutoff** is where the filter starts working. **Resonance** boosts the area around the cutoff, from a gentle lift to a whistle. **Key tracking** opens the filter as you play higher, so high notes don't sound duller than low ones.

## Envelopes: shape over time

An **envelope** describes how something changes from the moment you press a key: **Attack** (rise), **Decay** (fall to the sustain level), **Sustain** (the level while held), **Release** (fade after you let go).

| Sound | Attack | Decay | Sustain | Release |
|---|---|---|---|---|
| Pluck | 0–5 ms | 150–400 ms | 0 % | short |
| Pad | 300–1500 ms | long | high | 1–3 s |
| Lead | 1–20 ms | medium | 60–90 % | 100–300 ms |
| Bass | 0–5 ms | medium | high | short |

A **filter envelope** does the same to the cutoff: a quick decay on the filter makes a pluck "bloom" then close.

## LFOs: movement

An **LFO** is a slow oscillator that moves a control up and down by itself: the cutoff for a wobble, the pitch for vibrato, the volume for a pulse. Sync it to the tempo and the movement stays in time.

## The stock synths

| Instrument | Best for | Blocks |
|---|---|---|
| **Krypt TriOsc** | basses, leads, pads, plucks; the default for new melodic channels | three oscillators (Sine, Triangle, Saw, Square, Pulse 25%, Noise), Detune spread, Analog drift, filter, amp and filter envelopes |
| **Krypt Wave** | supersaws, evolving pads, growls, moving textures | five wavetables with **Position**, up to 8 unison voices, a sub oscillator, filter, two envelopes, an LFO |
| **Krypt FM** | electric pianos, bells, metallic plucks, FM basses | four operators, 8 algorithms, filter, vibrato |
| **Krypt 808** | 808s and tuned kicks | see [[guide:bass-808|Bass and 808s]] |
| **Krypt DrumSynth** | drums without samples | kick, snare, clap, hats, tom, rim, cowbell, crash, perc |
| **Krypt Sampler** | any sample | envelope, filter, pitch envelope, reverse, loop |

Krypt TriOsc has no LFO. For movement on a TriOsc sound, use an effect with one (**Krypt Filter**, **Krypt Chorus**, **Krypt Phaser**), **Krypt Duck** in Tempo shape mode for rhythmic pumping, or an automation clip. On Krypt Wave, the **LFO** section can move the Position, the Cutoff or the pitch (**Vibrato**), free or in time.

Every instrument's controls are in its plugin window: click the channel's name in the Channel Rack. **Reset** at the top of the controls puts them all back to default, as one undo step.

## Three recipes

### A pluck on Krypt TriOsc

1. Osc 1 and Osc 2 on **Saw** (Osc 2 is already detuned a few cents). Turn Osc 3's **Level** down.
2. Amp envelope: **Attack** 1 ms, **Decay** 250 ms, **Sustain** 0, **Release** 150 ms.
3. Filter **Low pass**, **Cutoff** about 1.5 kHz, a little **Resonance**.
4. Filter envelope: **Amount** up to about +50 %, **Decay** about 200 ms. Each note now opens bright and closes fast.

### A supersaw on Krypt Wave

1. Turn **Voices** up to 7 or 8, **Detune** to about 35 %, **Stereo spread** to full.
2. Move **Position** until the sound is bright and buzzy.
3. Amp envelope **Attack** 5 ms, **Release** 300 ms. Cutoff fairly open.
4. On its mixer insert, add **Krypt Duck** for the pump, and send it to a reverb (see [[guide:space|Space]]).

### A sub on Krypt TriOsc

1. Osc 1 **Sine**; turn Osc 2 and Osc 3 **Level** to 0.
2. **Detune spread** and **Analog drift** to 0, so it stays steady and mono.
3. Amp **Attack** 2 ms, **Sustain** full, **Release** 80 ms.
4. In the plugin window under **Voice**, **Mono** on with a short **Glide**.

## Start from a preset

You don't have to start from nothing. Load a preset close to what you want with the **preset bar** in the plugin window, then change one block at a time: the filter for brightness, the envelope for length, the unison for width. A pink dot shows you changed it; **Save…** keeps your version. See [[guide:sounds-presets|Sounds & presets]].

> **Ask the AI:** "make this lead darker and wider" or "give me a dark pluck for future bass". Agents pick presets by role and genre and change knobs in plain units (\`set_params\` with values like "1.2kHz" or "-6dB").
`,
  },
];
