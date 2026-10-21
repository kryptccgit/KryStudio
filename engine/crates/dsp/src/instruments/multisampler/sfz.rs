//! SFZ subset parser for krypt.multisampler (pure: text in, regions out).
//!
//! Supported (shared/packs/types.ts `SFZ_OPCODES`, plus `ampeg_delay` and the
//! common v1 aliases `loopmode` / `loopstart` / `loopend` / `offby`):
//! - headers `<control>` (`default_path`), `<global>`, `<master>`, `<group>`,
//!   `<region>`, with inheritance global → master → group → region (a later
//!   level overrides an earlier one; a new `<global>` resets master and group,
//!   a new `<master>` resets group);
//! - `#define $NAME value` (substituted in every later line); `#include` is
//!   not supported and produces a warning;
//! - `//` line comments and `/* … */` block comments;
//! - values with spaces for `sample` / `default_path` (the value runs to the
//!   end of the line or to the next `opcode=`);
//! - note names (`c4` = 60, `c#4`, `db4`) or numbers wherever a key goes.
//!
//! Unknown opcodes and headers are ignored and counted (one warning per file).

use std::collections::BTreeMap;

/// `loop_mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopMode {
    NoLoop,
    OneShot,
    LoopContinuous,
    LoopSustain,
}

/// `trigger`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Attack,
    Release,
}

/// `off_mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OffMode {
    /// ~5 ms fade.
    Fast,
    /// The region's own release.
    Normal,
}

/// `pitch_keycenter=sample`: use the file's root key (WAV `smpl`), else 60.
pub const KEYCENTER_FROM_SAMPLE: f32 = -1000.0;

/// One region with every inherited opcode applied, still in SFZ units.
#[derive(Clone, Debug, PartialEq)]
pub struct RegionDef {
    /// `default_path` + `sample`, forward slashes, as written (relative to the .sfz).
    pub sample: String,
    /// 1-based line of the `<region>` header (for messages).
    pub line: usize,
    pub lokey: i32,
    pub hikey: i32,
    /// Fractional MIDI key, or [`KEYCENTER_FROM_SAMPLE`].
    pub pitch_keycenter: f32,
    /// Cents per key.
    pub pitch_keytrack: f32,
    pub lovel: i32,
    pub hivel: i32,
    pub xfin_lovel: i32,
    pub xfin_hivel: i32,
    pub xfout_lovel: i32,
    pub xfout_hivel: i32,
    /// Percent, -100..100.
    pub amp_veltrack: f32,
    /// dB.
    pub volume: f32,
    /// -100..100.
    pub pan: f32,
    /// Cents.
    pub tune: f32,
    /// Semitones.
    pub transpose: i32,
    /// First frame kept.
    pub offset: u64,
    /// Last frame played (inclusive); None = the whole file; Some(-1) = never plays.
    pub end: Option<i64>,
    /// None = no_loop (no loop points are read from files).
    pub loop_mode: Option<LoopMode>,
    pub loop_start: Option<u64>,
    pub loop_end: Option<u64>,
    /// Seconds.
    pub ampeg_delay: f32,
    pub ampeg_attack: f32,
    pub ampeg_hold: f32,
    pub ampeg_decay: f32,
    /// Percent.
    pub ampeg_sustain: f32,
    pub ampeg_release: f32,
    pub trigger: Trigger,
    /// dB per second the note was held.
    pub rt_decay: f32,
    pub seq_length: u32,
    pub seq_position: u32,
    pub lorand: f32,
    pub hirand: f32,
    pub group: i64,
    pub off_by: i64,
    pub off_mode: OffMode,
}

