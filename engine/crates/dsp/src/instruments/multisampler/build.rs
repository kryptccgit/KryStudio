//! From parsed SFZ to a [`MultiSampleSet`], independent of where the audio
//! comes from: `plan` lists the distinct sample ranges to decode, the caller
//! decodes them (load.rs: files, in parallel; tests: in memory), `assemble`
//! maps the regions onto the results and writes the report.

use super::set::{tail_fade_frames, MsSample, MultiSampleSet, Region};
use super::sfz::{self, SfzParsed};
use std::collections::HashMap;

/// One range to decode, shared by every region that uses it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PlanJob {
    /// `default_path` + `sample`, forward slashes, relative to the .sfz.
    pub sample: String,
    /// First file frame kept.
    pub offset: u64,
    /// Exclusive end frame (None = to the end of the file).
    pub end: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub jobs: Vec<PlanJob>,
    /// Per parsed region: its job, or None (never plays: `end=-1`, empty range, generator).
    pub region_job: Vec<Option<usize>>,
    /// Regions using SFZ generators (`sample=*sine` …), unsupported.
    pub generators: usize,
}

/// What decoding a job produced.
pub enum JobResult {
    Ok(MsSample),
    Missing,
    Failed(String),
}

/// List the distinct sample ranges the regions need.
pub fn plan(parsed: &SfzParsed) -> Plan {
    let mut p = Plan::default();
    let mut index: HashMap<PlanJob, usize> = HashMap::new();
    for r in &parsed.regions {
        if r.sample.starts_with('*') {
            p.generators += 1;
            p.region_job.push(None);
            continue;
        }
        let end = match r.end {
            Some(e) if e < 0 => {
                p.region_job.push(None); // end=-1: the region never plays
                continue;
            }
            // SFZ `end` is the last frame played (inclusive).
            Some(e) => Some((e as u64).saturating_add(1)),
            None => None,
        };
        if end.is_some_and(|e| e <= r.offset) {
            p.region_job.push(None);
            continue;
        }
        let job = PlanJob { sample: r.sample.clone(), offset: r.offset, end };
        let j = *index.entry(job.clone()).or_insert_with(|| {
            p.jobs.push(job);
            p.jobs.len() - 1
        });
        p.region_job.push(Some(j));
    }
    p
}

fn mb(bytes: usize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

/// Parser warnings as report lines.
pub fn parse_report(name: &str, parsed: &SfzParsed) -> Vec<(&'static str, String)> {
    let mut report = Vec::new();
    for w in &parsed.warnings {
        report.push(("warn", format!("{name}: {w}")));
    }
    if let Some(w) = parsed.unknown_warning() {
        report.push(("warn", format!("{name}: {w}")));
    }
    report
}

/// Map regions onto decoded jobs. Missing / broken files only silence their
/// regions (reported); no playable region at all is an error.
pub fn assemble(name: &str, parsed: &SfzParsed, plan: &Plan, results: Vec<JobResult>, load_ms: f64) -> Result<MultiSampleSet, String> {
    let mut report = parse_report(name, parsed);
    if plan.generators > 0 {
        report.push(("warn", format!("{name}: {} region(s) use built-in generators (sample=*…), which are not supported; they stay silent", plan.generators)));
    }
    let mut samples: Vec<MsSample> = Vec::new();
    let mut sample_of_job: Vec<Option<u32>> = vec![None; plan.jobs.len()];
    let mut missing: Vec<&str> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for (i, r) in results.into_iter().enumerate().take(plan.jobs.len()) {
        let job = &plan.jobs[i];
        match r {
            JobResult::Ok(s) if s.frames > 0 => {
                sample_of_job[i] = Some(samples.len() as u32);
                samples.push(s);
            }
            JobResult::Ok(_) => failed.push(format!("{} (no audio in the mapped range)", job.sample)),
            JobResult::Missing => {
                if !missing.contains(&job.sample.as_str()) {
                    missing.push(&job.sample);
                }
            }
            JobResult::Failed(e) => failed.push(e),
        }
    }
    let mut regions: Vec<Region> = Vec::with_capacity(parsed.regions.len());
    let mut silent = 0usize;
    for (def, job) in parsed.regions.iter().zip(&plan.region_job) {
        let Some(j) = *job else { continue };
        match sample_of_job[j] {
            Some(si) => regions.push(Region::from_def(def, si, &samples[si as usize], plan.jobs[j].offset)),
            None => silent += 1,
        }
    }
    if !missing.is_empty() {
        let shown: Vec<&str> = missing.iter().take(5).copied().collect();
        let more = if missing.len() > shown.len() { format!(" and {} more", missing.len() - shown.len()) } else { String::new() };
        report.push((
            "warn",
            format!("{name}: {} sample file(s) are missing ({}{more}); their regions stay silent", missing.len(), shown.join(", ")),
        ));
    }
    if !failed.is_empty() {
        let more = if failed.len() > 1 { format!(" and {} more", failed.len() - 1) } else { String::new() };
        report.push(("warn", format!("{name}: {} sample file(s) could not be decoded ({}{more}); their regions stay silent", failed.len(), failed[0])));
    }
    if regions.is_empty() {
        let why = missing
            .first()
            .map(|m| format!("{m} is missing"))
            .or_else(|| failed.first().cloned())
            .unwrap_or_else(|| "no region maps a sample".into());
        return Err(format!("None of the {} regions of {name} could be loaded ({why})", parsed.regions.len()));
    }
    let mut set = MultiSampleSet::new(name.to_string(), samples, regions);
    set.load_ms = load_ms;
    let silent_note = if silent > 0 { format!(", {silent} silent") } else { String::new() };
    report.insert(
        0,
        (
            "info",
            format!(
                "Loaded {name}: {} regions{silent_note}, {} samples, {:.1} MB in {:.0} ms",
                set.regions.len(),
                set.samples.len(),
                mb(set.bytes()),
                load_ms
            ),
        ),
    );
    set.report = report;
    Ok(set)
}

/// Keep `[offset, end)` of a whole sample (in-memory sources).
pub fn slice_sample(s: &MsSample, offset: u64, end: Option<u64>) -> MsSample {
    let a = (offset as usize).min(s.frames);
    let b = end.map(|e| (e as usize).min(s.frames)).unwrap_or(s.frames).max(a);
    let ch = s.channels.max(1);
    let data = s.data[a * ch..b * ch].to_vec();
    let frames = b - a;
    MsSample { data, channels: ch, frames, sample_rate: s.sample_rate, root_key: s.root_key, tail_fade: tail_fade_frames(frames, s.sample_rate, b < s.frames) }
}

/// Build a set from SFZ text and in-memory samples: `provide(sample)` returns
/// the whole sample a region names (None = missing). Tests and generated
/// instruments; files go through load.rs.
pub fn from_sfz_text(name: &str, text: &str, mut provide: impl FnMut(&str) -> Option<MsSample>) -> Result<MultiSampleSet, String> {
    let parsed = sfz::parse(text);
    if parsed.regions.is_empty() {
        let why = parsed.warnings.first().map(|w| format!(" ({w})")).unwrap_or_default();
        return Err(format!("{name} has no playable <region>{why}"));
    }
    let plan = plan(&parsed);
    let results = plan
        .jobs
        .iter()
        .map(|j| match provide(&j.sample) {
            Some(s) => JobResult::Ok(slice_sample(&s, j.offset, j.end)),
            None => JobResult::Missing,
        })
        .collect();
    assemble(name, &parsed, &plan, results, 0.0)
}
