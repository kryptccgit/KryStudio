//! Plugin factory indirection. The engine talks to plugins ONLY through the
//! krypt-studio-dsp public API; tests swap in a tiny test-only host.

use krypt_studio_dsp::{Effect, Instrument, PluginDescriptor};

#[derive(Clone, Copy)]
pub struct PluginHost {
    pub create_instrument: fn(&str, f32, usize) -> Option<Box<dyn Instrument>>,
    pub create_effect: fn(&str, f32, usize) -> Option<Box<dyn Effect>>,
    pub descriptors: fn() -> Vec<PluginDescriptor>,
}

impl PluginHost {
    /// The stock krypt-studio-dsp plugins.
    pub fn stock() -> Self {
        Self {
            create_instrument: krypt_studio_dsp::create_instrument,
            create_effect: krypt_studio_dsp::create_effect,
            // every dsp plugin + the rack devices (engine composites, rack.rs)
            descriptors: crate::rack::stock_descriptors,
        }
    }
}

#[derive(serde::Serialize)]
struct Catalog {
    version: u32,
    plugins: Vec<PluginDescriptor>,
}

/// The `catalog` response data: {"version":1,"plugins":[...]}.
pub fn catalog_json(host: &PluginHost) -> serde_json::Value {
    serde_json::to_value(Catalog { version: 1, plugins: (host.descriptors)() }).unwrap_or(serde_json::Value::Null)
}

/// `--dump-catalog` text: pretty JSON keeping the descriptor field order.
pub fn catalog_text(host: &PluginHost) -> String {
    serde_json::to_string_pretty(&Catalog { version: 1, plugins: (host.descriptors)() }).unwrap_or_else(|_| "{\"version\":1,\"plugins\":[]}".into())
}
