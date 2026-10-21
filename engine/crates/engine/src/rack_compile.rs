//! Rack planning (compile.rs child module, so it reaches the Session's
//! sample cache and warnings): `RackDef` → `rack::RackPlan`, i.e. the inner
//! instruments / devices to create, their samples (resolved and loaded like
//! channel samples), the flat param vector (module docs of rack.rs) with
//! the macro maps resolved, and the structure key that decides rebuilds.

use super::Session;
use crate::model::{FxSlot, Generator, Model};
use crate::model_ext::RackDef;
use crate::rack::*;
use crate::samples::is_sfz;
use krypt_studio_dsp::instruments::{audioclip, multisampler};
use krypt_studio_dsp::{clamp_to_spec, ParamSpec, PluginDescriptor, PluginKind};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Arc;

/// A compiled rack's mappable targets, for automation of inner params
/// (`<host>/rack/<chain>/…` ParamRefs → TargetKind::RackInst / RackFx).
pub(crate) struct RackTargets {
    pub index: BTreeMap<TargetKey, usize>,
    /// Per target: its spec and its document (base) value.
    pub targets: Vec<(ParamSpec, f32)>,
}

impl RackTargets {
    /// Target index, spec and document value of an inner param.
    pub fn find(&self, chain: &str, what: &crate::params::RackParam) -> Option<(usize, ParamSpec, f32)> {
        use crate::params::RackParam;
        let key: TargetKey = match what {
            RackParam::Chain(p) => (chain.to_string(), "chain", String::new(), p.clone()),
            RackParam::Inst(p) => (chain.to_string(), "instrument", String::new(), p.clone()),
            RackParam::Dev { device, param } => (chain.to_string(), "device", device.clone(), param.clone()),
        };
        let t = *self.index.get(&key)?;
        let (spec, doc) = self.targets.get(t)?.clone();
        Some((t, spec, doc))
    }
}

/// Per chain: the instrument's descriptor and each device with its descriptor.
type ChainDescs<'a> = (Option<Arc<PluginDescriptor>>, Vec<(&'a FxSlot, Arc<PluginDescriptor>)>);

/// Built-in target specs (same as shared/schema/params.ts BUILTIN_SPECS).
fn spec_chain_volume() -> ParamSpec {
    ParamSpec { id: "volume", name: "Volume", min: 0.0, max: 2.0, default: 1.0, unit: "", scale: "gain", step: None, options: None, group: None, automatable: None }
}

