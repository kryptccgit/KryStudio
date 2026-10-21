// Start here (step by step) · 6: set up AI (Claude Code, Claude Desktop, Cursor, VS Code, or the built-in chat).
import type { GuideArticle } from '../articles';

export const AI_SETUP: GuideArticle = {
  id: 'step-ai',
  title: 'Set up AI (pick one)',
  summary: 'Claude Code, Claude Desktop, Cursor, VS Code or the built-in chat with an API key: exact clicks, what to say first, and how to undo it all.',
  group: 'Start here (step by step)',
  icon: 'bot',
  body: `
An **AI agent** is an assistant like Claude that can work in your project: make beats, change sounds, mix. You type what you want in plain words, and you watch it happen. Everything it does can be undone.

> Rather be shown? [[action:tourAi|Start the tour: set up AI]]

## Which one should I pick?

Pick **one**. You only need one.

| You have | Pick | Costs |
|---|---|---|
| Claude Code (the terminal app) | **Claude Code** | Uses your Claude plan |
| The Claude app for Windows | **Claude Desktop** | Uses your Claude plan |
| Cursor | **Cursor** | Uses your Cursor plan |
| VS Code with GitHub Copilot | **VS Code** | Uses your Copilot plan |
| None of these | **The built-in chat** with an API key from Anthropic (Claude), OpenAI (ChatGPT) or OpenRouter | Pay per use |

> An **API key** is a password that lets Krypt Studio talk to an AI for you. Each message costs a little money, billed by the company the key is from. A ChatGPT or Claude subscription isn't an API key. Claude Code and Claude Desktop don't need one: they use your Claude subscription.

All the setup buttons are on one screen:

1. Press [[Ctrl+Shift+H]] to open **Home**.
2. Click the **AI Agents** card (top row, right).

{{image:ai-home-card.webp|Home: the AI Agents card.}}

## Claude Code

Install Claude Code first if you haven't.

1. On **Home ▸ AI Agents**, find the **Claude Code** card.
2. Click **Set up**. A message says "Added krypt-studio to Claude Code".

{{image:ai-setup-claude-code.webp|Home ▸ AI Agents: the Set up button on the Claude Code card.}}

3. Open a **new** Claude Code session (a new terminal window, then type \`claude\` and press [[Enter]]).
4. Type: \`Use krypt-studio to make a 2-bar beat at 140 BPM\` and press [[Enter]].

> The message says Claude Code isn't on your PATH? Click **Copy** on the same card, open a terminal, paste with [[Ctrl+V]] and press [[Enter]]. Then do step 3.

## Claude Desktop, Cursor or VS Code

{{image:ai-setup-others.webp|The Set up buttons for Claude Desktop (1), Cursor (2) and VS Code (3).}}

1. On **Home ▸ AI Agents**, click **Set up** on the card for your app.
2. **Restart that app** so it sees Krypt Studio:
   - **Claude Desktop:** fully quit it. Right-click its icon near the clock (bottom-right of Windows) and click **Quit**. Then open it again.
   - **Cursor** or **VS Code:** close it and open it again.
3. Start a new chat in that app. In VS Code, pick **Agent** mode in the Copilot chat.
4. Type: \`Use krypt-studio to make a 2-bar beat at 140 BPM\`.
5. If the app asks to allow a Krypt Studio tool, click **Allow**.

> "Doesn't seem to be installed"? Install the app first, then click **Set up** again.

## The built-in chat (with an API key)

No other app needed: you chat inside Krypt Studio.

**Get a key (once).** Pick one company. The chat works with any of them:

| Company | Where | The key starts with |
|---|---|---|
| **Anthropic** (Claude) | console.anthropic.com ▸ **API Keys** | \`sk-ant-\` |
| **OpenAI** (ChatGPT) | platform.openai.com ▸ **API keys** | \`sk-\` or \`sk-proj-\` |
| **OpenRouter** (many AIs with one key) | openrouter.ai ▸ **Keys** | \`sk-or-\` |

1. Sign in (or sign up) and add some credit under **Billing**. The chat costs money per message.
2. Create a key. Give it any name.
3. Copy it. Keep it secret, like a password.

**Add it to Krypt Studio:**

1. In the Studio, click the **AI** button (top-right of the bar at the top). The **Agents** window opens on the right. [[show:transport.agent|Show me]]

{{image:ai-button.webp|The AI button at the top-right opens the Agents window.}}

2. Click the **Chat** tab. [[show:agent.chat|Show me]]
3. Click the company your key is from: **Anthropic (Claude)**, **OpenAI (ChatGPT)** or **OpenRouter**. The **Get a key** link opens that company's key page.
4. Click the key box and paste your key with [[Ctrl+V]].
5. Click **Save**. A message says your key was saved (stored encrypted on this PC).

{{image:ai-chat-key.webp|Agents ▸ Chat: paste the key into the box and click Save.}}

6. Type your request in the box at the bottom and press [[Enter]].

> The top of the Chat tab shows the company and model: click it to switch company or pick another model. It also shows the running cost in dollars (for OpenAI, the token count). **Remove … key** (under the message box) deletes the key.

You can also reach the chat from **Home ▸ AI Agents ▸ Open the chat**.

{{image:ai-home-chat-history.webp|Home ▸ AI Agents: Open the chat (1) and Open History (2).}}

## Is it connected?

- On Home, the **AI Agents** card says "Claude Code connected" (or your app's name) while it works.
- In the Studio, the **AI** button shows how many agents are connected, and it glows while one is editing.
- The **Agents** window has a **Connect** tab with the same setup (**Install** and **Copy**) and a **Kill switch** that stops every agent at once. [[show:agent.connect|Show me]]

{{image:ai-panel-connect.webp|Agents window: the Connect tab (1), Install for an app (2), and the Kill switch (3).}}

> Krypt Studio closed when the AI needs it? It starts by itself.

## First things to say

You don't need special words. Talk like you would to a producer friend:

- "Make a 2-bar trap beat at 140 BPM."
- "Make a chill lo-fi beat with soft drums and a piano."
- "Make the hats bouncier."
- "Turn this beat into a full song with an intro and a drop."
- "The bass is too loud. Can you fix it?"
- "Export it as an MP3."

More ideas: [[guide:ai-results|Getting great results from the AI]].

## Undo everything the AI did

Every AI change is listed in **History** with the AI's name. One click undoes all of it, and your own changes stay.

1. Click **Edit** (top-left), then **History…**. Or **Home ▸ AI Agents ▸ Open History**.
2. Next to the AI's name, click **Revert all AI edits**. [[show:history.revertAgent|Show me]]

{{image:ai-revert.webp|History: Revert all AI edits undoes every change the AI made.}}

> Just one change to undo? Press [[Ctrl+Z]].

More about agents: [[guide:ai-agents]]. Something not working? [[guide:step-help#ai-not-connecting|AI not connecting]].
`,
};