impl Default for RegionDef {
    fn default() -> Self {
        Self {
            sample: String::new(),
            line: 0,
            lokey: 0,
            hikey: 127,
            pitch_keycenter: 60.0,
            pitch_keytrack: 100.0,
            lovel: 1,
            hivel: 127,
            xfin_lovel: 0,
            xfin_hivel: 0,
            xfout_lovel: 127,
            xfout_hivel: 127,
            amp_veltrack: 100.0,
            volume: 0.0,
            pan: 0.0,
            tune: 0.0,
            transpose: 0,
            offset: 0,
            end: None,
            loop_mode: None,
            loop_start: None,
            loop_end: None,
            ampeg_delay: 0.0,
            ampeg_attack: 0.0,
            ampeg_hold: 0.0,
            ampeg_decay: 0.0,
            ampeg_sustain: 100.0,
            ampeg_release: 0.0,
            trigger: Trigger::Attack,
            rt_decay: 0.0,
            seq_length: 1,
            seq_position: 1,
            lorand: 0.0,
            hirand: 1.0,
            group: 0,
            off_by: 0,
            off_mode: OffMode::Fast,
        }
    }
}

/// Parse result.
#[derive(Clone, Debug, Default)]
pub struct SfzParsed {
    pub regions: Vec<RegionDef>,
    /// Human sentences (bad values, `#include`, unsupported headers …).
    pub warnings: Vec<String>,
    /// Occurrences of opcodes outside the supported subset.
    pub unknown_count: usize,
    /// Their distinct names, in first-seen order.
    pub unknown_names: Vec<String>,
}

impl SfzParsed {
    /// The one warning about unknown opcodes (None when there were none).
    pub fn unknown_warning(&self) -> Option<String> {
        if self.unknown_count == 0 {
            return None;
        }
        let shown: Vec<&str> = self.unknown_names.iter().take(8).map(String::as_str).collect();
        let more = if self.unknown_names.len() > shown.len() { format!(" and {} more", self.unknown_names.len() - shown.len()) } else { String::new() };
        Some(format!(
            "ignored {} unsupported opcode{} ({}{more})",
            self.unknown_count,
            if self.unknown_count == 1 { "" } else { "s" },
            shown.join(", ")
        ))
    }
}

/// Opcodes this parser understands (canonical names).
pub const SUPPORTED: &[&str] = &[
    "default_path",
    "sample",
    "key",
    "lokey",
    "hikey",
    "pitch_keycenter",
    "pitch_keytrack",
    "lovel",
    "hivel",
    "xfin_lovel",
    "xfin_hivel",
    "xfout_lovel",
    "xfout_hivel",
    "amp_veltrack",
    "volume",
    "pan",
    "tune",
    "transpose",
    "offset",
    "end",
    "loop_mode",
    "loop_start",
    "loop_end",
    "ampeg_delay",
    "ampeg_attack",
    "ampeg_hold",
    "ampeg_decay",
    "ampeg_sustain",
    "ampeg_release",
    "trigger",
    "rt_decay",
    "seq_length",
    "seq_position",
    "lorand",
    "hirand",
    "group",
    "off_by",
    "off_mode",
];

fn canonical(name: &str) -> &str {
    match name {
        "loopmode" => "loop_mode",
        "loopstart" => "loop_start",
        "loopend" => "loop_end",
        "offby" => "off_by",
        "pitch" => "tune",
        other => other,
    }
}

/// Note name (`c4`, `c#4`, `db4`, `C-1`) or number → MIDI key. c4 = 60.
pub fn parse_key(s: &str) -> Option<i32> {
    let s = s.trim();
    if let Ok(n) = s.parse::<i32>() {
        return Some(n);
    }
    if let Ok(f) = s.parse::<f64>() {
        return f.is_finite().then(|| f.round() as i32);
    }
    let lower = s.to_ascii_lowercase();
    let mut chars = lower.chars();
    let base = match chars.next()? {
        'c' => 0,
        'd' => 2,
        'e' => 4,
        'f' => 5,
        'g' => 7,
        'a' => 9,
        'b' => 11,
        _ => return None,
    };
    let rest: &str = chars.as_str();
    let (acc, rest) = if let Some(r) = rest.strip_prefix('#') {
        (1, r)
    } else if let Some(r) = rest.strip_prefix('♯') {
        (1, r)
    } else if let Some(r) = rest.strip_prefix('♭') {
        (-1, r)
    } else if rest.len() > 1 && rest.starts_with('b') {
        // "bb3" = B flat 3 (but "b3" is B3: the accidental needs a number after it)
        (-1, &rest[1..])
    } else {
        (0, rest)
    };
    let octave: i32 = rest.parse().ok()?;
    Some((octave + 1) * 12 + base + acc)
}