impl Session {
    /// Plan the rack of a channel generator (`owner` = channel id) or of an FX
    /// slot (`owner` = "insertId/slotId"). Never fails: anything unsupported is
    /// skipped with a warning and the rest of the rack still plays.
    pub(super) fn rack_plan(&mut self, owner: &str, kind: RackKind, params: &BTreeMap<String, f64>, def: Option<&RackDef>, model: &Model) -> RackPlan {
        let mut plan = RackPlan::new(kind);
        let mut key = String::new();
        let _ = write!(key, "{}", kind.name());
        let mut values: Vec<f32> = MACRO_PARAM_IDS.iter().map(|id| params.get(*id).map(|v| *v as f32).filter(|v| v.is_finite()).unwrap_or(0.0).clamp(0.0, 1.0)).collect();
        let Some(def) = def else {
            plan.values = values;
            plan.key = key;
            return plan;
        };
        if def.kind != kind.name() {
            self.warn_once(
                format!("rack-kind:{owner}"),
                format!("Rack {owner} says it is a '{}' rack but its device is a {} rack; it plays as a {} rack", def.kind, kind.name(), kind.name()),
            );
        }
        let mut chains = def.ordered_chains();
        if chains.len() > MAX_RACK_CHAINS {
            self.warn_once(format!("rack-chains:{owner}"), format!("Rack {owner} has {} chains; only the first {MAX_RACK_CHAINS} play", chains.len()));
            chains.truncate(MAX_RACK_CHAINS);
        }

        // Pass 1: chains, inner instances, chain settings.
        let mut settings: Vec<f32> = Vec::with_capacity(chains.len() * CHAIN_SETTINGS);
        let mut enabled: Vec<f32> = Vec::new();
        // Per chain: (instrument descriptor, [(device slot, descriptor)]).
        let mut descs: Vec<ChainDescs> = Vec::new();
        for c in &chains {
            let mut cp = ChainPlan { id: c.id.clone(), ..Default::default() };
            let mut inst_desc = None;
            let _ = write!(key, "|c:{}", c.id);
            match (&c.instrument, kind) {
                (Some(g), RackKind::Effect) => {
                    if !g.type_id.is_empty() {
                        self.warn_once(format!("rack-fxinst:{owner}:{}", c.id), format!("Effect rack {owner}: chain {} has an instrument, which only instrument and drum racks play; ignored", c.id));
                    }
                }
                (Some(g), _) => {
                    if let Some((ip, d)) = self.rack_instrument(owner, &c.id, g, model) {
                        let _ = write!(key, ":{}", ip.type_id);
                        match (&ip.sample, &ip.multi) {
                            (Some(s), _) => {
                                let _ = write!(key, ":s{:p}", Arc::as_ptr(s));
                            }
                            (_, Some(m)) => {
                                let _ = write!(key, ":m{:p}", Arc::as_ptr(m));
                            }
                            _ => {}
                        }
                        cp.inst = Some(ip);
                        inst_desc = Some(d);
                    }
                }
                (None, _) => {}
            }
            let mut devs = Vec::new();
            let ordered: Vec<&FxSlot> = c.device_order.iter().filter_map(|id| c.devices.get(id)).collect();
            if ordered.len() > MAX_CHAIN_DEVICES {
                self.warn_once(
                    format!("rack-devs:{owner}:{}", c.id),
                    format!("Rack {owner}: chain {} has {} effects; only the first {MAX_CHAIN_DEVICES} play", c.id, ordered.len()),
                );
            }
            for fx in ordered.into_iter().take(MAX_CHAIN_DEVICES) {
                let Some(d) = self.rack_device(owner, &c.id, fx) else { continue };
                let _ = write!(key, "|d:{}:{}", fx.id, fx.type_id);
                cp.devices.push(DevPlan { type_id: fx.type_id.clone(), echo: !fx.type_id.starts_with("krypt.") || ["krypt.delay", "krypt.tapeecho", "krypt.grain"].contains(&fx.type_id.as_str()) });
                enabled.push(if fx.enabled { 1.0 } else { 0.0 });
                devs.push((fx, d));
            }
            let z = c.zone.clone().unwrap_or_default();
            let key_lo = z.key_lo.round().clamp(0.0, 127.0);
            let key_hi = z.key_hi.round().clamp(0.0, 127.0);
            settings.extend([
                c.mute as u8 as f32,
                c.solo as u8 as f32,
                key_lo as f32,
                key_hi as f32,
                fin(z.vel_lo, 0.0).clamp(0.0, 1.0) as f32,
                fin(z.vel_hi, 1.0).clamp(0.0, 1.0) as f32,
                if kind == RackKind::Drum { fin(c.choke.unwrap_or(0.0), 0.0).round().clamp(0.0, 32.0) as f32 } else { 0.0 },
            ]);
            plan.chains.push(cp);
            descs.push((inst_desc, devs));
        }

        // Pass 2: mappable targets (chain-major), their base values, and an index to resolve maps.
        let mut bases: Vec<f32> = Vec::new();
        // (chain id, kind, device id, param) → target index.
        let mut index: BTreeMap<TargetKey, usize> = BTreeMap::new();
        for (ci, c) in chains.iter().enumerate() {
            let mut push = |plan: &mut RackPlan, what: TargetWhat, spec: ParamSpec, base: f32, k: (&'static str, String, String)| {
                index.insert((c.id.clone(), k.0, k.1, k.2), plan.targets.len());
                plan.targets.push(TargetPlan { chain: ci, what, spec });
                bases.push(base);
            };
            push(&mut plan, TargetWhat::Volume, spec_chain_volume(), fin(c.volume, 1.0).clamp(0.0, 2.0) as f32, ("chain", String::new(), "volume".into()));
            push(&mut plan, TargetWhat::Pan, crate::params::spec_pan(), fin(c.pan, 0.0).clamp(-1.0, 1.0) as f32, ("chain", String::new(), "pan".into()));
            if let (Some(d), Some(g)) = (&descs[ci].0, &c.instrument) {
                for (k, s) in d.params.iter().enumerate() {
                    let v = clamp_to_spec(s, g.params.get(s.id).map(|v| *v as f32).unwrap_or(s.default));
                    push(&mut plan, TargetWhat::Inst(k), s.clone(), v, ("instrument", String::new(), s.id.to_string()));
                }
            }
            for (j, (fx, d)) in descs[ci].1.iter().enumerate() {
                push(&mut plan, TargetWhat::DevMix(j), crate::params::spec_mix(), fin(fx.mix, 1.0).clamp(0.0, 1.0) as f32, ("device", fx.id.clone(), "mix".into()));
                for (k, s) in d.params.iter().enumerate() {
                    let v = clamp_to_spec(s, fx.params.get(s.id).map(|v| *v as f32).unwrap_or(s.default));
                    push(&mut plan, TargetWhat::Dev(j, k), s.clone(), v, ("device", fx.id.clone(), s.id.to_string()));
                }
            }
        }

        // Pass 3: macro maps → per-target (macro, min, max). Macro order, then map id order:
        // a later map of the same target overwrites (last wins).
        let mut maps: Vec<(u8, f32, f32)> = vec![(0, 0.0, 1.0); plan.targets.len()];
        for (m, mac) in def.macros.iter().take(MACRO_COUNT).enumerate() {
            for map in mac.maps.values() {
                let t = &map.target;
                let k = match t.kind.as_str() {
                    "instrument" => ("instrument", String::new(), t.param.clone()),
                    "device" => ("device", t.device_id.clone().unwrap_or_default(), t.param.clone()),
                    "chain" => ("chain", String::new(), t.param.clone()),
                    _ => ("?", String::new(), String::new()),
                };
                match index.get(&(t.chain_id.clone(), k.0, k.1, k.2)) {
                    Some(&ti) => maps[ti] = ((m + 1) as u8, fin(map.min, 0.0).clamp(0.0, 1.0) as f32, fin(map.max, 1.0).clamp(0.0, 1.0) as f32),
                    None => self.warn_once(
                        format!("rack-map:{owner}:{}", map.id),
                        format!("Rack {owner}: macro {} maps to '{}' on chain {}, which isn't in the rack; the mapping is ignored", m + 1, t.param, t.chain_id),
                    ),
                }
            }
        }

        values.extend(settings);
        values.extend(enabled);
        for (t, b) in bases.iter().enumerate() {
            let (m, lo, hi) = maps[t];
            values.extend([*b, m as f32, lo, hi]);
        }
        debug_assert_eq!(values.len(), plan.len());
        plan.values = values;
        plan.key = key;
        plan.index = index;
        // Automation of inner params resolves its target index and spec here (compile.rs resolve_target).
        let bases = plan.targets_base();
        self.rack_targets.insert(
            owner.to_string(),
            RackTargets { index: plan.index.clone(), targets: plan.targets.iter().enumerate().map(|(t, tp)| (tp.spec.clone(), plan.values[bases + TARGET_FIELDS * t])).collect() },
        );
        plan
    }

