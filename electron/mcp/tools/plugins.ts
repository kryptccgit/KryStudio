// Third-party plugin tools. Installed VST3 / CLAP plugins are otherwise used
// through the regular tools (list_plugins, add_channel, add_effect,
// describe_plugin, set_params) — their params are ParamRefs like stock ones.
// This tool shows a plugin's OWN window to the user, or restarts the
// plugin host after a crash.
import { z } from 'zod';
import { defineTool, fail } from './types';
import { findChannel, findInsert, findSlot, pluginName, safeName } from './util';

export const pluginWindow = defineTool({
  name: 'plugin_window',
  title: "Show a VST3/CLAP plugin's own window",
  kind: 'transport',
  description:
    "Open (or close) the native editor window of an installed VST3/CLAP instrument ({channel}) or effect ({insert, effect}) so the user can see or tweak it; it floats above Krypt Studio. Doesn't change the project. Stock plugins have no separate window (use describe_plugin / set_params). reload:true instead restarts the plugin host and reloads every third-party plugin (after a crash).",
  input: z.object({
    channel: z.string().optional(),
    insert: z.union([z.string(), z.number()]).optional(),
    effect: z.union([z.string(), z.number()]).optional(),
    open: z.boolean().default(true),
    reload: z.boolean().optional(),
  }),
  summarize: (a) => (a.reload ? 'reload plugins' : `${a.open === false ? 'close' : 'open'} ${safeName(a.channel ?? String(a.effect ?? a.insert ?? ''), 30)}`),
  async run(deps, _c, a) {
    const plugins = deps.plugins;
    if (!plugins) fail('Third-party plugin hosting is not available in this session.');
    if (a.reload) {
      const r = await plugins.reload();
      return { ok: r.ok, message: r.message ?? (r.ok ? 'Plugin host restarted.' : 'Reload failed.'), changed: [] };
    }
    const p = deps.doc.project;
    let target: { channelId: string } | { insertId: string; slotId: string };
    let type: string;
    if (a.channel !== undefined) {
      const ch = findChannel(p, a.channel);
      target = { channelId: ch.id };
      type = ch.generator.type;
    } else if (a.insert !== undefined && a.effect !== undefined) {
      const ins = findInsert(p, a.insert);
      const sid = findSlot(ins, a.effect, deps.doc.catalog);
      target = { insertId: ins.id, slotId: sid };
      type = ins.slots[sid].type;
    } else fail('Pass channel, or insert + effect.');
    if (!type.startsWith('vst3:') && !type.startsWith('clap:')) fail(`${pluginName(deps.doc.catalog, type)} is a stock plugin: it has no separate window. Use describe_plugin / set_params.`);
    const r = await plugins.openEditor(target, a.open);
    return { ok: r.ok, message: r.message ?? (r.ok ? 'Done.' : 'Failed.'), changed: [] };
  },
});

export const PLUGIN_TOOLS = [pluginWindow];