/// Strip `//` and `/* */` comments. `in_block` carries a block comment across lines.
fn strip_comments(line: &str, in_block: &mut bool) -> String {
    let mut out = String::with_capacity(line.len());
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if *in_block {
            if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                *in_block = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            break;
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            *in_block = true;
            out.push(' ');
            i += 2;
            continue;
        }
        // copy one UTF-8 char
        let ch_len = utf8_len(b[i]);
        let end = (i + ch_len).min(b.len());
        out.push_str(&line[i..end]);
        i = end;
    }
    out
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Replace `$NAME` with its #define (longest defined name that prefixes the identifier).
fn substitute(line: &str, defines: &[(String, String)]) -> String {
    if defines.is_empty() || !line.contains('$') {
        return line.to_string();
    }
    let b = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'$' {
            let mut j = i + 1;
            while j < b.len() && is_ident(b[j]) {
                j += 1;
            }
            let ident = &line[i + 1..j];
            let hit = defines
                .iter()
                .filter(|(n, _)| !n.is_empty() && ident.starts_with(n.as_str()))
                .max_by_key(|(n, _)| n.len());
            if let Some((n, v)) = hit {
                out.push_str(v);
                i += 1 + n.len();
                continue;
            }
        }
        let ch_len = utf8_len(b[i]);
        let end = (i + ch_len).min(b.len());
        out.push_str(&line[i..end]);
        i = end;
    }
    out
}

/// Is there an `ident=` starting at `j`?
fn opcode_at(b: &[u8], j: usize) -> Option<usize> {
    if j >= b.len() || !is_ident_start(b[j]) {
        return None;
    }
    let mut k = j + 1;
    while k < b.len() && is_ident(b[k]) {
        k += 1;
    }
    (k < b.len() && b[k] == b'=').then_some(k)
}

enum Tok {
    Header(String),
    Op(String, String),
}

/// Tokenize one (comment-free, substituted) line.
fn tokenize(line: &str) -> Vec<Tok> {
    let b = line.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b[i] == b'<' {
            match line[i..].find('>') {
                Some(e) => {
                    toks.push(Tok::Header(line[i + 1..i + e].trim().to_ascii_lowercase()));
                    i += e + 1;
                }
                None => break,
            }
            continue;
        }
        if let Some(eq) = opcode_at(b, i) {
            let name = line[i..eq].to_string();
            let vstart = eq + 1;
            // The value runs to the next header or the next whitespace-preceded `opcode=`.
            let mut j = vstart;
            let mut vend = b.len();
            while j < b.len() {
                if b[j] == b'<' {
                    vend = j;
                    break;
                }
                if j > vstart && b[j - 1].is_ascii_whitespace() && opcode_at(b, j).is_some() {
                    vend = j;
                    break;
                }
                j += 1;
            }
            toks.push(Tok::Op(name, line[vstart..vend].trim().to_string()));
            i = vend;
            continue;
        }
        // junk: skip a word
        while i < b.len() && !b[i].is_ascii_whitespace() {
            i += 1;
        }
    }
    toks
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Level {
    None,
    Control,
    Global,
    Master,
    Group,
    Region,
    /// An unsupported header: its opcodes are ignored.
    Other,
}

type OpMap = BTreeMap<String, (String, usize)>;

struct Parser {
    out: SfzParsed,
    global: OpMap,
    master: OpMap,
    group: OpMap,
    region: OpMap,
    region_line: usize,
    in_region: bool,
    default_path: String,
    warned_values: usize,
    other_headers: Vec<String>,
    stray: usize,
}

