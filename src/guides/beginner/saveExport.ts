// Start here (step by step) · 5: save, open, export.
import type { GuideArticle } from '../articles';

export const SAVE_EXPORT: GuideArticle = {
  id: 'step-save-export',
  title: 'Save, open and export your song',
  summary: 'Save your project, open it again tomorrow, and turn it into a WAV or MP3 to share.',
  group: 'Start here (step by step)',
  icon: 'download',
  body: `
**Saving** keeps your project so you can keep working on it later. **Exporting** turns it into an audio file (WAV or MP3) that any music player can play.

{{image:menu-file.webp|The File menu: new and open (1), Save (2), and Export audio (3).}}

## Save your project

1. Press [[Ctrl+S]]. Or click **File** (top-left), then **Save**. [[show:titlebar.file|Show me]]
2. The first time, a window asks where to save. Pick a folder, for example **Documents**.
3. Type a name for your song.
4. Click **Save**. A message confirms it.

After that, [[Ctrl+S]] saves straight away, without asking. Save often.

> Projects are \`.kstudio\` files. If Krypt Studio or your PC crashes, your unsaved changes come back the next time you open it.

## Open a project again

1. Press [[Ctrl+O]], or click **File**, then **Open…**.
2. Find your \`.kstudio\` file and click **Open**.

Your last songs are also on Home:

1. Press [[Ctrl+Shift+H]] to go to Home.
2. Click the **Projects** card. Your recent songs are listed there: click **Open** next to one.

{{image:home-projects-card.webp|Home: the Projects card holds your recent songs, the demo, and New project.}}

> You can also double-click a \`.kstudio\` file in Windows Explorer.

## Export a WAV or MP3

**WAV** is full quality (big files). **MP3** is smaller and plays everywhere.

1. Press [[Ctrl+R]]. Or click **File**, then **Export audio…**. The **Export audio** window opens.
2. Next to **Render**, pick **Song** (the whole Playlist) or **Pattern** (just your loop).
3. Next to **Format**, pick **24-bit** for a WAV, or **MP3**.
4. Click **Export…** (bottom-right).
5. Choose a folder and a name, then click **Save**.

{{image:export-dialog.webp|The Export audio window: what to render (1), the file type (2), and the Export… button (3).}}

When it's done, a message tells you. With **Open the folder after export** ticked, the folder opens too, so you can find your file.

> Exporting **Song** but you only made a pattern? Put the pattern in the Playlist first (see [[guide:step-first-beat#5-turn-it-into-a-song|Turn it into a song]]), or pick **Pattern**.

## More

Every export option (stems, covers, loudness) is in [[guide:exporting]].

Make your exported song sound finished and loud enough to share: [[guide:step-master]].
`,
};
