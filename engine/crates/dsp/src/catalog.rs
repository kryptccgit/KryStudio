//! Registers every stock plugin: its descriptor (ids/params match the seed
//! shared/plugins/catalog.gen.json except the changes listed in
//! tests/catalog_seed.rs) and its constructor.

use crate::effects::{
    analyzer, chorus, clipper, comp, delay, drive, duck, eq, filter, flanger, gate, imager, limiter, phaser, pitch, reverb, squash,
    transient, utility, vocoder,
};
// wave 12.2 devices
use crate::effects::{glue, grain, heat, tapeecho};
// Auto Mix (research/20)
use crate::effects::deesser;
use crate::instruments::{audioclip, drumsynth, fm, kick808, multisampler, sampler, slicer, triosc, wavetable};
use crate::{Effect, Instrument, PluginDescriptor};

pub fn descriptors() -> Vec<PluginDescriptor> {
    vec![
        sampler::descriptor(),
        audioclip::descriptor(),
        triosc::descriptor(),
        kick808::descriptor(),
        drumsynth::descriptor(),
        eq::descriptor(),
        comp::descriptor(),
        limiter::descriptor(),
        clipper::descriptor(),
        reverb::descriptor(),
        delay::descriptor(),
        drive::descriptor(),
        filter::descriptor(),
        duck::descriptor(),
        utility::descriptor(),
        analyzer::descriptor(),
        // wave 2 (appended so existing order never changes)
        fm::descriptor(),
        wavetable::descriptor(),
        chorus::descriptor(),
        flanger::descriptor(),
        phaser::descriptor(),
        gate::descriptor(),
        vocoder::descriptor(),
        transient::descriptor(),
        squash::descriptor(),
        imager::descriptor(),
        pitch::descriptor(),
        // wave 5: real instruments (sound packs)
        multisampler::descriptor(),
        // wave 12.2: devices
        heat::descriptor(),
        tapeecho::descriptor(),
        grain::descriptor(),
        glue::descriptor(),
        // Auto Mix: the vocal de-esser
        deesser::descriptor(),
        // research/13 §8.5: the loop slicer
        slicer::descriptor(),
    ]
}

pub fn create_instrument(id: &str, sample_rate: f32, max_frames: usize) -> Option<Box<dyn Instrument>> {
    let max_frames = max_frames.max(1);
    Some(match id {
        "krypt.sampler" => Box::new(sampler::Sampler::new(sample_rate, max_frames)),
        "krypt.audioclip" => Box::new(audioclip::AudioClip::new(sample_rate, max_frames)),
        "krypt.triosc" => Box::new(triosc::TriOsc::new(sample_rate, max_frames)),
        "krypt.kick808" => Box::new(kick808::Kick808::new(sample_rate, max_frames)),
        "krypt.drumsynth" => Box::new(drumsynth::DrumSynth::new(sample_rate, max_frames)),
        "krypt.fm" => Box::new(fm::Fm::new(sample_rate, max_frames)),
        "krypt.wavetable" => Box::new(wavetable::Wavetable::new(sample_rate, max_frames)),
        multisampler::PLUGIN_ID => Box::new(multisampler::Multisampler::new(sample_rate, max_frames)),
        slicer::PLUGIN_ID => Box::new(slicer::Slicer::new(sample_rate, max_frames)),
        _ => return None,
    })
}

