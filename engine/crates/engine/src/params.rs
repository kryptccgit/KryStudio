//! ParamRef parsing (mirrors shared/schema/params.ts) and the built-in specs.

use krypt_studio_dsp::ParamSpec;

#[derive(Debug, Clone, PartialEq)]
pub enum ParamRef {
    Transport(TransportParam),
    Channel { channel: String, param: ChannelParam },
    Gen { channel: String, param: String },
    Insert { insert: String, param: InsertParam },
    Slot { insert: String, slot: String, param: String },
    Route { insert: String, target: String },
    /// A param inside a rack (Wave 12.2b): `<host>/rack/<chainId>/…`.
    Rack { host: RackHost, chain: String, what: RackParam },
}

/// The rack a `Rack` ref lives in.
#[derive(Debug, Clone, PartialEq)]
pub enum RackHost {
    /// `channel/<ch>`: an instrument / drum rack.
    Channel(String),
    /// `insert/<i>/slot/<s>`: an effect rack.
    Slot { insert: String, slot: String },
}

/// What a `Rack` ref names inside its chain (= a macro target, rack.rs).
#[derive(Debug, Clone, PartialEq)]
pub enum RackParam {
    /// `volume` | `pan`.
    Chain(String),
    /// `inst/<paramId>`.
    Inst(String),
    /// `dev/<deviceId>/<paramId | mix>`.
    Dev { device: String, param: String },
}