impl Parser {
    fn note_unknown(&mut self, name: &str) {
        self.out.unknown_count += 1;
        if !self.out.unknown_names.iter().any(|n| n == name) {
            self.out.unknown_names.push(name.to_string());
        }
    }

    fn warn_value(&mut self, line: usize, msg: String) {
        // Cap per file so a broken file can't produce thousands of lines.
        if self.warned_values < 10 {
            self.out.warnings.push(format!("line {line}: {msg}"));
        }
        self.warned_values += 1;
    }

    fn finish_region(&mut self) {
        if !self.in_region {
            return;
        }
        self.in_region = false;
        let mut merged: OpMap = self.global.clone();
        for m in [&self.master, &self.group, &self.region] {
            for (k, v) in m {
                merged.insert(k.clone(), v.clone());
            }
        }
        self.region.clear();
        let mut r = RegionDef { line: self.region_line, ..Default::default() };
        let mut sample: Option<String> = None;
        for (name, (val, line)) in &merged {
            let line = *line;
            let first = val.split_whitespace().next().unwrap_or("");
            let num = || first.parse::<f64>().ok().filter(|v| v.is_finite());
            macro_rules! f32v {
                ($field:expr) => {
                    match num() {
                        Some(v) => $field = v as f32,
                        None => self.warn_value(line, format!("{name}={val} is not a number")),
                    }
                };
            }
            macro_rules! keyv {
                ($field:expr) => {
                    match parse_key(first) {
                        Some(k) => $field = k,
                        None => self.warn_value(line, format!("{name}={val} is not a key (use 60 or c4)")),
                    }
                };
            }
            macro_rules! intv {
                ($field:expr, $t:ty) => {
                    match num() {
                        Some(v) => $field = v.round() as $t,
                        None => self.warn_value(line, format!("{name}={val} is not a number")),
                    }
                };
            }
            match name.as_str() {
                "sample" => sample = Some(val.clone()),
                "lokey" => keyv!(r.lokey),
                "hikey" => keyv!(r.hikey),
                "pitch_keycenter" => {
                    if first.eq_ignore_ascii_case("sample") {
                        r.pitch_keycenter = KEYCENTER_FROM_SAMPLE;
                    } else {
                        match parse_key(first) {
                            Some(k) => r.pitch_keycenter = k as f32,
                            None => self.warn_value(line, format!("{name}={val} is not a key (use 60 or c4)")),
                        }
                    }
                }
                "pitch_keytrack" => f32v!(r.pitch_keytrack),
                "lovel" => intv!(r.lovel, i32),
                "hivel" => intv!(r.hivel, i32),
                "xfin_lovel" => intv!(r.xfin_lovel, i32),
                "xfin_hivel" => intv!(r.xfin_hivel, i32),
                "xfout_lovel" => intv!(r.xfout_lovel, i32),
                "xfout_hivel" => intv!(r.xfout_hivel, i32),
                "amp_veltrack" => f32v!(r.amp_veltrack),
                "volume" => f32v!(r.volume),
                "pan" => f32v!(r.pan),
                "tune" => f32v!(r.tune),
                "transpose" => intv!(r.transpose, i32),
                "offset" => match num() {
                    Some(v) => r.offset = v.max(0.0) as u64,
                    None => self.warn_value(line, format!("{name}={val} is not a number")),
                },
                "end" => match num() {
                    Some(v) => r.end = Some(v.round() as i64),
                    None => self.warn_value(line, format!("{name}={val} is not a number")),
                },
                "loop_mode" => match first.to_ascii_lowercase().as_str() {
                    "no_loop" => r.loop_mode = Some(LoopMode::NoLoop),
                    "one_shot" => r.loop_mode = Some(LoopMode::OneShot),
                    "loop_continuous" => r.loop_mode = Some(LoopMode::LoopContinuous),
                    "loop_sustain" => r.loop_mode = Some(LoopMode::LoopSustain),
                    _ => self.warn_value(line, format!("loop_mode={val} is not supported (no_loop, one_shot, loop_continuous, loop_sustain)")),
                },
                "loop_start" => match num() {
                    Some(v) => r.loop_start = Some(v.max(0.0) as u64),
                    None => self.warn_value(line, format!("{name}={val} is not a number")),
                },
                "loop_end" => match num() {
                    Some(v) => r.loop_end = Some(v.max(0.0) as u64),
                    None => self.warn_value(line, format!("{name}={val} is not a number")),
                },
                "ampeg_delay" => f32v!(r.ampeg_delay),
                "ampeg_attack" => f32v!(r.ampeg_attack),
                "ampeg_hold" => f32v!(r.ampeg_hold),
                "ampeg_decay" => f32v!(r.ampeg_decay),
                "ampeg_sustain" => f32v!(r.ampeg_sustain),
                "ampeg_release" => f32v!(r.ampeg_release),
                "trigger" => match first.to_ascii_lowercase().as_str() {
                    "attack" | "first" | "legato" => r.trigger = Trigger::Attack,
                    "release" | "release_key" => r.trigger = Trigger::Release,
                    _ => self.warn_value(line, format!("trigger={val} is not supported (attack or release)")),
                },
                "rt_decay" => f32v!(r.rt_decay),
                "seq_length" => intv!(r.seq_length, u32),
                "seq_position" => intv!(r.seq_position, u32),
                "lorand" => f32v!(r.lorand),
                "hirand" => f32v!(r.hirand),
                "group" => intv!(r.group, i64),
                "off_by" => intv!(r.off_by, i64),
                "off_mode" => match first.to_ascii_lowercase().as_str() {
                    "fast" => r.off_mode = OffMode::Fast,
                    "normal" | "time" => r.off_mode = OffMode::Normal,
                    _ => self.warn_value(line, format!("off_mode={val} is not supported (fast or normal)")),
                },
                _ => {}
            }
        }
        let Some(sample) = sample.filter(|s| !s.is_empty()) else {
            self.warn_value(self.region_line, "<region> without sample= is skipped".into());
            return;
        };
        let mut path = String::new();
        if !self.default_path.is_empty() {
            path.push_str(&self.default_path);
        }
        path.push_str(&sample);
        r.sample = path.replace('\\', "/");
        r.seq_length = r.seq_length.max(1);
        r.seq_position = r.seq_position.clamp(1, r.seq_length.max(1));
        self.out.regions.push(r);
    }

