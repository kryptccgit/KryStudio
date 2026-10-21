//! Drum hits from a (preferably drum-stem) signal: band-split onset detection
//! and rule-based roles. Krypt-original DSP (ADTOF/madmom models are
//! non-commercial and are not used).
//!
//! Onsets come from log-band spectral flux (broadband and > 5 kHz alone) and
//! summed-power rises per region (STFT 1024 / hop 128 at 22 050 Hz,
//! ≈ 5.8 ms). Each onset's rise is measured in four regions — low 30–150 Hz
//! (kick), body 150–800 Hz, crack 0.8–5 kHz (snare, clap), air 5–11 kHz
//! (hats, cymbals) — over the level just before it, and counts only when it
//! is a real attack in dB (a ringing kick or 808 swelling under a hat is
//! not), then is normalised per region by the track's typical hit, so a
//! quiet hat in a loud mix still counts. Several roles can fire on one onset
//! (kick + hat, kick + snare): a snare or clap on a kick is told from the
//! kick's own click by its ringing crack band, and a crack-led hit without
//! that ring is a rim / stick (perc). Hats ringing longer than 120 ms are
//! open hats. A hat under a kick, clap or snare is inaudible next to it (a
//! bus limiter ducks it too), so a hat stream that runs on through such hits
//! is continued over them ([`continue_hat_streams`]); hats on the offbeats
//! only stay on the offbeats.

use crate::features::{self, percentile};
use crate::protocol::{DrumHit, DrumRole};
use crate::{JobCtx, JobError};

const REGIONS: [(f32, f32); 4] = [(30.0, 150.0), (150.0, 800.0), (800.0, 5000.0), (5000.0, 11_025.0)];
/// Low-band attack window (frames of ≈ 5.8 ms).
const LOW_ATTACK_FRAMES: usize = 10;
/// A kick's attack and its body this close (s) are one kick (shorter than a
/// 16th at 174 bpm, 86 ms; only kicks merge, so 32nd hat rolls stay).
const SPLIT_KICK_SEC: f32 = 0.07;

/// A region's rise counts as an attack only when it is at least this far (dB,
/// per region) over the level just before the onset. A kick or 808 that
/// still rings swells and beats by up to ~3 dB under the next hat; read as a
/// linear increase, that swell dwarfed the hat and the hat became a kick.
/// Real kicks rise 10–55 dB in the low band; strokes deep in a snare roll
/// rise only 2–3 dB in crack and air.
const ATTACK_DB: [f32; 4] = [6.0, 3.0, 2.0, 2.0];
/// Region power floor for dB ratios, relative to the region's loudest frame (−55 dB).
const REGION_FLOOR: f32 = 3.2e-6;
/// Crack-band (0.8–5 kHz) rise left 35–58 ms after the attack, relative to
/// the attack's rise (dB). Snares and claps ring on (measured −5..+5 dB), a
/// kick's click, a rim or a stick is gone (−18..−40 dB).
const SNARE_TAIL_DB: f32 = -10.0;
/// Crack-led hits whose crack tail is below this are clicks (rim, stick): perc.
const CLICK_TAIL_DB: f32 = -14.0;
/// A snare-led onset whose crack rise is under this share of the typical
/// snare's is a swell or a hat on a snare's ring, not a stroke (ghost notes
/// at a third of the velocity still rise ~12%).
const SNARE_MIN_CRACK: f32 = 0.1;
/// A snare onset this soon (s) after another one that rises less than
/// [`SNARE_REBURST_DB`] in the crack band is the first one's later burst
/// (a clap's bursts come ~40 ms apart; a new roll stroke rises 6–10 dB).
const SNARE_BURST_SEC: f32 = 0.05;
const SNARE_REBURST_DB: f32 = 6.5;
/// Absolute floor of the broadband flux onset envelope (mean dB rise per
/// frame over all bands; [`features::ONSET_FLOOR`] is 3). Strokes of a dense
/// snare roll overlap and peak at 2–2.7.
const DRUM_ONSET_FLOOR: f32 = 2.2;
/// A hit 40–50 dB under the track's strongest one still counts when some
/// region rises at least this much (dB): hats in a fade-out.
const QUIET_HIT_RISE_DB: f32 = 15.0;
/// Absolute floor of the >5 kHz band flux onset envelope (mean dB rise per
/// frame over those bands). Hats peak at 2–5 even inside a ringing open hat
/// or crash; steady noise stays under ~0.5.
const HIGH_FLUX_FLOOR: f32 = 1.1;
/// Hat-stream continuation: hat intervals considered (s; 32nds at 180 bpm to
/// quarters at 60 bpm) and the most grid steps walked across one gap.
const STREAM_MIN_IOI_SEC: f32 = 0.04;
const STREAM_MAX_IOI_SEC: f32 = 1.0;
const STREAM_MAX_STEPS: usize = 64;

