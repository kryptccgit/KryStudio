use serde::Deserialize;
use std::collections::BTreeMap;

use crate::model::{FxSlot, Generator};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FollowRule {
    pub action: String,
    pub chance: f64,
    pub other_action: String,
    pub after_bars: f64,
}

impl Default for FollowRule {
    fn default() -> Self {
        Self { action: "none".into(), chance: 1.0, other_action: "none".into(), after_bars: 1.0 }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchClip {
    pub id: String,
    pub track_id: String,
    pub scene_id: String,
    pub kind: String,
    pub pattern_id: Option<String>,
    pub channel_id: Option<String>,
    pub length: f64,
    pub offset: f64,
    #[serde(rename = "loop")]
    pub looping: bool,
    pub launch_mode: String,
    pub quantize: Option<String>,
    pub follow: Option<FollowRule>,
    pub gain: Option<f64>,
}

impl Default for LaunchClip {
    fn default() -> Self {
        Self {
            id: String::new(),
            track_id: String::new(),
            scene_id: String::new(),
            kind: "pattern".into(),
            pattern_id: None,
            channel_id: None,
            length: 3840.0,
            offset: 0.0,
            looping: true,
            launch_mode: "trigger".into(),
            quantize: None,
            follow: None,
            gain: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub tempo: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionCfg {
    pub quantize: String,
    pub scene_order: Vec<String>,
    pub clip_ids: Option<Vec<String>>,
}

impl Default for SessionCfg {
    fn default() -> Self {
        Self { quantize: "1bar".into(), scene_order: Vec::new(), clip_ids: None }
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WarpMarker {
    pub id: String,
    pub sec: f64,
    pub beat: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WarpMap {
    pub mode: String,
    pub markers: Vec<WarpMarker>,
    pub beats_slice: Option<String>,
    pub beats_fade_ms: Option<f64>,
    pub grain_ms: Option<f64>,
    pub flux: Option<f64>,
}

impl Default for WarpMap {
    fn default() -> Self {
        Self { mode: "complex".into(), markers: Vec::new(), beats_slice: None, beats_fade_ms: None, grain_ms: None, flux: None }
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SliceMarker {
    pub id: String,
    pub sec: f64,
    pub pitch: Option<f64>,
    pub reverse: Option<bool>,
    pub gain: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RackZone {
    pub key_lo: f64,
    pub key_hi: f64,
    pub vel_lo: f64,
    pub vel_hi: f64,
}

impl Default for RackZone {
    fn default() -> Self {
        Self { key_lo: 0.0, key_hi: 127.0, vel_lo: 0.0, vel_hi: 1.0 }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MacroTarget {
    pub chain_id: String,
    pub kind: String,
    pub device_id: Option<String>,
    pub param: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MacroMap {
    pub id: String,
    pub target: MacroTarget,
    pub min: f64,
    pub max: f64,
}

impl Default for MacroMap {
    fn default() -> Self {
        Self { id: String::new(), target: MacroTarget::default(), min: 0.0, max: 1.0 }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RackMacro {
    pub name: String,
    pub maps: BTreeMap<String, MacroMap>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RackChain {
    pub id: String,
    pub volume: f64,
    pub pan: f64,
    pub mute: bool,
    pub solo: bool,
    pub zone: Option<RackZone>,
    pub instrument: Option<Generator>,
    pub devices: BTreeMap<String, FxSlot>,
    pub device_order: Vec<String>,
    pub choke: Option<f64>,
}

impl Default for RackChain {
    fn default() -> Self {
        Self {
            id: String::new(),
            volume: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            zone: None,
            instrument: None,
            devices: BTreeMap::new(),
            device_order: Vec::new(),
            choke: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RackDef {
    pub kind: String,
    pub chains: BTreeMap<String, RackChain>,
    pub chain_order: Vec<String>,
    pub macros: Vec<RackMacro>,
}

impl Default for RackDef {
    fn default() -> Self {
        Self { kind: "instrument".into(), chains: BTreeMap::new(), chain_order: Vec::new(), macros: Vec::new() }
    }
}

impl RackDef {
    pub fn ordered_chains(&self) -> Vec<&RackChain> {
        let mut out: Vec<&RackChain> = self.chain_order.iter().filter_map(|id| self.chains.get(id)).collect();
        for (id, c) in &self.chains {
            if !self.chain_order.contains(id) {
                out.push(c);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_rack_warp_and_launch_clip() {
        let g: Generator = serde_json::from_value(json!({
            "type": "krypt.drumrack", "params": { "macro1": 0.5 }, "sampleId": null,
            "rack": { "kind": "drum", "chainOrder": ["c1"], "chains": { "c1": {
                "id": "c1", "volume": 0.9, "pan": 0, "mute": false, "solo": false,
                "zone": { "keyLo": 36, "keyHi": 36, "velLo": 0, "velHi": 1 },
                "instrument": { "type": "krypt.sampler", "params": {}, "sampleId": "s1" },
                "devices": {}, "deviceOrder": [], "choke": 1 } },
              "macros": [{ "name": "Tone", "maps": { "m": { "id": "m", "target": { "chainId": "c1", "kind": "instrument", "param": "cutoff" }, "min": 0.2, "max": 0.9 } } }],
              "variations": {}, "variationOrder": [] }
        }))
        .unwrap();
        let r = g.rack.unwrap();
        assert_eq!(r.kind, "drum");
        assert_eq!(r.ordered_chains()[0].zone.as_ref().unwrap().key_lo, 36.0);
        assert_eq!(r.macros[0].maps["m"].target.param, "cutoff");

        let a: Generator = serde_json::from_value(json!({
            "type": "krypt.audioclip", "params": {}, "sampleId": "s",
            "warp": { "mode": "beats", "markers": [{ "id": "a", "sec": 0, "beat": 0 }, { "id": "b", "sec": 2, "beat": 4 }] }
        }))
        .unwrap();
        assert_eq!(a.warp.unwrap().markers[1].beat, 4.0);

        let c: LaunchClip = serde_json::from_value(json!({
            "id": "l", "trackId": "t", "sceneId": "s", "kind": "pattern", "patternId": "p", "color": null,
            "length": 3840, "offset": 0, "loop": true, "launchMode": "gate", "follow": { "action": "next", "chance": 0.5, "otherAction": "stop", "afterBars": 2 }
        }))
        .unwrap();
        assert!(c.looping);
        assert_eq!(c.launch_mode, "gate");
        assert_eq!(c.follow.unwrap().other_action, "stop");
    }
}
