import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const shim = [path.join(root, 'resources/bin/krypt-studio-mcp.exe'), path.join(root, 'engine/target/release/krypt-studio-mcp.exe'), path.join(root, 'engine/target/debug/krypt-studio-mcp.exe')].find((p) => fs.existsSync(p));
if (!shim) {
  console.error('krypt-studio-mcp.exe not found — run `npm run engine:build` first.');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const PAT = `Smoke Beat ${Date.now() % 100000}`;

const p = spawn(shim, ['--client', 'agent-smoke'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const waiting = new Map();
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  }
});
p.stderr.on('data', (d) => process.stderr.write(`  [shim] ${d}`));
let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 60000);
    waiting.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

let failures = 0;
async function tool(name, args, { expectOk = true } = {}) {
  const t0 = Date.now();
  const m = await rpc('tools/call', { name, arguments: args });
  const text = m.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(m.error);
  const ok = m.result && !m.result.isError;
  const mark = ok === expectOk ? 'ok ' : 'BAD';
  if (ok !== expectOk) failures++;
  console.log(`${mark} ${name} (${Date.now() - t0} ms): ${text.split('\n').slice(0, 6).join('\n      ')}`);
  return { ok, text, result: m.result };
}

const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-smoke', version: '1' } });
console.log(`connected: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version} (protocol ${init.result?.protocolVersion})`);
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await rpc('tools/list', {});
console.log(`tools: ${list.result?.tools?.length}`);

await tool('get_project', {});
await tool('begin_edit', { label: 'Smoke test beat' });
await tool('write_pattern', {
  kpn: [
    `pattern "${PAT}" bars=2 grid=16 key=F#m`,
    'Kick  : x... .... ..x. .... | x... .... .x.. ..x.',
    'Clap  : .... x... .... x... | .... x... .... x...',
    'Hat/32: (x.x.)*7 xxxx | (x.x.)*6 xxxx xxxx',
    '808   : F#1:6 r:4 C#2:2 E2:4 | F#1:8~ C#1:4 r:2 A1:2',
    'Keys {oct=4}: [F#4 A4 C#5]:16 | [D4 F#4 A4]:16',
  ].join('\n'),
});
await tool('read_pattern', { pattern: PAT });
await tool('set_tempo', { bpm: 142 });
await tool('arrange', { placements: [{ pattern: PAT, bars: '1-8' }] });
await tool('add_effect', { insert: 'Keys', effect: 'reverb', params: { decay: 2.5 }, mix: 30 });
await tool('commit_edit', {});
const r = await tool('render_preview', { scope: 'song', key: 'F#m' });
const lufs = Number(/I=(-?[\d.]+) LUFS/.exec(r.text)?.[1]);
if (r.ok && !(lufs > -40)) {
  failures++;
  console.log(`BAD render_preview is silent (${Number.isNaN(lufs) ? 'no loudness' : `${lufs} LUFS`}): the engine rendered a stale project`);
}
await tool('get_history', { who: 'all' });
if (!keep) await tool('revert_all_agent_edits', { confirm: true });
await tool('set_tempo', { bpm: keep ? 142 : 140 }, { expectOk: false });

p.stdin.end();
setTimeout(() => {
  console.log(failures ? `\n${failures} unexpected result(s)` : `\nagent smoke test passed${r.ok ? '' : ' (render_preview failed — is the engine running?)'}`);
  process.exit(failures ? 1 : 0);
}, 300);
