// The KPN cheat sheet. One source for the write_pattern tool description, the
// krypt://docs/kpn resource, the built-in agent's system prompt and docs/MCP.md.
// Keep it stable: tool descriptions and the agent's cached prompt prefix embed it.

export const KPN_SHORT = [
  'KPN (Krypt Pattern Notation): one line per channel, bar lines are checked.',
  'Header: pattern "Name" bars=2 grid=16 [key=F#m] [ts=4/4]   (grid = steps per bar; 16 = 16th notes)',
  'Drum grid line:  kick: x... ..x. x... .... | x... ..x. .x.. x...',
  '  x hit (vel 100 or {vel=}), X accent 127, o ghost 50, 1-9 velocity n×14, . rest, - hold previous hit, _ clear step (merge mode), | bar check',
  '  hat/32: (x.x.)*8 | ...   (/32 = finer grid for this line; (...)*n repeats)   {pitch=D4} picks the key a hit plays',
  'Melodic line:  bass {oct=1 vel=90}: F#1:6 r:4 C#2:2 E2:4 | F#1:8~ C#1:4 r:4',
  '  C4 = middle C (MIDI 60). :n = length in grid steps (sticky until changed; default one beat). r / r:n = rest.',
  '  [C4 Eb4 G4]:8 explicit chord · Am7:16 Fmaj7 G/B Cdom7 chord symbols at {oct=} (default 4; G7 is the NOTE G7) ·',
  '  ^1..^7 scale degrees of key= (^b3 ^#4, ^5\' octave up, ^1, octave down) · v90 velocity, ! accent, ? ghost · ~ slide into next note ·',
  '  @3.1 jump to bar 3 step 1 · | bar check (notes may cross bars) · (...)*n repeat · // comment',
].join('\n');

export const KPN_REFERENCE = `# KPN — Krypt Pattern Notation v0.1

KPN writes a whole multi-channel pattern in a few lines. Krypt Studio checks
every bar line and tells you exactly which bar is off, so count steps per bar.

## Header (first line)

    pattern "<name>" bars=<n> grid=<steps per bar> [ts=4/4] [key=F#m]

- grid defaults to 16th-note steps (16 in 4/4, 12 in 3/4). One step = one grid cell.
- bars sets the pattern length. Grid lines must fill it exactly; note lines must not run past it.
- key= enables scale degrees (^1..^7) and out-of-key warnings. Examples: key=Am, key=F#m, key=Eb, key="D dorian".

## Channel lines

    <channel>[/<grid>] [{opt=value ...}] : <body>        // comment

- <channel> is a channel name or id (case-insensitive). Quote names with spaces: "Open Hat": x...
- /32 overrides the grid for this line (hat rolls). /12 or /24 = triplets.
- Options: oct=<-1..9> (octave for chord symbols and degrees, default 4), vel=<1..127> (default 100),
  pitch=<note> (key a drum hit plays, default C4 = the sampler root), len=<steps> (initial note length).
- Writing the same channel name on several lines continues it (long patterns).

## Drum (step grid) lines — characters only

| char | meaning |
|---|---|
| x | hit at the line velocity (100, or {vel=}) |
| X | accent (127) |
| o | ghost (50) |
| 1-9 | velocity n × 14 |
| . | rest |
| - | hold: lengthen the previous hit by one step |
| _ | clear this step (merge mode only; same as . otherwise) |
| \\| | bar check |
| (...)*n | repeat |

## Melodic (token) lines — whitespace-separated tokens

| token | meaning |
|---|---|
| C4 F#2 Bb3 | note (C4 = MIDI 60) |
| :n | length in grid steps, sticky until changed (default: one beat) |
| r  r:n | rest |
| [C4 Eb4 G4]:8 | chord with explicit voicing (per-note velocity: [C4 E4v80]) |
| Am7:16 Fmaj7 G/B Cdom7 | chord symbols (m, maj7, m7, dom7, dim, dim7, aug, sus2, sus4, add9, m9, maj9, m7b5, 6, m6, 11, 13) at {oct=} |
| ^1..^7 ^b3 ^#4 ^5' ^1, | scale degrees of key= (' = octave up, , = octave down) |
| v90  !  ? | velocity 1..127, accent (120), ghost (60) |
| ~ (suffix) | slide/glide into the next note (808 glides, legato synth slides) |
| @3.1 | jump to bar 3, step 1 |
| \\| | bar check: must fall on a bar boundary (notes may cross bars) |
| (...)*n | repeat |

A letter plus a digit is always a NOTE: G7 is the note G7 (MIDI 103). Write Gdom7 for the chord.

## Write modes (write_pattern)

- replace (default): each channel you write is replaced entirely; channels you don't mention are untouched.
- merge: grid lines set hits on x/X/o/digits, clear on _, and leave . untouched; note lines only add notes.
- append: the KPN is added after the current end of the pattern (extends it).

## Examples

    pattern "Trap A" bars=2 grid=16 key=F#m
    kick       : x... .... ..x. .... | x... .... .x.. ..x.
    snare      : .... X... .... X... | .... X... .... X..o
    hat/32     : (x.x.)*7 xxxx | (x.x.)*6 xxxx xxxx
    openhat    : .... .... .... ..o. | .... .... .... ....
    808 {oct=1}: F#1:6 r:4 C#2:2 E2:4 | F#1:8~ C#1:4 r:2 A1:2

    pattern "Verse Keys" bars=4 grid=16 key=Am
    chords {oct=3 vel=80}: Am7:16 | Fmaj7:16 | C:16 | G/B:16
    lead {oct=5}: ^5:4 ^3:2 ^1 ^2:4 ^3:4 | ^1:8 r:8 | r:4 ^5:2 ^6 ^5:4 ^3:4 | ^2:12 r:4

    pattern "Four on the floor" bars=1
    kick: x... x... x... x...
    hat : (..x.)*4
    clap: .... x... .... x...

## Errors you may get (fix and resend)

    kick : x... x... x.x x...      → line 2 (kick): 15 steps total, expected 16
    lead : C4:4 D4:4 E4:6 | F4:2   → line 3 (lead), bar 1: has 14/16 steps at the bar line (2 short)
`;