    /// A chain's instrument: a stock, non-rack instrument, with its sample.
    fn rack_instrument(&mut self, owner: &str, chain: &str, g: &Generator, model: &Model) -> Option<(InstPlan, Arc<PluginDescriptor>)> {
        let t = g.type_id.as_str();
        if t.is_empty() {
            return None;
        }
        if is_rack(t) {
            self.warn_once(format!("rack-nested:{owner}:{chain}"), format!("Rack {owner}: racks inside racks aren't supported yet; chain {chain}'s {t} is skipped"));
            return None;
        }
        if krypt_studio_pluginclient::is_external_id(t) {
            self.warn_once(format!("rack-3p:{owner}:{chain}"), format!("Rack {owner}: third-party plugins can't go inside a rack yet; chain {chain}'s {t} is skipped"));
            return None;
        }
        if t == audioclip::PLUGIN_ID {
            self.warn_once(format!("rack-clip:{owner}:{chain}"), format!("Rack {owner}: audio clip players can't go inside a rack; chain {chain} is silent (use the sampler)"));
            return None;
        }
        let Some(desc) = self.descs.get(t).cloned().filter(|d| d.kind == PluginKind::Instrument) else {
            self.warn_once(format!("rack-inst:{owner}:{chain}:{t}"), format!("Rack {owner}: instrument '{t}' is not available; chain {chain} is silent"));
            return None;
        };
        let mut ip = InstPlan { type_id: t.to_string(), sample: None, multi: None, sample_root: None };
        if desc.uses_sample == Some(true) {
            if let Some(sid) = &g.sample_id {
                let path = match model.samples.get(sid) {
                    Some(s) => match self.resolve(&s.path) {
                        Ok(p) => Some(p),
                        Err(e) => {
                            self.warn_once(format!("resolve:{e}"), format!("{e}. Channels that use it stay silent."));
                            None
                        }
                    },
                    None => {
                        self.warn_once(format!("rack-sample:{owner}:{chain}:{sid}"), format!("Rack {owner}: chain {chain} references missing sample {sid}"));
                        None
                    }
                };
                if let Some(p) = path {
                    if is_sfz(&p) {
                        if t == multisampler::PLUGIN_ID {
                            ip.multi = self.multi_for(&p);
                        } else {
                            self.warn_once(
                                format!("sfz-inst:{owner}:{chain}"),
                                format!("Rack {owner}: {} is an SFZ instrument, which only Krypt Multisampler plays; chain {chain} stays silent", p.display()),
                            );
                        }
                    } else {
                        ip.sample = self.sample_for(&p);
                    }
                }
            }
            if t != multisampler::PLUGIN_ID {
                ip.sample_root = Some(ip.sample.as_ref().and_then(|d| d.root_key).map(|k| k as f32).unwrap_or(60.0));
            }
        }
        Some((ip, desc))
    }