    fn set_op(&mut self, level: Level, name: &str, val: String, line: usize) {
        let canon = canonical(name);
        if level == Level::Other {
            return;
        }
        if !SUPPORTED.contains(&canon) {
            self.note_unknown(name);
            return;
        }
        if canon == "default_path" {
            let mut p = val.replace('\\', "/");
            if !p.is_empty() && !p.ends_with('/') {
                p.push('/');
            }
            self.default_path = p;
            return;
        }
        let map = match level {
            Level::Global => &mut self.global,
            Level::Master => &mut self.master,
            Level::Group => &mut self.group,
            Level::Region => &mut self.region,
            // <control> only holds default_path in our subset; opcodes before any header are ignored.
            Level::Control | Level::None => {
                self.stray += 1;
                return;
            }
            Level::Other => return,
        };
        if canon == "key" {
            for k in ["lokey", "hikey", "pitch_keycenter"] {
                map.insert(k.to_string(), (val.clone(), line));
            }
        } else {
            map.insert(canon.to_string(), (val, line));
        }
    }
}

/// Parse SFZ text.
pub fn parse(text: &str) -> SfzParsed {
    let mut p = Parser {
        out: SfzParsed::default(),
        global: OpMap::new(),
        master: OpMap::new(),
        group: OpMap::new(),
        region: OpMap::new(),
        region_line: 0,
        in_region: false,
        default_path: String::new(),
        warned_values: 0,
        other_headers: Vec::new(),
        stray: 0,
    };
    let mut defines: Vec<(String, String)> = Vec::new();
    let mut level = Level::None;
    let mut in_block = false;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    for (idx, raw) in text.lines().enumerate() {
        let line_no = idx + 1;
        let line = strip_comments(raw, &mut in_block);
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("#define") {
            let rest = rest.trim();
            let (name, value) = match rest.find(char::is_whitespace) {
                Some(sp) => (&rest[..sp], rest[sp..].trim()),
                None => (rest, ""),
            };
            match name.strip_prefix('$') {
                Some(n) if !n.is_empty() => {
                    let value = substitute(value, &defines);
                    defines.retain(|(k, _)| k != n);
                    defines.push((n.to_string(), value));
                }
                _ => p.warn_value(line_no, format!("#define {rest} needs a $NAME")),
            }
            continue;
        }
        if trimmed.starts_with("#include") {
            p.out.warnings.push(format!(
                "line {line_no}: #include is not supported ({}); its regions are missing",
                trimmed.trim_start_matches("#include").trim()
            ));
            continue;
        }
        if trimmed.starts_with('#') {
            p.warn_value(line_no, format!("unsupported directive {}", trimmed.split_whitespace().next().unwrap_or("#")));
            continue;
        }
        let line = substitute(&line, &defines);
        for tok in tokenize(&line) {
            match tok {
                Tok::Header(h) => {
                    p.finish_region();
                    level = match h.as_str() {
                        "control" => Level::Control,
                        "global" => {
                            p.global.clear();
                            p.master.clear();
                            p.group.clear();
                            Level::Global
                        }
                        "master" => {
                            p.master.clear();
                            p.group.clear();
                            Level::Master
                        }
                        "group" => {
                            p.group.clear();
                            Level::Group
                        }
                        "region" => {
                            p.in_region = true;
                            p.region_line = line_no;
                            Level::Region
                        }
                        other => {
                            if !p.other_headers.iter().any(|o| o == other) {
                                p.other_headers.push(other.to_string());
                            }
                            Level::Other
                        }
                    };
                }
                Tok::Op(name, val) => p.set_op(level, &name, val, line_no),
            }
        }
    }
    p.finish_region();
    if !p.other_headers.is_empty() {
        let list: Vec<String> = p.other_headers.iter().map(|h| format!("<{h}>")).collect();
        p.out.warnings.push(format!("ignored unsupported header{} {}", if list.len() == 1 { "" } else { "s" }, list.join(", ")));
    }
    if p.stray > 0 {
        p.out.warnings.push(format!("ignored {} opcode(s) outside <global>/<master>/<group>/<region>", p.stray));
    }
    if p.warned_values > 10 {
        p.out.warnings.push(format!("… and {} more bad values", p.warned_values - 10));
    }
    p.out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_names() {
        assert_eq!(parse_key("c4"), Some(60));
        assert_eq!(parse_key("C4"), Some(60));
        assert_eq!(parse_key("c#4"), Some(61));
        assert_eq!(parse_key("db4"), Some(61));
        assert_eq!(parse_key("a4"), Some(69));
        assert_eq!(parse_key("b3"), Some(59));
        assert_eq!(parse_key("bb3"), Some(58));
        assert_eq!(parse_key("c-1"), Some(0));
        assert_eq!(parse_key("g9"), Some(127));
        assert_eq!(parse_key("60"), Some(60));
        assert_eq!(parse_key("x4"), None);
        assert_eq!(parse_key("c"), None);
    }

    #[test]
    fn comments_are_stripped() {
        let mut b = false;
        assert_eq!(strip_comments("a=1 // x", &mut b).trim(), "a=1");
        assert_eq!(strip_comments("a=1 /* x */ b=2", &mut b).split_whitespace().collect::<Vec<_>>(), ["a=1", "b=2"]);
        assert_eq!(strip_comments("a=1 /* open", &mut b).trim(), "a=1");
        assert!(b);
        assert_eq!(strip_comments("still */ c=3", &mut b).trim(), "c=3");
        assert!(!b);
    }
}
