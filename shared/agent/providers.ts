export type AgentProvider = 'anthropic' | 'openai' | 'openrouter';

export interface AgentProviderInfo {
  id: AgentProvider;
  label: string;
  keyUrl: string;
  keyHint: string;
  keyPattern: RegExp;
  keyMismatch: string;
  defaultModel: string;
  models: string[];
  baseUrl?: string;
  envKey: string;
}

export const AGENT_PROVIDERS: Record<AgentProvider, AgentProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    keyMismatch: "That doesn't look like an Anthropic API key (it starts with sk-ant-).",
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    envKey: 'ANTHROPIC_API_KEY',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    keyPattern: /^sk-(?!ant-)(?!or-)[A-Za-z0-9_-]{20,}$/,
    keyMismatch: "That doesn't look like an OpenAI API key (it starts with sk- or sk-proj-). A ChatGPT subscription isn't an API key: create one at platform.openai.com.",
    defaultModel: 'gpt-5',
    models: ['gpt-5', 'gpt-5-mini'],
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    keyPattern: /^sk-or-[A-Za-z0-9_-]{20,}$/,
    keyMismatch: "That doesn't look like an OpenRouter key (it starts with sk-or-).",
    defaultModel: 'openrouter/auto',
    models: ['openrouter/auto', 'anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro'],
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
  },
};

export const AGENT_PROVIDER_IDS = Object.keys(AGENT_PROVIDERS) as AgentProvider[];

export function isAgentProvider(v: unknown): v is AgentProvider {
  return typeof v === 'string' && (AGENT_PROVIDER_IDS as string[]).includes(v);
}

export function keyFileFor(p: AgentProvider): string {
  return p === 'anthropic' ? 'agent-key.bin' : `agent-key-${p}.bin`;
}

export function keyProblem(p: AgentProvider, key: string): string | null {
  const k = key.trim();
  if (AGENT_PROVIDERS[p].keyPattern.test(k)) return null;
  const other = AGENT_PROVIDER_IDS.find((o) => o !== p && AGENT_PROVIDERS[o].keyPattern.test(k));
  if (other) return `That's an ${AGENT_PROVIDERS[other].label} key. Pick ${AGENT_PROVIDERS[other].label} above, or paste your ${AGENT_PROVIDERS[p].label} key.`;
  return AGENT_PROVIDERS[p].keyMismatch;
}

export function modelFor(agent: { provider?: AgentProvider; model: string; models?: Partial<Record<AgentProvider, string>> }, p: AgentProvider = agent.provider ?? 'anthropic'): string {
  const chosen = p === 'anthropic' ? agent.models?.anthropic || agent.model : agent.models?.[p];
  return chosen?.trim() || AGENT_PROVIDERS[p].defaultModel;
}
