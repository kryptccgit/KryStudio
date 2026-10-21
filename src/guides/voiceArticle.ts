// The Krypt Voice guide (research/21): text → a voice clip, Sing my notes, local vs cloud, tags, Krypt Tune, the
// own-voice rule and the honest limits. Kept in its own file; articles.ts lists it in the AI and audio group. Pure data.
// Every label here matches src/voice/* and the piano roll toolbar.

import type { GuideArticle } from './articles';

export const VOICE_ARTICLE: GuideArticle = {
  id: 'krypt-voice',
  title: 'Krypt Voice',
  summary: 'Type it and a voice says it in your song, or type lyrics and Sing my notes puts them on your melody. Local or cloud, honestly labelled.',
  group: 'AI and audio',
  icon: 'vocal',
  body: `
**Krypt Voice** turns text into a voice clip in your song: ad-libs, tags, a radio-style intro, a spoken hook, a guide vocal to write over. **Sing my notes** in the Piano Roll goes one step further: type lyrics and a voice sings them on the melody you drew.

[[action:kryptVoice|Open Krypt Voice…]] [[show:home.kryptVoice|Show me the card]] [[show:voice.sing|Show me Sing my notes]]

{{video:voice}}

## Open it

- **Tools ▸ Krypt Voice…** in the title bar.
- **Home ▸ Audio Tools ▸ Krypt Voice**.
- Right-click the Playlist ruler ▸ **Add a voice here…** puts it at that bar. Right-click a track name ▸ **Add a voice here…** puts it on that track.
- In the Piano Roll, the microphone button in the toolbar (or **Tools ▸ Sing my notes…**) opens Sing my notes.

## Local or cloud

There are two kinds of voices. Krypt always tells you which one you picked.

| | Local (Kokoro) | Cloud (Fish Audio) |
|---|---|---|
| Where it runs | On your PC | On Fish Audio's servers |
| What leaves your PC | Nothing | Your text (and for My voice, your recording) |
| Cost | Free, works offline | Your own key; their developer tier is free for now |
| Quality | Clear and quick | More natural, with emotion tags |
| Tags like [whisper] | Skipped | Yes |
| Your own voice | No | Yes (My voice) |

**Local voices** need the Kokoro model once: open the Model Manager and install it. After that they work offline, and English comes first.

**Cloud voices** use your own Fish Audio key. Get one free at fish.audio, then paste it in **Settings ▸ Voice**. Krypt checks the key with a tiny request and stores it encrypted on this PC. Every cloud voice carries a **Cloud** badge.

!> Fish Audio receives your text and, for My voice, your recording. They may use requests to improve their models. The free tier ends on the date Fish Audio sets; after that it's their paid plan or the local voices.

[[show:settings.voice|Show me Settings ▸ Voice]] [[action:modelManager|Open the Model Manager]]

## Make a clip

1. Type what the voice says in the text box. The counter shows how much room is left in one clip. [[show:voice.text|Show me]]
2. Pick a voice. The list is grouped into **Local**, **Cloud** and **My voice**. A group you can't use yet says why, with the button that fixes it. [[show:voice.voices|Show me]]
3. Set the **Speed** and, if you want the tuned sound, **Krypt Tune**.
4. **Preview** renders it and plays it without touching your song. [[show:voice.preview|Show me]]
5. **Add to song** puts it on the Playlist as an audio clip: at the playhead on a new track, or at the bar and track you choose. [[show:voice.add|Show me]]

The clip is one undo step. It's normal audio, so you can cut it, move it, add effects and mix it.

## Tags (cloud voices)

With a Cloud voice, chips like **[whisper]**, **[excited]**, **[laughing]** and **[shouting]** appear under the text box. Click one to insert it at the cursor: the words after it are said that way.

> Yo [whisper] keep it quiet [excited] then drop it!

Local voices don't understand tags, so Krypt leaves them out instead of reading them aloud. [[show:voice.tags|Show me the tags]]

## Sing my notes

Draw or record a melody in the Piano Roll, then click **Sing my notes**. Type the lyrics: Krypt splits them into syllables and shows each one above the note it lands on, before anything is rendered. [[show:sing.lyrics|Show me the lyrics box]]

| Type | What it does |
|---|---|
| \`hold me close\` | One syllable per note, in order |
| \`to-night\` | Splits a word where you want (overrides Krypt's guess) |
| \`fly_\` | Holds "fly" over one more note; add more \`_\` for more notes |
| \`_\` on its own | Holds the previous syllable over the next note |

- Extra notes hold the last syllable. Extra syllables squeeze onto the last note, and the panel says so: add notes or trim the lyrics.
- The roll uses the top note when notes overlap, so chords are sung by their highest note.
- **Octave** moves the melody for the voice: −1 suits a low voice on a high lead line.
- **Vibrato** and **Glide** make it less robotic. **Krypt Tune** is set to **Hard** by default: that's the tuned vocal sound.

After a render, the labels on the roll show where each syllable really landed, and the panel lists them. [[show:sing.add|Show me Add to song]]

## Krypt Tune for the tuned sound

Krypt Tune snaps the voice to the song's key. **Hard** is the instant, robotic sound. **Pop** is tight but smoother, and **Natural** keeps more of the voice. It goes first on the clip's mixer insert, so you can change the style or turn it off there later. More in [[guide:vocals|Vocals, tuning & mashups]].

## My voice: only your own

With a Fish key you can make a Cloud voice from **your own voice**:

1. **Settings ▸ Voice ▸ Record my voice…** (or the button under My voice in the voice list).
2. Read the consent line out loud, then the short passage. It takes about 30 seconds. [[show:voice.record|Show me what to read]]
3. Krypt records it with the normal recorder, from your microphone, right then. There is no file upload.
4. Tick the consent box, name the voice, and click **Make my voice**.

!> Only ever record and clone your own voice. Cloning someone else's voice without their permission is not allowed, and Krypt only accepts a live recording made in the app.

Your voice is stored as a private voice on your Fish Audio account. **Remove** in Settings ▸ Voice deletes it there and here. Clips you already made stay in your songs.

## Agents

Connected agents can use \`generate_voice\`, \`sing_notes\` and \`list_voices\`, for example "add a whispered 'Krypt' tag at bar 9". They can't set your Fish key or clone a voice: only you can.

## Good to know

- Speech voices aren't trained singers. Sing my notes speaks the lyrics, then stretches and pitches each syllable onto your notes. It's great for guide vocals, hooks with Krypt Tune and robotic effects, but it won't sound like a real singer.
- Short phrases sound better than one long block: split a long intro into a few clips.
- Speed changes the delivery before rendering. To fit a clip to the beat afterwards, stretch it on the Playlist like any audio.
- Renders are cached, so previewing the same text with the same voice twice is instant.
`,
};
