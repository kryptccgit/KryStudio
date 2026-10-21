// Built-in agent panel backend (research/04 §8): a tool-use loop in Electron MAIN over the SAME tool registry the
// MCP server exposes, on the provider the user picked (shared/agent/providers.ts): Anthropic through its SDK
// (./loop.ts), OpenAI (ChatGPT) and OpenRouter through the OpenAI-compatible Chat Completions API
// (./openaiLoop.ts). The renderer only receives AgentChatEvents on MCP_CHANNELS.agentEvent.
//
// Each provider's API key is encrypted with Electron safeStorage (DPAPI) in its own userData file (./key.ts). A key
// is never logged, broadcast, returned or written in plain text; settings.agent.keys mirrors which providers have one
// and settings.agent.hasApiKey whether the selected one does.

import fs from 'node:fs';
import { safeStorage } from 'electron';
import type { ActionResult } from '@shared/types';
import { AGENT_PROVIDERS, AGENT_PROVIDER_IDS, isAgentProvider, keyProblem, modelFor, type AgentProvider } from '@shared/agent/providers';
import type { AgentController, MainDeps } from '../mcp/types';
import { resolveClientContext } from '../system/context';
import { createAgentCore } from './loop';
import { createCompatCore } from './openaiLoop';
import { agentClient, keyPathFor, providerKey } from './key';

export { DEFAULT_MODEL } from './loop';
export { agentClient } from './key';

function writeAtomic(file: string, data: Buffer): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function createAgent(deps: MainDeps): AgentController {
  const ctx = resolveClientContext();
  const provider = (): AgentProvider => {
    const p = deps.getSettings().agent.provider;
    return isAgentProvider(p) ? p : 'anthropic';
  };

  /** Record which providers have a saved key (files only: env keys are a developer convenience). */
  const syncKeys = () => {
    const s = deps.getSettings();
    const keys = Object.fromEntries(AGENT_PROVIDER_IDS.map((p) => [p, fs.existsSync(keyPathFor(deps.userDataDir, p))])) as Record<AgentProvider, boolean>;
    const changed = AGENT_PROVIDER_IDS.some((p) => s.agent.keys?.[p] !== keys[p]) || s.agent.hasApiKey !== keys[provider()];
    if (changed) deps.updateSettings({ agent: { ...s.agent, keys, hasApiKey: keys[provider()] } });
  };
  syncKeys();

  const anthropic = createAgentCore(deps, () => agentClient(deps.userDataDir));
  const compat = createCompatCore(deps, () => {
    const p = provider();
    if (p === 'anthropic') return null;
    const key = providerKey(deps.userDataDir, p);
    if (!key) return null;
    // OpenRouter shows which app made the request (its documented attribution headers).
    const headers = p === 'openrouter' && ctx.intact ? { 'HTTP-Referer': ctx.siteUrl, 'X-Title': ctx.productName } : undefined;
    return { provider: p, key, model: modelFor(deps.getSettings().agent, p), headers };
  });
  const core = () => (provider() === 'anthropic' ? anthropic : compat);

  return {
    async setApiKey(key: string | null, which?: AgentProvider): Promise<ActionResult> {
      const p = isAgentProvider(which) ? which : provider();
      const name = AGENT_PROVIDERS[p].label;
      const keyPath = keyPathFor(deps.userDataDir, p);
      try {
        if (!key) {
          fs.rmSync(keyPath, { force: true });
          syncKeys();
          return { ok: true, message: `${name} key removed.` };
        }
        const trimmed = key.trim();
        const problem = keyProblem(p, trimmed);
        if (problem) return { ok: false, message: problem };
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: "Your system's secure storage (Windows DPAPI, the macOS Keychain or a Linux keyring) isn't available, so the key was not saved (Krypt Studio never stores it in plain text)." };
        fs.mkdirSync(deps.userDataDir, { recursive: true });
        writeAtomic(keyPath, safeStorage.encryptString(trimmed));
        syncKeys();
        deps.log('info', `Agent: ${name} key saved (encrypted)`);
        return { ok: true, message: `${name} key saved securely.` };
      } catch (e) {
        return { ok: false, message: `Couldn't save the ${name} key: ${(e as Error).message}` };
      }
    },
    send: (message: string) => core().send(message),
    cancel: async () => {
      await anthropic.cancel();
      await compat.cancel();
    },
    reset: async () => {
      await anthropic.reset();
      await compat.reset();
    },
    isBusy: () => anthropic.busy() || compat.busy(),
  };
}