/// `rack/<chainId>/…` starting at `p[i]`.
fn parse_rack_tail(p: &[&str], i: usize) -> Option<(String, RackParam)> {
    if p.get(i) != Some(&"rack") || p.iter().any(|x| x.is_empty()) {
        return None;
    }
    let chain = p.get(i + 1)?.to_string();
    let what = match &p[i + 2..] {
        [x] if *x == "volume" || *x == "pan" => RackParam::Chain(x.to_string()),
        ["inst", param] => RackParam::Inst(param.to_string()),
        ["dev", device, param] => RackParam::Dev { device: device.to_string(), param: param.to_string() },
        _ => return None,
    };
    Some((chain, what))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TransportParam {
    Bpm,
    Swing,
    MasterVolume,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ChannelParam {
    Volume,
    Pan,
    Pitch,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InsertParam {
    Volume,
    Pan,
    StereoSep,
}

pub fn parse_param_ref(s: &str) -> Option<ParamRef> {
    let p: Vec<&str> = s.split('/').collect();
    match (p.first().copied(), p.len()) {
        (Some("transport"), 2) => {
            let t = match p[1] {
                "bpm" => TransportParam::Bpm,
                "swing" => TransportParam::Swing,
                "masterVolume" => TransportParam::MasterVolume,
                _ => return None,
            };
            Some(ParamRef::Transport(t))
        }
        (Some("channel"), 3) => {
            let c = match p[2] {
                "volume" => ChannelParam::Volume,
                "pan" => ChannelParam::Pan,
                "pitch" => ChannelParam::Pitch,
                _ => return None,
            };
            Some(ParamRef::Channel { channel: p[1].to_string(), param: c })
        }
        (Some("channel"), 4) if p[2] == "gen" => Some(ParamRef::Gen { channel: p[1].to_string(), param: p[3].to_string() }),
        (Some("insert"), 3) => {
            let i = match p[2] {
                "volume" => InsertParam::Volume,
                "pan" => InsertParam::Pan,
                "stereoSep" => InsertParam::StereoSep,
                _ => return None,
            };
            Some(ParamRef::Insert { insert: p[1].to_string(), param: i })
        }
        (Some("insert"), 5) if p[2] == "slot" => Some(ParamRef::Slot { insert: p[1].to_string(), slot: p[3].to_string(), param: p[4].to_string() }),
        (Some("insert"), 4) if p[2] == "route" => Some(ParamRef::Route { insert: p[1].to_string(), target: p[3].to_string() }),
        (Some("channel"), n) if n >= 5 && p[2] == "rack" => parse_rack_tail(&p, 2).map(|(chain, what)| ParamRef::Rack { host: RackHost::Channel(p[1].to_string()), chain, what }),
        (Some("insert"), n) if n >= 7 && p[2] == "slot" && p[4] == "rack" => {
            parse_rack_tail(&p, 4).map(|(chain, what)| ParamRef::Rack { host: RackHost::Slot { insert: p[1].to_string(), slot: p[3].to_string() }, chain, what })
        }
        _ => None,
    }
}

fn spec(id: &'static str, name: &'static str, min: f32, max: f32, default: f32, unit: &'static str, scale: &'static str) -> ParamSpec {
    ParamSpec { id, name, min, max, default, unit, scale, step: None, options: None, group: None, automatable: None }
}

/// BUILTIN_SPECS from params.ts.
pub fn spec_bpm() -> ParamSpec {
    spec("bpm", "Tempo", 10.0, 999.0, 140.0, "bpm", "linear")
}
pub fn spec_swing() -> ParamSpec {
    spec("swing", "Swing", 0.0, 1.0, 0.0, "%", "linear")
}
pub fn spec_master_volume() -> ParamSpec {
    spec("masterVolume", "Master volume", 0.0, 2.0, 1.0, "", "gain")
}
pub fn spec_channel_volume() -> ParamSpec {
    spec("volume", "Volume", 0.0, 1.25, 0.78, "", "gain")
}
pub fn spec_pan() -> ParamSpec {
    spec("pan", "Pan", -1.0, 1.0, 0.0, "", "linear")
}
pub fn spec_pitch() -> ParamSpec {
    spec("pitch", "Pitch", -24.0, 24.0, 0.0, "st", "linear")
}
pub fn spec_insert_volume() -> ParamSpec {
    spec("volume", "Volume", 0.0, 2.0, 1.0, "", "gain")
}
pub fn spec_stereo_sep() -> ParamSpec {
    spec("stereoSep", "Stereo separation", -1.0, 1.0, 0.0, "", "linear")
}
pub fn spec_mix() -> ParamSpec {
    spec("mix", "Mix", 0.0, 1.0, 1.0, "%", "linear")
}
pub fn spec_route() -> ParamSpec {
    spec("route", "Send level", 0.0, 2.0, 1.0, "", "gain")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_forms() {
        assert_eq!(parse_param_ref("transport/bpm"), Some(ParamRef::Transport(TransportParam::Bpm)));
        assert_eq!(parse_param_ref("transport/masterVolume"), Some(ParamRef::Transport(TransportParam::MasterVolume)));
        assert_eq!(parse_param_ref("transport/nope"), None);
        assert_eq!(parse_param_ref("channel/c1/pan"), Some(ParamRef::Channel { channel: "c1".into(), param: ChannelParam::Pan }));
        assert_eq!(parse_param_ref("channel/c1/gen/cutoff"), Some(ParamRef::Gen { channel: "c1".into(), param: "cutoff".into() }));
        assert_eq!(parse_param_ref("insert/i1/stereoSep"), Some(ParamRef::Insert { insert: "i1".into(), param: InsertParam::StereoSep }));
        assert_eq!(
            parse_param_ref("insert/i1/slot/s1/mix"),
            Some(ParamRef::Slot { insert: "i1".into(), slot: "s1".into(), param: "mix".into() })
        );
        assert_eq!(parse_param_ref("insert/i1/route/m"), Some(ParamRef::Route { insert: "i1".into(), target: "m".into() }));
        assert_eq!(parse_param_ref("insert/i1/bogus/x"), None);
        // Inside racks (shared/schema/params.ts, Wave 12.2b).
        assert_eq!(
            parse_param_ref("channel/c1/rack/k1/volume"),
            Some(ParamRef::Rack { host: RackHost::Channel("c1".into()), chain: "k1".into(), what: RackParam::Chain("volume".into()) })
        );
        assert_eq!(
            parse_param_ref("channel/c1/rack/k1/inst/cutoff"),
            Some(ParamRef::Rack { host: RackHost::Channel("c1".into()), chain: "k1".into(), what: RackParam::Inst("cutoff".into()) })
        );
        assert_eq!(
            parse_param_ref("insert/i1/slot/s1/rack/k1/dev/d1/mix"),
            Some(ParamRef::Rack {
                host: RackHost::Slot { insert: "i1".into(), slot: "s1".into() },
                chain: "k1".into(),
                what: RackParam::Dev { device: "d1".into(), param: "mix".into() }
            })
        );
        assert_eq!(parse_param_ref("insert/i1/slot/s1/rack/k1/pan").map(|r| matches!(r, ParamRef::Rack { .. })), Some(true));
        for bad in ["channel/c1/rack/k1/gain", "channel/c1/rack/k1/inst", "channel/c1/rack//volume", "channel/c1/rack/k1/dev/d1", "insert/i1/slot/s1/rack/k1/dev/d1/x/y", "channel/c1/rack/k1/inst/"] {
            assert_eq!(parse_param_ref(bad), None, "{bad}");
        }
        assert_eq!(parse_param_ref(""), None);
    }

    #[test]
    fn builtin_mapping_matches_ts() {
        use krypt_studio_dsp::from_normalized;
        assert!((from_normalized(&spec_bpm(), 0.5) - 504.5).abs() < 1e-3);
        // gain: max * n^3
        assert!((from_normalized(&spec_master_volume(), 0.5) - 0.25).abs() < 1e-6);
        assert!((from_normalized(&spec_pan(), 0.25) + 0.5).abs() < 1e-6);
    }
}