    /// A chain device: a stock, non-rack effect.
    fn rack_device(&mut self, owner: &str, chain: &str, fx: &FxSlot) -> Option<Arc<PluginDescriptor>> {
        let t = fx.type_id.as_str();
        if is_rack(t) {
            self.warn_once(format!("rack-nested:{owner}:{chain}:{}", fx.id), format!("Rack {owner}: racks inside racks aren't supported yet; chain {chain}'s {t} is skipped"));
            return None;
        }
        if krypt_studio_pluginclient::is_external_id(t) {
            self.warn_once(format!("rack-3p:{owner}:{chain}:{}", fx.id), format!("Rack {owner}: third-party plugins can't go inside a rack yet; chain {chain}'s {t} is skipped"));
            return None;
        }
        let Some(desc) = self.descs.get(t).cloned().filter(|d| d.kind == PluginKind::Effect) else {
            self.warn_once(format!("rack-fx:{owner}:{chain}:{t}"), format!("Rack {owner}: effect '{t}' is not available; chain {chain} skips it"));
            return None;
        };
        if fx.sidechain_from.is_some() && desc.sidechain == Some(true) {
            self.warn_once(
                format!("rack-sc:{owner}:{chain}:{}", fx.id),
                format!("Rack {owner}: sidechain inputs inside a rack aren't supported yet; chain {chain}'s {} runs without one", desc.name),
            );
        }
        Some(desc)
    }
}

#[inline]
fn fin(v: f64, default: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        default
    }
}
