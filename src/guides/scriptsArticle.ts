import type { GuideArticle } from './articles';

export const SCRIPTS_ARTICLE: GuideArticle = {
  id: 'scripts',
  title: 'Scripts: make your own note devices',
  summary: 'Small JavaScript devices that write or reshape notes: use the factory ones, let the AI write one, or write your own.',
  group: 'Make music',
  icon: 'sparkles',
  body: `
A **script** is a small note device written in JavaScript. A **generator** writes notes into bars of a pattern (a Euclidean rhythm, a melody). A **transform** changes notes that are already there (strum a chord, arpeggiate it, add ratchets). Each script has its own knobs.

Scripts run in a sealed sandbox inside Krypt Studio. A script can't open files, reach the internet or start other programs, and one that runs too long or uses too much memory is stopped. Its notes are checked before anything is written, and every run is one undo step.

## Run a script

1. Open a pattern in the **Piano Roll** and pick a channel.
2. Click the **Scripts** button in the toolbar (the braces), or **Tools** ▸ **Scripts…**. [[show:pianoRoll.scripts|Show me]]
3. Pick a script in the list: this project's scripts come first, then your library, then the factory scripts. [[show:scripts.picker|Show me]]
4. Turn its knobs. The result is drawn on the roll right away, outlined, and the notes it replaces are hidden. [[show:scripts.params|Show me]]
5. Press **Apply**. Undo takes the whole run back.

A transform works on the selected notes, or on all the notes of the channel in the bars you set. A generator fills the bars: **Replace** rewrites the channel's notes there, **Merge** adds to them.

The **seed** makes a run repeatable: the same seed gives the same notes, and **Re-roll** gives a new take. **Variations** shows four takes side by side; click one to apply it. [[show:scripts.variations|Show me]]

## The factory scripts

| Script | Kind | What it does |
|---|---|---|
| Euclid with probability | generator | Even hits over the steps; each hit after the first plays with a probability |
| Markov melody | generator | A melody in the key that mostly steps, sometimes leaps, lands on chord tones and comes home at the end of each phrase |
| Arpeggiator | transform | Turns held chords into arpeggios: up, down, up-down, thumb, pinky, converge or random, over 1 to 4 octaves |
| Strum and humanize | transform | Strums chords down or up like a guitar and loosens the timing and the velocity |
| Ratchet | transform | Repeats notes in fast bursts with a velocity ramp |
| Velocity shaper | transform | Curves the velocities (ramp, swell, dip), adds accents on the beat, evens them out |

## Let the AI write one

Ask your agent for the device you want: "write a script that doubles every note an octave up, but only on the off-beats, with a knob for how often". It uses \`write_script\`, gets any errors back with their line numbers, fixes them, and saves the script into your project. It shows up in the Scripts list. The agent can also run any script with \`run_script\`, or do a dry run first to look at the notes.

## Write your own

Click **Code** to see the JavaScript of the selected script. [[show:scripts.code|Show me]]

- Edit it and the preview follows your changes. **Check** tests the header, the syntax and one trial run. Problems are listed under the code with their line number; click one to jump to the line.
- **Save to project** keeps the script in this song, so it travels with the project file. **Save to my library** keeps it for every project. Type a name in **Save as** to save a copy under another name.
- **New** starts from a small example. **Library folder** opens the folder where your library scripts are kept, one \`.js\` file each.

The top of a script is its header, one \`// @\` line each:

- \`// @name Octave doubler\`
- \`// @kind transform\` (or \`generator\`)
- \`// @description One line about what it does.\`
- \`// @param chance number 0.5 0..1 step 0.05 "Chance"\` becomes a knob.
- \`// @param style choice up up|down|random "Style"\` becomes a choice.
- \`// @param keep toggle on "Keep the originals"\` becomes a switch.

Below it, one function \`run(ctx)\` returns the notes. Each note is \`{ tick, dur, key, vel }\`: ticks at 960 per beat, \`key\` is the MIDI note (60 is middle C) and \`vel\` goes from 0 to 1.

\`ctx\` holds what you need:

- \`notes\`: the notes the script works on. \`params\`: the knob values.
- \`key\`, \`scale\`, \`scaleSteps\`, \`keyName\`, \`bpm\`, \`timeSig\`, \`barTicks\`, \`beatTicks\`, \`stepTicks\`, \`start\`, \`end\`, \`bars\` and \`chords\` (the chords in the pattern).
- \`rand()\`: a random number that follows the seed, with \`rand.int\`, \`rand.range\`, \`rand.chance\`, \`rand.pick\` and \`rand.shuffle\`.
- Helpers: \`inScale(key)\`, \`snap(key)\` (the nearest note in the key), \`degree(step, octave)\`, \`euclid(pulses, steps)\`, \`chordAt(tick)\` and \`log(…)\` (its last line shows at the bottom of the dialog).

> Open a factory script in the code view and change it: each one is a short, working example.

!> A script can write at most 4096 notes per run, and runs for at most a fifth of a second. Values out of range are clamped: a key above 127 becomes 127.
`,
};
