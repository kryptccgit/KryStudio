// Start here (step by step) · 6: master a finished song, then an album (research/23 §3). Every label is the one
// on screen: Home ▸ Audio Tools' Master a song card (src/home/screens/AudioToolsScreen.tsx), the Master a song dialog (src/automix/AutoMixDialog.tsx,
// target 'file'), the preset names and loudness targets (shared/automix/presets.ts), the Export audio window.

import type { GuideArticle } from '../articles';

export const MASTER: GuideArticle = {
  id: 'step-master',
  title: 'Master your song (step by step)',
  summary: 'Make a finished song sound polished and loud enough to share: pick a style or a song you love, listen before and after, export. Free, on your PC.',
  group: 'Start here (step by step)',
  icon: 'sparkles',
  body: `
**Mastering** is the last polish on a finished song: it balances the bass and treble and makes it loud enough to share, without breaking it. Krypt Studio does it for free, on your PC. Nothing is uploaded.

> Rather be shown? [[action:tourMaster|Start the tour: master a song]]

You need your finished song as one audio file: **WAV**, **MP3**, **M4A** or **FLAC**. Made it in Krypt Studio? Export it first, as shown in [[guide:step-save-export]].

## 1. Open Master a song

1. Press [[Ctrl+Shift+H]] to go to Home. Or click the little **house** button (top-left, next to **File**).
2. Click the **Audio Tools** card. [[show:home.audioTools|Show me]]
3. On the **Master a song** card, click **Master a song…**. [[show:home.masterSong|Show me]] The **Master a song** window opens, with three numbered steps.

[[action:masterSong|Open Master a song]]

## 2. Choose your song

The window has three numbered steps. Step 1 is your own song: the one you want to master.

1. Under **1 Your song**, click **Choose your song…**. A Windows file window opens. [[show:automix.song|Show me]]
2. Find your song, click it, then click **Open**. Or drag the file from Windows Explorer onto step 1.
3. Step 1 now shows your song's name and length, with a green tick. Nothing has been mastered yet.

{{image:master-song.webp|Step 1 before and after: Choose your song… (1), then your song's name and length (2) with Change… (3).}}

Picked the wrong file? Click **Change…** next to it.

## 3. Pick a style

A **style** (a preset) is a ready-made sound: how loud, and how much bass and treble. Each card shows its loudness in **LUFS** (a loudness number: closer to 0 is louder).

1. Under **2 Pick a style**, click the card that fits your song. Not sure? Leave **Auto** picked: Krypt listens to the song and chooses.

| Preset | Loudness | Pick it for |
|---|---|---|
| **Auto** | It decides | Not sure: Krypt picks the best fit from what it hears |
| **Streaming Clean** | −14 LUFS | Natural and open, at the level streaming apps play at |
| **Balanced** | −11 LUFS | A safe all-rounder for any style |
| **Loud Trap / Drill** | −8 LUFS | Hard 808s and kick, dry vocals on top |
| **Club / EDM** | −8 LUFS | Big, bright and wide, for the club |
| **Warm R&B** | −11 LUFS | Smooth and warm, with a soft top |
| **Lo-fi** | −13 LUFS | Dusty, warm and quiet on purpose |
| **Pop Polish** | −9 LUFS | Clean and bright, the vocal in front |
| **Hip-Hop Punch** | −9 LUFS | Drums that crack, the rap up front |
| **Rock / Live** | −10 LUFS | Bands and live takes, natural and punchy |
| **Podcast / Voice** | −16 LUFS | Clear, even speech |
| **Phonk Slam** | −7 LUFS | Gritty and as loud as it gets |

{{image:master-presets.webp|Step 2: Auto (1) lets Krypt choose; a style you click (2) lights up.}}

2. Optional: click **More options** (under step 3). In the box under **Describe it (optional)**, type what you want in plain words, like \`warmer\` or \`loud for the club\`. A line under it says how Krypt understood you.

## 4. Make it sound like a song you love (optional)

A **reference song** is someone else's finished song whose sound you like. Krypt measures its loudness and its bass and treble, and aims your song at them. It only measures it: nothing from that song ends up in yours.

1. Click **Sound like a song you love (optional)** (step 3). It opens. [[show:automix.reference|Show me]]
2. Click **Pick a reference song…** and choose the song you love. Or drag the file onto the row.
3. Wait a moment: it says **Measuring its loudness and tone…**, then shows the song's loudness and tone in one line.
4. Step 2's title now reads **Matching:** and the song's name. A style you click still adds its own character on top (punch, warmth, glue).

{{image:master-reference.webp|A reference song picked (1), its loudness and tone (2), and step 2 now reading Matching: and its name (3).}}

> Don't pick your own song here: it would match itself. If you do, the row says **That's your own song — pick a different one to match** and it isn't used.

To remove the reference, click the **×** at the end of the row.

## 5. Master it

1. Click **Master my song** (bottom-right of the window). [[show:automix.run|Show me]]

{{image:master-run.webp|The bottom of the window: Master my song (1) and the line next to it (2).}}

2. Watch the list: it ticks off each step with your song's name: measuring, tone EQ, glue, width, loudness, checking. It takes a few seconds. **Cancel** stops it.

> The button is greyed out? The line next to it says why, for example **Choose your song first**.

Your song opens in a **new tab** at the top, so the project you had open stays safe in its own tab. Your original file is never changed.

## 6. Listen: Before and After

{{image:master-result.webp|The result: Done! with the loudness before and after (1), Compare: Before / After (2), Keep (3), Export… (4) and Details (5).}}

When it's done, the window says **Done!** with your song's name and its loudness before and after, for example "−13.6 → −9.7 LUFS, no clipping". Under **What to do next** are three numbered steps.

1. Step 1: press **Play**, then under **Compare** click **Before**, then **After**, and listen to the difference. Switch a few times. [[show:automix.ab|Show me]]
2. Used a reference song? Click **Reference** next to them: it plays that song turned to the same loudness, so you compare the sound, not the volume. **Before** or **After** stops it.

> **Louder always sounds better at first.** After is usually louder, and the window says by how much. Turn your speakers down a little while After plays, so you judge the sound and not the volume.

Curious about the numbers? Click **Details**: the loudness and peaks before and after, a tone chart, and what changed.

## 7. Keep it

1. Like it? Click **Keep** (step 2 under **What to do next**).
2. Don't like it? Click **Undo** next to it, then **Master another** (bottom-left) to try a different style.

> Every knob it set is a normal setting. The whole master is one step in **Edit ▸ History**, so you can still undo it later.

## 8. Export the mastered song

1. Click **Export…** (step 3). The **Export audio** window opens, already set up for the whole song.
2. Next to **Format**, pick **24-bit** for a WAV, or **MP3** for a smaller file.
3. Click **Export…** (bottom-right).
4. Choose a folder and a name, then click **Save**.

{{image:export-dialog.webp|The Export audio window: what to render (1), the file type (2), and the Export… button (3).}}

> **Normalize** is switched off for you here: it would push the loudest moments past the safe limit Krypt just set.

Want to come back to it later? Press [[Ctrl+S]] to save the mastered song as a project too.

## Master an album

An **album** (or an EP) is several songs that should sound like one record. Master them together, not one by one: Krypt keeps their tone close and their loudness in the right order. The window has the same numbered steps.

1. On Home ▸ **Audio Tools**, on the **Master a song** card, click **Master an album…**. [[show:home.masterSong|Show me]]
2. Step 1: click **Choose your songs…**. Hold [[Ctrl]] and click each song (2 to 20), then click **Open**.
3. Put the songs in album order with the up and down arrows.
4. Step 2: pick one style for the whole album. Optional, step 3: one reference song.
5. Optional: under **More options**, leave **Keep the album's dynamics** on. The loudest song hits the target, and quiet songs (an intro, a slow song) stay a little quieter, like on a real album.
6. Click **Master my album** and wait. All the songs open in one new tab, one after another, with a marker on each.

{{image:master-album.webp|The Master an album window: your songs in album order (1), one style for all of them (2), and Master my album (3).}}

7. Under **What to do next**: press ▶ on a song and switch **Before** / **After**. Listen to a few.
8. Click **Keep** for the whole album, or **Undo** to take it all back.
9. Click **Export all…** and pick a folder: you get one file per song, named like \`My song (mastered).wav\`.

## Help: it's too quiet, or it stopped before the target

Krypt stops making it louder before your song starts to distort, and says so under **Good to know**, for example "Loudness capped at −9.2 LUFS: reaching −8 would distort". Past that point the drums lose their punch and loud moments crackle.

It happens when:

- the song has a lot of deep bass (808s, sub bass): it uses up the room first;
- the song is already squashed, with no quiet and loud moments left;
- the reference song is louder than your song can go cleanly. The note says so, for example "The reference is −6 LUFS; your song starts to distort past −8.5 LUFS, so it stopped there."

What to do:

1. Often nothing. Streaming apps turn loud songs down to about −14 LUFS anyway, so a little less loud doesn't matter there.
2. Made it in Krypt Studio? Open the **Mixer** ([[F9]]), turn the bass and the kick down a little, export again and master again.
3. Raising **Target loudness** doesn't help: the same safety limit applies.

## Help: it sounds different on my phone

That's normal. Phone and laptop speakers can't play deep bass, so the 808 and the kick's boom mostly disappear. Your master is fine: the speaker is small.

1. Listen on three things: headphones, your phone, and a car or a speaker.
2. Krypt keeps the bass in **mono** (the same on left and right), so it doesn't vanish on one side.
3. If the bass is gone on the phone, the bass sound itself needs a little more "click" or upper tone. Change that in your project, export and master again.
4. Comparing with songs in a streaming app? Those apps turn loud songs down, so match the volume by ear before you judge.

## Help: it asked me for a song twice

It shouldn't any more. Step 1, **Choose your song…**, is your song. Step 3, **Pick a reference song…**, is optional and is a different song you want yours to sound like. Skip step 3 if you don't have one.

## Help: nothing happened after the file window

Choosing your song never starts the mastering: step 1 only shows its name. Click **Master my song** to start. If you closed the file window without picking a song, step 1 is still empty: click **Choose your song…** again.

## More

Every option, and mastering a project from the Mixer: [[guide:auto-mix]]. What loudness really is: [[guide:mastering]].
`,
};