pub fn create_effect(id: &str, sample_rate: f32, max_frames: usize) -> Option<Box<dyn Effect>> {
    let max_frames = max_frames.max(1);
    Some(match id {
        "krypt.eq" => Box::new(eq::Eq::new(sample_rate, max_frames)),
        "krypt.comp" => Box::new(comp::Comp::new(sample_rate, max_frames)),
        "krypt.limiter" => Box::new(limiter::Limiter::new(sample_rate, max_frames)),
        "krypt.clipper" => Box::new(clipper::Clipper::new(sample_rate, max_frames)),
        "krypt.reverb" => Box::new(reverb::Reverb::new(sample_rate, max_frames)),
        "krypt.delay" => Box::new(delay::Delay::new(sample_rate, max_frames)),
        "krypt.drive" => Box::new(drive::Drive::new(sample_rate, max_frames)),
        "krypt.filter" => Box::new(filter::Filter::new(sample_rate, max_frames)),
        "krypt.duck" => Box::new(duck::Duck::new(sample_rate, max_frames)),
        "krypt.utility" => Box::new(utility::Utility::new(sample_rate, max_frames)),
        "krypt.analyzer" => Box::new(analyzer::Analyzer::new(sample_rate, max_frames)),
        "krypt.chorus" => Box::new(chorus::Chorus::new(sample_rate, max_frames)),
        "krypt.flanger" => Box::new(flanger::Flanger::new(sample_rate, max_frames)),
        "krypt.phaser" => Box::new(phaser::Phaser::new(sample_rate, max_frames)),
        "krypt.gate" => Box::new(gate::Gate::new(sample_rate, max_frames)),
        "krypt.vocoder" => Box::new(vocoder::Vocoder::new(sample_rate, max_frames)),
        "krypt.transient" => Box::new(transient::Transient::new(sample_rate, max_frames)),
        "krypt.squash" => Box::new(squash::Squash::new(sample_rate, max_frames)),
        "krypt.imager" => Box::new(imager::Imager::new(sample_rate, max_frames)),
        "krypt.pitch" => Box::new(pitch::Pitch::new(sample_rate, max_frames)),
        "krypt.heat" => Box::new(heat::Heat::new(sample_rate, max_frames)),
        "krypt.tapeecho" => Box::new(tapeecho::TapeEcho::new(sample_rate, max_frames)),
        "krypt.grain" => Box::new(grain::GrainFx::new(sample_rate, max_frames)),
        "krypt.glue" => Box::new(glue::Glue::new(sample_rate, max_frames)),
        "krypt.deesser" => Box::new(deesser::DeEsser::new(sample_rate, max_frames)),
        _ => return None,
    })
}

// ── Racks (Wave 12.2, research/16-ableton-parity.md §2.3) ────────────────
// `krypt.rack`, `krypt.drumrack` and `krypt.fxrack` are composites that the
// ENGINE builds from `Generator.rack` / `FxSlot.rack` (engine/src/rack.rs),
// so the stock factory above can't create them. They are therefore listed
// here and NOT in `descriptors()` (whose every entry the factory creates);
// the engine's stock host appends them, so `--dump-catalog` includes them.

pub const RACK_PLUGIN: &str = "krypt.rack";
pub const DRUM_RACK_PLUGIN: &str = "krypt.drumrack";
pub const FX_RACK_PLUGIN: &str = "krypt.fxrack";
pub const MACRO_PARAM_IDS: [&str; 8] = ["macro1", "macro2", "macro3", "macro4", "macro5", "macro6", "macro7", "macro8"];
const MACRO_NAMES: [&str; 8] = ["Macro 1", "Macro 2", "Macro 3", "Macro 4", "Macro 5", "Macro 6", "Macro 7", "Macro 8"];

fn macro_params() -> Vec<crate::ParamSpec> {
    MACRO_PARAM_IDS
        .iter()
        .zip(MACRO_NAMES)
        .map(|(id, name)| {
            let mut s = crate::params::lin(id, name, 0.0, 1.0, 0.0, "%", "Macros");
            s.automatable = Some(true);
            s
        })
        .collect()
}

/// The three rack devices: params `macro1`..`macro8` (0..1, default 0).
pub fn rack_descriptors() -> Vec<PluginDescriptor> {
    use crate::PluginKind;
    vec![
        PluginDescriptor {
            id: RACK_PLUGIN,
            name: "Krypt Rack",
            kind: PluginKind::Instrument,
            category: "Rack",
            description: "Instrument rack: parallel chains, each a stock instrument plus its own effects, picked per note by key and velocity zone and summed with per-chain volume, pan, mute and solo. Layer and split sounds, then drive any inner knob from 8 macros.",
            params: macro_params(),
            uses_sample: None,
            sidechain: None,
            default_mix: None,
        },
        PluginDescriptor {
            id: DRUM_RACK_PLUGIN,
            name: "Krypt Drum Rack",
            kind: PluginKind::Instrument,
            category: "Rack",
            description: "Drum rack: one pad per note (C2 = 36 up, 4x4 view), each pad a chain with its own sampler or drum synth and effects, plus choke groups (a closed hat cuts the open hat). 8 macros reach any pad knob.",
            params: macro_params(),
            uses_sample: None,
            sidechain: None,
            default_mix: None,
        },
        PluginDescriptor {
            id: FX_RACK_PLUGIN,
            name: "Krypt FX Rack",
            kind: PluginKind::Effect,
            category: "Rack",
            description: "Effect rack: splits the input into parallel chains of stock effects and sums them (parallel compression, multiband-style splits, wet/dry blends). Per-chain volume, pan, mute and solo; 8 macros reach any inner knob. The slot mix is the rack's wet/dry.",
            params: macro_params(),
            uses_sample: None,
            sidechain: None,
            default_mix: None,
        },
    ]
}
