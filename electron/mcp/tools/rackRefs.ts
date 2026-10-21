import type { Project } from '@shared/schema/project';
import type { PluginCatalog, ParamSpec } from '@shared/plugins/types';
import type { MacroTarget, RackChain, RackDef } from '@shared/schema/rack';
import { findPlugin, paramSpecFor, rackParamRef, type RackParamHost } from '@shared/schema/params';
import { fail } from './types';
import { safeName } from './util';

export type RackPick = string | number;

export function rackAt(p: Project, host: RackParamHost, where: string): RackDef {
  const rack = host.kind === 'channel' ? p.channels[host.channelId]?.generator.rack : p.mixer.inserts[host.insertId]?.slots[host.slotId]?.rack;
  if (!rack) fail(`${where} doesn't hold a rack, so it has no chains. Drop "chain" to set the device's own params, or build one with build_rack.`);
  return rack;
}

const norm = (s: string): string => s.toLowerCase().replace(/^krypt\s+/, '').trim();

export function pickChain(rack: RackDef, chain: RackPick, where: string): RackChain {
  const list = rack.chainOrder.map((id) => rack.chains[id]).filter(Boolean);
  const n = typeof chain === 'number' ? chain : /^\d+$/.test(chain) ? Number(chain) : NaN;
  const hit = rack.chains[String(chain)] ?? (Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined) ?? list.find((c) => c.name.toLowerCase() === String(chain).toLowerCase());
  if (!hit) fail(`${where} has no chain "${safeName(String(chain), 40)}". Its chains: ${list.map((c, i) => `${i + 1}. ${safeName(c.name, 30)}`).join(', ') || 'none'}.`);
  return hit;
}

export function pickDevice(catalog: PluginCatalog, c: RackChain, device: RackPick): string {
  const ids = c.deviceOrder.filter((id) => c.devices[id]);
  const n = typeof device === 'number' ? device : /^\d+$/.test(device) ? Number(device) : NaN;
  const want = norm(String(device));
  const hit =
    (c.devices[String(device)] ? String(device) : undefined) ??
    (Number.isInteger(n) && n >= 1 ? ids[n - 1] : undefined) ??
    ids.find((id) => {
      const t = c.devices[id].type;
      return t.toLowerCase() === String(device).toLowerCase() || norm(t.replace(/^krypt\./, '')) === want || norm(findPlugin(catalog, t)?.name ?? '') === want;
    });
  if (!hit) {
    const names = ids.map((id, i) => `${i + 1}. ${findPlugin(catalog, c.devices[id].type)?.name ?? c.devices[id].type}`).join(', ');
    fail(`Chain "${safeName(c.name, 30)}" has no device "${safeName(String(device), 40)}". Its devices: ${names || 'none'}.`);
  }
  return hit;
}

export function rackInnerRef(
  p: Project,
  catalog: PluginCatalog,
  host: RackParamHost,
  where: string,
  chain: RackPick,
  device: RackPick | undefined,
  param: string,
): { ref: string; spec: ParamSpec; label: string } {
  const rack = rackAt(p, host, where);
  const c = pickChain(rack, chain, where);
  let target: MacroTarget;
  const key = param.toLowerCase();
  const find = (type: string): string => {
    const desc = findPlugin(catalog, type);
    const spec = desc?.params.find((s) => s.id === param) ?? desc?.params.find((s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key);
    if (!spec) fail(`${desc?.name ?? type} in chain "${safeName(c.name, 30)}" has no parameter "${safeName(param, 30)}" (describe_plugin {"plugin":"${type}"} lists them)`);
    return spec.id;
  };
  if (device !== undefined) {
    const deviceId = pickDevice(catalog, c, device);
    target = { chainId: c.id, kind: 'device', deviceId, param: key === 'mix' ? 'mix' : find(c.devices[deviceId].type) };
  } else if (key === 'volume' || key === 'pan') {
    target = { chainId: c.id, kind: 'chain', param: key };
  } else {
    if (host.kind !== 'channel' || !c.instrument) fail(`Chain "${safeName(c.name, 30)}" has no instrument: pass "device" for an effect's param, or param "volume" / "pan" for the chain.`);
    target = { chainId: c.id, kind: 'instrument', param: find(c.instrument.type) };
  }
  const ref = rackParamRef(host, target);
  const spec = paramSpecFor(p, catalog, ref);
  if (!spec) fail(`"${safeName(ref, 80)}" is not an automatable parameter`);
  const devName = target.kind === 'device' ? ` ${(findPlugin(catalog, c.devices[target.deviceId].type)?.name ?? 'device').replace(/^Krypt /, '')}` : '';
  return { ref, spec, label: `${safeName(c.name, 30)}${devName} ${spec.name}` };
}
