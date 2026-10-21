import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import { AGENT_PROVIDERS, keyFileFor, type AgentProvider } from '@shared/agent/providers';

export const KEY_FILE = keyFileFor('anthropic');

export function readKey(keyPath: string): string | null {
  try {
    if (!fs.existsSync(keyPath) || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(keyPath));
  } catch {
    return null;
  }
}

export function keyPathFor(userDataDir: string, p: AgentProvider): string {
  return path.join(userDataDir, keyFileFor(p));
}

export function providerKey(userDataDir: string, p: AgentProvider): string | null {
  return readKey(keyPathFor(userDataDir, p)) ?? (process.env[AGENT_PROVIDERS[p].envKey]?.trim() || null);
}

export function agentClient(userDataDir: string, opts: { maxRetries?: number } = {}): Anthropic | null {
  const key = readKey(keyPathFor(userDataDir, 'anthropic'));
  if (key) return new Anthropic({ apiKey: key, maxRetries: opts.maxRetries ?? 2 });
  if (process.env.ANTHROPIC_API_KEY) return new Anthropic({ maxRetries: opts.maxRetries ?? 2 });
  return null;
}
