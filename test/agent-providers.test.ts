import assert from 'node:assert/strict';
import { test, run } from './harness';
import { AGENT_PROVIDERS, AGENT_PROVIDER_IDS, isAgentProvider, keyFileFor, keyProblem, modelFor } from '@shared/agent/providers';
import { DEFAULT_SETTINGS, mergeSettings } from '../electron/system/settings-store';

const KEY = {
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
  openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  openrouter: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz012345',
};

test('three providers, each with a key page, a key format, a default model and (OpenAI-compatible) an endpoint', () => {
  assert.deepEqual(AGENT_PROVIDER_IDS, ['anthropic', 'openai', 'openrouter']);
  for (const p of AGENT_PROVIDER_IDS) {
    const info = AGENT_PROVIDERS[p];
    assert.match(info.keyUrl, /^https:\/\//);
    assert.ok(info.defaultModel && info.models.includes(info.defaultModel), `${p}: the default model is a suggestion`);
  }
  assert.equal(AGENT_PROVIDERS.anthropic.baseUrl, undefined, 'Anthropic runs on its own SDK');
  assert.equal(AGENT_PROVIDERS.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(AGENT_PROVIDERS.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.ok(isAgentProvider('openrouter') && !isAgentProvider('gemini'));
});

test('keys: each provider takes its own format; a key for another provider says which one it is', () => {
  for (const p of AGENT_PROVIDER_IDS) assert.equal(keyProblem(p, KEY[p]), null, `${p} accepts its own key`);
  assert.equal(keyProblem('openai', 'sk-abcdefghijklmnopqrstuvwxyz0123'), null, 'old-style sk- keys too');
  assert.match(keyProblem('openai', KEY.anthropic)!, /Anthropic \(Claude\) key/);
  assert.match(keyProblem('anthropic', KEY.openrouter)!, /OpenRouter key/);
  assert.match(keyProblem('openrouter', 'hello')!, /sk-or-/);
  assert.match(keyProblem('openai', 'my chatgpt password')!, /ChatGPT subscription isn't an API key/);
});

test('key files: Anthropic keeps agent-key.bin (saved keys still work), the others get their own', () => {
  assert.equal(keyFileFor('anthropic'), 'agent-key.bin');
  assert.equal(keyFileFor('openai'), 'agent-key-openai.bin');
  assert.equal(keyFileFor('openrouter'), 'agent-key-openrouter.bin');
});

test('model: the choice per provider, else its default (Anthropic falls back to the older model field)', () => {
  const agent = { model: 'claude-sonnet-5-5', hasApiKey: false, provider: 'openai' as const, models: { openrouter: 'openai/gpt-5' } };
  assert.equal(modelFor(agent), AGENT_PROVIDERS.openai.defaultModel);
  assert.equal(modelFor(agent, 'openrouter'), 'openai/gpt-5');
  assert.equal(modelFor(agent, 'anthropic'), 'claude-sonnet-5-5');
  assert.equal(modelFor({ ...agent, models: { anthropic: 'claude-haiku-5-5' } }, 'anthropic'), 'claude-haiku-5-5');
});

test('settings: provider and models merge; hasApiKey follows the selected provider; junk is dropped', () => {
  const base = mergeSettings(DEFAULT_SETTINGS, {});
  assert.equal(base.agent.provider, 'anthropic');
  const withKeys = mergeSettings(base, { agent: { ...base.agent, keys: { anthropic: false, openai: true, openrouter: false } } });
  assert.equal(withKeys.agent.hasApiKey, false, 'Anthropic has no key');
  const switched = mergeSettings(withKeys, { agent: { ...withKeys.agent, provider: 'openai' } });
  assert.equal(switched.agent.hasApiKey, true, 'OpenAI has one');
  const models = mergeSettings(switched, { agent: { ...switched.agent, models: { openai: 'gpt-5-mini', openrouter: '' } } });
  assert.deepEqual(models.agent.models, { openai: 'gpt-5-mini' });
  const junk = mergeSettings(models, { agent: { ...models.agent, provider: 'gemini', models: { openai: 42 } } });
  assert.equal(junk.agent.provider, 'openai', 'an unknown provider keeps the previous one');
  assert.deepEqual(junk.agent.models, {});
  const legacy = mergeSettings(DEFAULT_SETTINGS, { agent: { model: 'claude-opus-5-5', hasApiKey: true } });
  assert.equal(legacy.agent.provider, 'anthropic');
  assert.equal(legacy.agent.hasApiKey, true);
});

void run('agent-providers');
