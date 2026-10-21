import type { GuideArticle } from '../articles';

export const START: GuideArticle = {
  id: 'step-start',
  title: 'Open Krypt Studio and start a beat',
  summary: 'Click by click: the Home screen, a new project, and how to get back to Home.',
  group: 'Start here (step by step)',
  icon: 'rocket',
  body: `
New to all of this? Good: these step-by-step guides assume nothing. Each step is one click or one key. Do them in order.

> Rather be shown on screen? A **tour** points at each button for you. [[action:tourFirstBeat|Start the tour]] [[action:tours|All tours]]

## The Home screen

When Krypt Studio opens, you see **Home**: big cards, one for each thing you might want to do.

{{image:home-start.webp|Home: the Studio card (1) opens the music workspace; "Start in the Studio" (2) does the same.}}

1. Click the **Studio** card (the first card, top-left).

You are now in the **Studio**, where you make music. It opens with a ready drum kit, so you can start right away.

> Pressing [[Esc]] on Home also takes you to the Studio.

## Start a fresh project

A **project** is one song, saved as one file.

1. Press [[Ctrl+N]] on your keyboard. A new, empty project opens.
2. Or, on Home, click the **Projects** card, then **New project**.

{{image:projects-new.webp|Home ▸ Projects: click "New project" for a fresh beat with a drum kit.}}

A new project already has six sounds: Kick, Clap, Hat, Snare, 808 and Keys.

## Tabs: one per project

Each open project is a **tab** at the very top, like in a web browser.

{{image:titlebar.webp|The title bar: the Home button (1), your project's tab (2) and the + button for a new tab (3).}}

1. Click the **+** at the top, next to your tab, to start another project. [[show:titlebar.newTab|Show me]]
2. Click a tab to switch to that project. [[show:titlebar.tabs|Show me]]
3. Click the little **house** button (top-left, next to **File**) to see Home again. [[show:titlebar.home|Show me]]
4. Press [[Ctrl+Shift+H]] to go to Home and back.

## Next

Learn the windows and how to get them back: [[guide:step-windows]].
`,
};
