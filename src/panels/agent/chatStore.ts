// Built-in agent chat state (survives closing the panel). Streams events
// from window.krypt.agent.onEvent into a message list.

import { create } from 'zustand';
import { toast } from '../../app/notify';

export interface ChatItem {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  tool?: string;
  input?: unknown;
  ok?: boolean;
  pending?: boolean;
}

interface ChatState {
  items: ChatItem[];
  streaming: boolean;
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

export const useChat = create<ChatState>(() => ({ items: [], streaming: false, cost: 0, tokensIn: 0, tokensOut: 0 }));

let seq = 0;
let installed = false;

export function installAgentChat(): void {
  if (installed) return;
  installed = true;
  window.krypt.agent.onEvent((e) => {
    useChat.setState((s) => {
      const items = [...s.items];
      const last = items[items.length - 1];
      switch (e.type) {
        case 'text':
          if (last && last.role === 'assistant' && last.pending) items[items.length - 1] = { ...last, text: last.text + (e.text ?? '') };
          else items.push({ id: ++seq, role: 'assistant', text: e.text ?? '', pending: true });
          return { items, streaming: true };
        case 'tool_use':
          if (last?.pending) items[items.length - 1] = { ...last, pending: false };
          items.push({ id: ++seq, role: 'tool', text: '', tool: e.tool, input: e.input, pending: true });
          return { items, streaming: true };
        case 'tool_result': {
          for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].role === 'tool' && items[i].pending) {
              items[i] = { ...items[i], pending: false, ok: e.ok, text: e.text ?? '' };
              break;
            }
          }
          return { items, streaming: true };
        }
        case 'done': {
          const closed = items.map((it) => (it.pending ? { ...it, pending: false } : it));
          const u = e.usage;
          return {
            items: closed,
            streaming: false,
            cost: s.cost + (u?.costUsd ?? 0),
            tokensIn: s.tokensIn + (u?.inputTokens ?? 0),
            tokensOut: s.tokensOut + (u?.outputTokens ?? 0),
          };
        }
        case 'error':
          toast.error(`Agent: ${e.text ?? 'error'}`);
          return { items: [...items.map((it) => (it.pending ? { ...it, pending: false } : it)), { id: ++seq, role: 'error', text: e.text ?? 'Error' }], streaming: false };
        default:
          return {};
      }
    });
  });
}

export async function sendChat(text: string): Promise<boolean> {
  const msg = text.trim();
  if (!msg) return false;
  useChat.setState((s) => ({ items: [...s.items, { id: ++seq, role: 'user', text: msg }], streaming: true }));
  try {
    const r = await window.krypt.agent.send(msg);
    if (!r.ok) {
      useChat.setState((s) => ({ items: [...s.items, { id: ++seq, role: 'error', text: r.message ?? 'The agent could not start' }], streaming: false }));
      toast.error(r.message ?? 'The agent could not start');
      return false;
    }
    return true;
  } catch (err) {
    const m = (err as Error)?.message ?? String(err);
    useChat.setState((s) => ({ items: [...s.items, { id: ++seq, role: 'error', text: m }], streaming: false }));
    toast.error(m);
    return false;
  }
}

export async function cancelChat(): Promise<void> {
  try {
    await window.krypt.agent.cancel();
  } finally {
    useChat.setState((s) => ({ streaming: false, items: s.items.map((it) => (it.pending ? { ...it, pending: false } : it)) }));
  }
}

export async function resetChat(): Promise<void> {
  try {
    await window.krypt.agent.reset();
  } catch {
    /* ignore */
  }
  useChat.setState({ items: [], streaming: false });
}
