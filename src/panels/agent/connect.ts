// Connecting MCP clients (Claude Code, Claude Desktop, Cursor, VS Code):
// the snippets and installers main provides, shared by the Agents panel's
// Connect tab and the Home hub's AI Agents screen. Every action toasts.

import type { ClientConfigSnippet } from '@shared/types';
import { report, toast } from '../../app/notify';

export const CLIENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
};

export function clientLabel(client: string): string {
  return CLIENT_LABELS[client] ?? client;
}

/** The connection snippets (empty, with a toast, when main can't provide them). */
export async function loadClientConfigs(): Promise<ClientConfigSnippet[]> {
  try {
    return await window.krypt.mcp.clientConfigs();
  } catch (err) {
    toast.error(`Couldn't load connection snippets: ${(err as Error)?.message ?? String(err)}`);
    return [];
  }
}

export async function copyClientSnippet(c: ClientConfigSnippet): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(c.snippet);
    toast.success(c.client === 'claude-code' ? 'Command copied: paste it into a terminal' : `${clientLabel(c.client)} config copied`);
    return true;
  } catch {
    toast.error('The clipboard is not available. Select the text and copy it by hand.');
    return false;
  }
}

const installed = new Set<string>();

/** Clients set up with Install this session (the "Set up AI" tour waits for this). */
export function installedClients(): string[] {
  return [...installed];
}

/** Write the client's config (or run `claude mcp add`); main keeps a .bak and never touches other servers. */
export async function installClientSnippet(c: ClientConfigSnippet): Promise<boolean> {
  try {
    const r = await window.krypt.mcp.installClientConfig(c.client);
    if (r.ok) installed.add(c.client);
    return report(r, r.message || `Krypt Studio added to ${clientLabel(c.client)}. Restart it to connect.`);
  } catch (err) {
    toast.error(`Couldn't set up ${clientLabel(c.client)}: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}
