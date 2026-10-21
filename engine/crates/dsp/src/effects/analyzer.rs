use crate::params::{param_table, ParamBank};
use crate::{Effect, PluginDescriptor, PluginKind, ProcessContext};

param_table! {
    View => not_automatable(choice("view", "View", &["Spectrum", "Scope", "Loudness"], 0, "Analyzer")),
}

pub fn descriptor() -> PluginDescriptor {
    PluginDescriptor {
        id: "krypt.analyzer",
        name: "Krypt Analyzer",
        kind: PluginKind::Effect,
        category: "Utility",
        description: "Spectrum, oscilloscope and loudness (LUFS / true peak) display. Passes audio through untouched.",
        params: param_specs(),
        uses_sample: None,
        sidechain: None,
        default_mix: Some(1.0),
    }
}

pub struct Analyzer {
    pb: ParamBank<N_PARAMS>,
}

impl Analyzer {
    pub fn new(_sample_rate: f32, _max_frames: usize) -> Self {
        Self { pb: ParamBank::new(&param_specs()) }
    }
}

impl Effect for Analyzer {
    fn prepare(&mut self, _sample_rate: f32, _max_frames: usize) {}

    fn set_param(&mut self, index: usize, value: f32) {
        self.pb.set(index, value);
    }

    fn process(&mut self, ctx: &ProcessContext, mut buf: [&mut [f32]; 2], _sc: Option<[&[f32]; 2]>) {
        let n = super::frames(ctx, &buf);
        super::sanitize_block(&mut buf, n);
    }

    fn reset(&mut self) {}
}
