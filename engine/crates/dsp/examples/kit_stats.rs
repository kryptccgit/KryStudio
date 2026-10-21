use krypt_studio_dsp::analysis::analyze;
use krypt_studio_dsp::factory::render_kit;

fn main() {
    for (name, ch) in render_kit() {
        let l = &ch[0];
        let r = ch.get(1).unwrap_or(&ch[0]);
        let a = analyze(l, r, 48000.0);
        let env = |ms: usize| {
            let s = ms * 48;
            let e = (s + 480).min(l.len());
            if s >= l.len() { return -120.0 }
            let p = l[s..e].iter().fold(0.0f32, |m, v| m.max(v.abs()));
            20.0 * p.max(1e-6).log10()
        };
        println!(
            "{name:14} len {:5.0} ms ch {} peak {:5.1} tp {:5.1} rms {:6.1} crest {:5.1} | sub {:6.1} low {:6.1} lmid {:6.1} mid {:6.1} hmid {:6.1} high {:6.1} | cen {:6.0} Hz | env@0/20/50/100/200/400ms {:5.1} {:5.1} {:5.1} {:5.1} {:5.1} {:5.1} corr {:.2}",
            a.duration_sec * 1000.0, ch.len(), a.peak_db, a.true_peak_db, a.rms_db, a.crest_db,
            a.bands.sub, a.bands.low, a.bands.low_mid, a.bands.mid, a.bands.high_mid, a.bands.high,
            a.spectral_centroid_hz, env(0), env(20), env(50), env(100), env(200), env(400), a.stereo_correlation
        );
    }
}