/// Hats that a louder hit masks. `times` are onset times (frames), `hats`
/// the onsets that are hats (ascending), `airy[i]` whether onset `i` has an
/// air-band attack at all. Each gap between two consecutive hats is crossed
/// by walking a hat grid from one side: each step repeats the interval from
/// two steps back (so straight and swung streams both continue) and
/// re-anchors on the onset it lands on. The grid comes from the local hat
/// period (the most common interval between hats within 3 s), else from
/// the three hats on either side when the hats also go on past the other
/// side (a gap inside a stream, not its end). A gap is
/// filled only when every grid step inside it lands on an airy onset; a
/// grid step with no onset means the stream stopped (a break) and nothing
/// is added, and a stream that reaches the other hat without a step in
/// between (offbeat hats over kicks and snares) is left as it is.
/// Returns the onsets to add a hat to.
fn continue_hat_streams(times: &[f32], hats: &[usize], airy: &[bool], fps: f32) -> Vec<usize> {
    let (min_ioi, max_ioi) = (STREAM_MIN_IOI_SEC * fps, STREAM_MAX_IOI_SEC * fps);
    let max_tol = (0.025 * fps).max(2.0);
    // One walk from hat `anchor` (with its two previous intervals, older
    // first) towards hat `goal`; `dir` = +1 forwards, -1 backwards. Returns
    // the onsets landed on, or None when the stream breaks.
    let walk = |anchor: usize, d2: f32, d1: f32, goal: usize, dir: f32| -> Option<Vec<usize>> {
        if [d1, d2].iter().any(|d| !(min_ioi..=max_ioi).contains(d)) {
            return None;
        }
        let (lo, hi) = (anchor.min(goal), anchor.max(goal));
        let (mut d2, mut d1, mut cur) = (d2, d1, times[anchor]);
        let mut got = Vec::new();
        for _ in 0..STREAM_MAX_STEPS {
            let tol = (0.2 * d1.min(d2)).clamp(2.0, max_tol);
            let expect = cur + dir * d2;
            if (expect - times[goal]).abs() <= tol {
                return Some(got);
            }
            if (expect - times[goal]) * dir > 0.0 {
                // Past the other hat without landing on it (a roll or a
                // swing change there): fine if the walk covered the gap.
                return (!got.is_empty()).then_some(got);
            }
            let j = (lo + 1..hi).filter(|&j| (times[j] - expect).abs() <= tol).min_by(|&a, &b| (times[a] - expect).abs().total_cmp(&(times[b] - expect).abs()))?;
            if !airy[j] {
                return None;
            }
            got.push(j);
            let step = (times[j] - cur).abs();
            (d2, d1, cur) = (d1, step, times[j]);
        }
        None
    };
    // The two intervals of the three hats ending at hats[w] (forwards) or
    // starting there (backwards).
    let stream = |w: usize, dir: isize| -> Option<(f32, f32)> {
        let at = |k: isize| -> Option<f32> { hats.get(usize::try_from(w as isize - dir * k).ok()?).map(|&i| times[i]) };
        let (h0, h1, h2) = (at(0)?, at(1)?, at(2)?);
        Some(((h1 - h2).abs(), (h0 - h1).abs()))
    };
    // Whether the hats go on past `goal` (hats[g]) away from the walk:
    // a gap inside a hat stream, not the stream's end.
    let continues = |g: usize, dir: isize, d: f32| -> bool {
        usize::try_from(g as isize + dir).ok().and_then(|k| hats.get(k)).is_some_and(|&k| (times[k] - times[hats[g]]).abs() <= 2.2 * d)
    };
    let mut out = Vec::new();
    for w in 0..hats.len().saturating_sub(1) {
        let (a, b) = (hats[w], hats[w + 1]);
        if b <= a + 1 {
            continue; // no onset between them
        }
        let dominant = || -> Option<Vec<usize>> {
            let (t0, t1) = (times[a] - 3.0 * fps, times[b] + 3.0 * fps);
            let iois: Vec<f32> = hats.windows(2).filter(|p| times[p[0]] >= t0 && times[p[1]] <= t1).map(|p| times[p[1]] - times[p[0]]).filter(|d| (min_ioi..=max_ioi).contains(d)).collect();
            let direct = |x: f32| iois.iter().filter(|&&y| (y - x).abs() <= 0.08 * x).count();
            // A period also explains the intervals that skip one masked hat.
            let support = |x: f32| direct(x) + iois.iter().filter(|&&y| (y - 2.0 * x).abs() <= 0.08 * x).count();
            let p = iois.iter().copied().filter(|&x| direct(x) >= 3).max_by(|&x, &y| support(x).cmp(&support(y)).then(x.total_cmp(&y)))?;
            walk(a, p, p, b, 1.0).or_else(|| walk(b, p, p, a, -1.0))
        };
        let neighbours = || {
            let fwd = stream(w, 1).filter(|&(d2, d1)| continues(w + 1, 1, d2.max(d1)));
            let back = || stream(w + 1, -1).filter(|&(d2, d1)| continues(w, -1, d2.max(d1)));
            fwd.and_then(|(d2, d1)| walk(a, d2, d1, b, 1.0)).or_else(|| back().and_then(|(d2, d1)| walk(b, d2, d1, a, -1.0)))
        };
        if let Some(got) = dominant().or_else(neighbours) {
            out.extend(got);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// One kick that produced two onsets becomes one: a kick within
/// [`SPLIT_KICK_SEC`] after a body-led perc onset is that perc's body (the
/// kick, at the perc's time), and a second kick that close is dropped (the
/// stronger strength kept). A dry click (rim, stick) stays a perc.
/// `hits` is (time, role, strength, may be a kick's attack).
fn merge_split_hits(mut hits: Vec<(f32, DrumRole, f32, bool)>) -> Vec<(f32, DrumRole, f32)> {
    hits.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f32, DrumRole, f32, bool)> = Vec::with_capacity(hits.len());
    for h in hits {
        if h.1 == DrumRole::Kick {
            let near = |x: &&mut (f32, DrumRole, f32, bool)| h.0 - x.0 < SPLIT_KICK_SEC;
            if let Some(k) = out.iter_mut().rev().take_while(near).find(|x| x.1 == DrumRole::Kick) {
                k.2 = k.2.max(h.2);
                continue;
            }
            if let Some(p) = out.iter_mut().rev().take_while(near).find(|x| x.1 == DrumRole::Perc && x.3) {
                p.1 = DrumRole::Kick;
                p.2 = p.2.max(h.2);
                continue;
            }
        }
        out.push(h);
    }
    out.into_iter().map(|h| (h.0, h.1, h.2)).collect()
}

pub struct DrumParams {
    /// 0..1, higher = fewer hits (onset sensitivity).
    pub sensitivity: f32,
}

pub fn transcribe(x: &[f32], sr: f32, p: &DrumParams, ctx: &JobCtx) -> Result<Vec<DrumHit>, JobError> {
    let spec = features::power_spectrogram(x, sr, 1024, 128, 512, ctx)?;
    let fps = spec.fps();
    let n = spec.frames;
    if n < 8 {
        return Ok(Vec::new());
    }
    ctx.check()?;
    let bands = features::log_bands(&spec, 30.0, sr * 0.5 * 0.98, 48);
    let db = features::band_db(&spec, &bands);
    let env = features::flux(&db, &bands, 0.0, f32::MAX);
    // Region powers (linear, mean per bin) per frame.
    let bin_hz = spec.bin_hz();
    let reg_bins: Vec<(usize, usize)> = REGIONS
        .iter()
        .map(|&(lo, hi)| {
            let a = ((lo / bin_hz).floor() as usize).max(1);
            let b = ((hi / bin_hz).ceil() as usize).min(spec.bins).max(a + 1);
            (a, b)
        })
        .collect();
    let power: Vec<[f32; 4]> = (0..n)
        .map(|t| {
            let f = spec.frame(t);
            let mut r = [0f32; 4];
            for (k, &(a, b)) in reg_bins.iter().enumerate() {
                r[k] = f[a..b].iter().sum::<f32>();
            }
            r
        })
        .collect();
    // Onsets: broadband flux, a summed-power rise per region (a hat only
    // moves the top bands, which the broadband mean dilutes) and the flux of
    // the bands above 5 kHz alone (a closed hat that chokes an open hat or
    // lands in a crash's ring rises only a few dB in summed power, but its
    // own bands jump).
    let delta = 0.2 + 1.2 * p.sensitivity.clamp(0.0, 1.0);
    let rise = features::region_rise(&spec, &REGIONS, ((0.012 * fps).round() as usize).max(1));
    let high_flux = features::flux(&db, &bands, REGIONS[3].0, f32::MAX);
    let floor_scale = 0.75 + 0.5 * p.sensitivity.clamp(0.0, 1.0);
    let mut envs: Vec<(&[f32], f32)> = vec![(&env, DRUM_ONSET_FLOOR * floor_scale), (&high_flux, HIGH_FLUX_FLOOR * floor_scale)];
    envs.extend(rise.iter().map(|r| (r.as_slice(), features::REGION_RISE_DB * floor_scale)));
    let onsets = features::merged_onsets(&envs, fps, delta, 0.025);
    if onsets.is_empty() {
        return Ok(Vec::new());
    }
    // Per-onset features per region: the level just before the onset (min
    // over -4..-1 frames), the attack peak (max over 0..+4, up to the next
    // onset) and their ratio in dB. After a body-led attack the low region
    // looks further (0..+10 frames, ~58 ms, even past the next onset): a
    // big-room kick's attack is a click and a sweep that reaches the low band
    // ~30 ms in, which otherwise reads as a perc hit plus a late second onset.
    struct Ev {
        t: usize,
        /// Linear rise per region; 0 where the rise is under [`ATTACK_DB`].
        inc: [f32; 4],
        /// Attack peak per region.
        after: [f32; 4],
        /// Rise per region (dB).
        rise_db: [f32; 4],
        /// Crack-region rise left 35–58 ms in, relative to the attack's rise (dB).
        crack_tail_db: Option<f32>,
        decay_ms: f32,
        flux: f32,
    }
    let rmax: [f32; 4] = std::array::from_fn(|k| power.iter().map(|r| r[k]).fold(0f32, f32::max));
    let fl: [f32; 4] = std::array::from_fn(|k| (rmax[k] * REGION_FLOOR).max(1e-20));
    let mut evs: Vec<Ev> = Vec::with_capacity(onsets.len());
    for (oi, &t) in onsets.iter().enumerate() {
        let next = onsets.get(oi + 1).copied().unwrap_or(n);
        let reach = (t + 5).min(next.max(t + 1)).min(n);
        let mut before = [0f32; 4];
        let mut after = [0f32; 4];
        let mut peak_air = (t, 0f32);
        for k in 0..4 {
            if t > 0 {
                before[k] = (t.saturating_sub(4)..t).map(|i| power[i][k]).fold(f32::MAX, f32::min);
            }
            for (i, row) in power.iter().enumerate().take(reach).skip(t) {
                if row[k] > after[k] {
                    after[k] = row[k];
                    if k == 3 {
                        peak_air = (i, row[k]);
                    }
                }
            }
        }
        // A body-led attack (a kick's click and sweep): the low band gets a longer look.
        let raw: [f32; 4] = std::array::from_fn(|k| (after[k] - before[k]).max(0.0));
        if raw[1] / raw.iter().sum::<f32>().max(1e-30) >= 0.4 {
            let late = power.iter().take((t + LOW_ATTACK_FRAMES).min(n)).skip(t).map(|r| r[0]).fold(0f32, f32::max);
            after[0] = after[0].max(late);
        }
        let rise_db: [f32; 4] = std::array::from_fn(|k| 10.0 * ((after[k] + fl[k]) / (before[k] + fl[k])).log10());
        let inc: [f32; 4] = std::array::from_fn(|k| if rise_db[k] >= ATTACK_DB[k] { (after[k] - before[k]).max(0.0) } else { 0.0 });
        // Crack tail 35–58 ms in: how much of the attack's own rise is left
        // (over the level before it, so a ringing hat or snare underneath
        // doesn't count). A flam / split onset closer than 40 ms is ignored.
        let te = (t + 10).min(n).min(if next >= t + 7 { next } else { n });
        let crack_tail_db = (t + 6 < te).then(|| {
            let m = (t + 6..te).map(|i| power[i][2]).sum::<f32>() / (te - t - 6) as f32;
            10.0 * ((m - before[2]).max(fl[2]) / (after[2] - before[2]).max(fl[2])).log10()
        });
        // Air-band ring time: until 20 dB below its attack peak (or the next onset).
        let mut end = peak_air.0;
        while end + 1 < n && end + 1 < next && power[end + 1][3] > peak_air.1 * 0.01 {
            end += 1;
        }
        let ring_to_next = end + 1 >= next && next < n;
        let mut decay_ms = (end - peak_air.0) as f32 / fps * 1000.0;
        if ring_to_next {
            decay_ms = decay_ms.max(150.0); // still ringing when the next hit arrives
        }
        evs.push(Ev { t, inc, after, rise_db, crack_tail_db, decay_ms, flux: env[t] });
    }
    ctx.check()?;
    let global = evs.iter().map(|e| e.inc.iter().sum::<f32>()).fold(0f32, f32::max).max(1e-12);
    // Pass 1: dominant class from where the energy rise sits.
    #[derive(Clone, Copy, PartialEq)]
    enum Dom {
        Kick,
        Snare,
        /// Crack-led but dry (rim, stick, click): no snare tail.
        Click,
        Air,
        Body,
        None,
    }
    let shares: Vec<[f32; 4]> = evs
        .iter()
        .map(|e| {
            let tot = e.inc.iter().sum::<f32>().max(1e-30);
            [e.inc[0] / tot, e.inc[1] / tot, e.inc[2] / tot, e.inc[3] / tot]
        })
        .collect();
    let mut dom: Vec<Dom> = evs
        .iter()
        .zip(&shares)
        .map(|(e, sh)| {
            let tot = e.inc.iter().sum::<f32>();
            let sharp = e.rise_db.iter().fold(f32::MIN, |a, &b| a.max(b)) >= QUIET_HIT_RISE_DB;
            if tot < global * 1e-5 || (tot < global * 1e-4 && !sharp) {
                // Inaudible next to the track's strongest hit (−40 dB), unless
                // it is a clear attack in a quiet passage (a fade): −50 dB.
                Dom::None
            } else if sh[0] >= 0.3 {
                Dom::Kick
            } else if sh[3] >= 0.5 {
                Dom::Air
            } else if sh[2] + sh[3] >= 0.12 && sh[1] + sh[2] >= 0.4 {
                if e.crack_tail_db.is_some_and(|d| d < CLICK_TAIL_DB) {
                    Dom::Click
                } else {
                    Dom::Snare
                }
            } else {
                Dom::Body
            }
        })
        .collect();
    let typical_of = |dom: &[Dom], d: Dom, f: &dyn Fn(&Ev) -> f32| -> Option<f32> {
        let v: Vec<f32> = evs.iter().zip(dom).filter(|(_, &x)| x == d).map(|(e, _)| f(e)).collect();
        (!v.is_empty()).then(|| percentile(&v, 0.5))
    };
    // A kick on a kick or 808 that still rings: the low band barely rises,
    // the body (150–800 Hz) carries the attack and the low band is as loud as
    // a typical kick's.
    if let (Some(kick_low), Some(kick_body)) = (typical_of(&dom, Dom::Kick, &|e| e.after[0]), typical_of(&dom, Dom::Kick, &|e| e.inc[1])) {
        for (d, e) in dom.iter_mut().zip(&evs) {
            if *d == Dom::Body && e.after[0] >= 0.3 * kick_low && e.inc[1] >= 0.3 * kick_body {
                *d = Dom::Kick;
            }
        }
    }
    // A kick's own crack-band rise per unit of low-band rise (its click):
    // a snare or clap on the kick has to add clearly more than that, and
    // keep ringing.
    let kick_crack: Vec<f32> = evs.iter().zip(&dom).filter(|(e, &d)| d == Dom::Kick && e.inc[0] > 0.0).map(|(e, _)| e.inc[2] / e.inc[0]).collect();
    let kick_crack_ratio = (kick_crack.len() >= 4).then(|| percentile(&kick_crack, 0.25));
    let snare_on_kick: Vec<bool> = evs
        .iter()
        .zip(&dom)
        .map(|(e, &d)| d == Dom::Kick && e.inc[2] > 0.0 && e.crack_tail_db.is_some_and(|tail| tail >= SNARE_TAIL_DB) && kick_crack_ratio.is_none_or(|q| e.inc[2] >= 1.3 * q * e.inc[0]))
        .collect();
    // Typical hat / snare rises, from hits where they dominate (snares and
    // claps on kicks included: in four-on-the-floor every clap is on one).
    let ref_air = typical_of(&dom, Dom::Air, &|e| e.inc[3]).unwrap_or(f32::MAX);
    let crack: Vec<f32> = evs.iter().zip(&dom).zip(&snare_on_kick).filter(|((_, &d), &sk)| d == Dom::Snare || sk).map(|((e, _), _)| e.inc[2]).collect();
    let ref_crack = (!crack.is_empty()).then(|| percentile(&crack, 0.5));
    let fmax = evs.iter().map(|e| e.flux).fold(0f32, f32::max).max(1e-9);
    // Pass 2: roles (several per onset when hits coincide).
    let mut roles: Vec<Vec<(DrumRole, f32)>> = Vec::with_capacity(evs.len());
    for (i, e) in evs.iter().enumerate() {
        let mut r: Vec<(DrumRole, f32)> = Vec::new();
        let air_role = if e.decay_ms > 120.0 { DrumRole::Openhat } else { DrumRole::Hat };
        match dom[i] {
            Dom::None => {}
            Dom::Kick => {
                r.push((DrumRole::Kick, e.inc[0]));
                // A snare or clap on top of the kick: the crack band rises
                // beyond the kick's own click and keeps ringing.
                let snare = match e.crack_tail_db {
                    Some(_) => snare_on_kick[i] && ref_crack.is_none_or(|c| e.inc[2] >= 0.15 * c),
                    None => ref_crack.is_some_and(|c| e.inc[2] >= 0.5 * c),
                };
                if snare {
                    r.push((DrumRole::Snare, e.inc[2]));
                } else if e.inc[3] >= 0.5 * ref_air && e.inc[3] >= 2.0 * e.inc[2] {
                    r.push((air_role, e.inc[3]));
                }
            }
            // A snare's crack band rises (beating and swells move the body and air only).
            Dom::Snare if ref_crack.is_some_and(|c| e.inc[2] < SNARE_MIN_CRACK * c) => {}
            Dom::Snare => {
                r.push((DrumRole::Snare, e.inc[2]));
                if e.inc[3] >= 0.5 * ref_air && e.inc[3] >= 3.0 * e.inc[2] {
                    r.push((air_role, e.inc[3]));
                }
            }
            Dom::Click => {
                r.push((DrumRole::Perc, e.inc[1] + e.inc[2]));
                if e.inc[3] >= 0.5 * ref_air && e.inc[3] >= 0.5 * e.inc[2] {
                    r.push((air_role, e.inc[3]));
                }
            }
            Dom::Air => r.push((air_role, e.inc[3])),
            Dom::Body => {
                if e.flux >= 0.1 * fmax || e.inc.iter().sum::<f32>() >= global * 1e-2 {
                    r.push((DrumRole::Perc, e.inc.iter().sum::<f32>()));
                }
            }
        }
        // A clap's later bursts (or a snare's rattle) right after a snare
        // onset rise only a few dB over its ring: still the same hit.
        if e.rise_db[2] < SNARE_REBURST_DB && r.iter().any(|x| x.0 == DrumRole::Snare) {
            let near = (0..i).rev().take_while(|&j| (e.t - evs[j].t) as f32 <= SNARE_BURST_SEC * fps).any(|j| roles[j].iter().any(|x| x.0 == DrumRole::Snare));
            if near {
                r.retain(|x| x.0 != DrumRole::Snare);
            }
        }
        roles.push(r);
    }
    // Pass 3: hats hidden under louder hits. A kick, clap or snare masks a
    // hat on it (its own click and noise are as loud as the hat, and a bus
    // limiter ducks the hat), so a hat stream that runs on through such hits
    // is continued: see [`continue_hat_streams`].
    if ref_air < f32::MAX {
        let is_hat = |r: &[(DrumRole, f32)]| r.iter().any(|x| matches!(x.0, DrumRole::Hat | DrumRole::Openhat));
        let hats: Vec<usize> = (0..evs.len()).filter(|&i| is_hat(&roles[i])).collect();
        let times: Vec<f32> = evs.iter().map(|e| e.t as f32).collect();
        let airy: Vec<bool> = evs.iter().map(|e| e.inc[3] >= 0.1 * ref_air).collect();
        for i in continue_hat_streams(&times, &hats, &airy, fps) {
            roles[i].push((DrumRole::Hat, evs[i].inc[3].min(ref_air)));
        }
    }
    let mut hits: Vec<(f32, DrumRole, f32, bool)> = Vec::new();
    for (i, e) in evs.iter().enumerate() {
        let time = e.t as f32 / fps + features::onset_latency(spec.n_fft, sr);
        for &(r, s) in &roles[i] {
            hits.push((time, r, s, dom[i] != Dom::Click));
        }
    }
    let hits = merge_split_hits(hits);
    // Velocity: per role, relative to the role's strongest hit (square-root curve).
    let mut out = Vec::with_capacity(hits.len());
    for role in [DrumRole::Kick, DrumRole::Snare, DrumRole::Hat, DrumRole::Openhat, DrumRole::Perc] {
        let max = hits.iter().filter(|h| h.1 == role).map(|h| h.2).fold(0f32, f32::max).max(1e-9);
        for h in hits.iter().filter(|h| h.1 == role) {
            let v = (h.2 / max).sqrt().clamp(0.1, 1.0);
            out.push(DrumHit { time_sec: crate::analyze::ms(h.0), role, vel: (v * 1000.0).round() / 1000.0 });
        }
    }
    out.sort_by(|a, b| a.time_sec.total_cmp(&b.time_sec));
    Ok(out)
}
