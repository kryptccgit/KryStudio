//! English (US) text → Kokoro phonemes, without GPL code (no eSpeak).
//!
//! 1. Text normalisation: sentences, words and punctuation; numbers, years,
//!    ordinals, money, percentages and common abbreviations → words.
//! 2. Per word: a small table of unstressed function words, then the CMU
//!    Pronouncing Dictionary (BSD-style licence; embedded compressed, built by
//!    scripts/models/cmudict.mjs), then suffix / compound fallbacks against the
//!    dictionary, spelled-out acronyms, and finally letter-to-sound rules
//!    (lts.rs) for unknown words.
//! 3. ARPAbet → the phoneme alphabet Kokoro was trained on (hexgrad/misaki's
//!    US set: diphthongs as single letters A I O W Y, ɜɹ / əɹ for ER, the US
//!    flap ɾ, stress marks ˈ ˌ before the vowel).
//!
//! Krypt-original implementation.

use std::sync::OnceLock;

use super::lts;
use super::numbers;

// ── CMU Pronouncing Dictionary ────────────────────────────────────────

static CMUDICT_DEFLATE: &[u8] = include_bytes!("../../data/cmudict.txt.deflate");

struct Dict {
    text: String,
    /// Byte offset of every line start (lines are sorted bytewise by word).
    lines: Vec<u32>,
}

static DICT: OnceLock<Result<Dict, String>> = OnceLock::new();

fn dict() -> Result<&'static Dict, String> {
    DICT.get_or_init(|| {
        let raw = miniz_oxide::inflate::decompress_to_vec(CMUDICT_DEFLATE).map_err(|e| format!("The built-in pronunciation dictionary is damaged ({e:?})"))?;
        let text = String::from_utf8(raw).map_err(|_| "The built-in pronunciation dictionary is not UTF-8".to_string())?;
        let mut lines = vec![0u32];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' && i + 1 < text.len() {
                lines.push((i + 1) as u32);
            }
        }
        Ok(Dict { text, lines })
    })
    .as_ref()
    .map_err(Clone::clone)
}

impl Dict {
    fn line(&self, i: usize) -> &str {
        let start = self.lines[i] as usize;
        let end = self.text[start..].find('\n').map_or(self.text.len(), |e| start + e);
        &self.text[start..end]
    }

    fn get(&self, word: &str) -> Option<&str> {
        let key = |i: usize| {
            let l = self.line(i);
            l.split_once(' ').map_or(l, |(w, _)| w)
        };
        let (mut lo, mut hi) = (0usize, self.lines.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            match key(mid).as_bytes().cmp(word.as_bytes()) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return self.line(mid).split_once(' ').map(|(_, p)| p),
            }
        }
        None
    }
}

/// CMUdict ARPAbet for a lowercase word (first pronunciation), if listed.
pub fn cmu(word: &str) -> Option<&'static str> {
    dict().ok()?.get(word)
}

/// Loads the dictionary now (errors surface as a job failure, not a panic).
pub fn ensure_dict() -> Result<(), String> {
    dict().map(|_| ())
}

// ── ARPAbet → Kokoro phonemes ─────────────────────────────────────────

fn vowel_symbol(base: &str, stress: u8) -> Option<&'static str> {
    Some(match base {
        "AA" => "ɑ",
        "AE" => "æ",
        "AH" => {
            if stress == 0 {
                "ə"
            } else {
                "ʌ"
            }
        }
        "AO" => "ɔ",
        "AW" => "W",
        "AY" => "I",
        "EH" => "ɛ",
        "ER" => {
            if stress == 0 {
                "əɹ"
            } else {
                "ɜɹ"
            }
        }
        "EY" => "A",
        "IH" => "ɪ",
        "IY" => "i",
        "OW" => "O",
        "OY" => "Y",
        "UH" => "ʊ",
        "UW" => "u",
        _ => return None,
    })
}

fn consonant_symbol(p: &str) -> Option<&'static str> {
    Some(match p {
        "B" => "b",
        "CH" => "ʧ",
        "D" => "d",
        "DH" => "ð",
        "F" => "f",
        "G" => "ɡ",
        "HH" => "h",
        "JH" => "ʤ",
        "K" => "k",
        "L" => "l",
        "M" => "m",
        "N" => "n",
        "NG" => "ŋ",
        "P" => "p",
        "R" => "ɹ",
        "S" => "s",
        "SH" => "ʃ",
        "T" => "t",
        "TH" => "θ",
        "V" => "v",
        "W" => "w",
        "Y" => "j",
        "Z" => "z",
        "ZH" => "ʒ",
        _ => return None,
    })
}

fn split_stress(p: &str) -> (&str, Option<u8>) {
    match p.as_bytes().last() {
        Some(d @ b'0'..=b'2') => (&p[..p.len() - 1], Some(d - b'0')),
        _ => (p, None),
    }
}

/// ARPAbet phones (CMUdict style, stress digits on vowels) → Kokoro phonemes.
pub fn arpabet_to_kokoro<S: AsRef<str>>(phones: &[S]) -> String {
    let ph: Vec<(&str, Option<u8>)> = phones.iter().map(|p| split_stress(p.as_ref())).collect();
    let is_v = |i: usize| ph.get(i).is_some_and(|p| p.1.is_some());
    let mut out = String::new();
    for (i, &(base, stress)) in ph.iter().enumerate() {
        if let Some(s) = stress {
            match s {
                1 => out.push('ˈ'),
                2 => out.push('ˌ'),
                _ => {}
            }
            if let Some(v) = vowel_symbol(base, s) {
                out.push_str(v);
            }
            continue;
        }
        // US flap: T between a vowel (or vowel + R) and an unstressed vowel ("water", "party"),
        // but not in "-tten"/"-tton" endings ("kitten", "button").
        if base == "T" && i > 0 {
            let after_vowel = is_v(i - 1) || (ph[i - 1].0 == "R" && i >= 2 && is_v(i - 2));
            let next_unstressed = ph.get(i + 1).is_some_and(|p| p.1 == Some(0));
            let tn_ending = ph.get(i + 1).is_some_and(|p| p.0 == "AH") && ph.get(i + 2).is_some_and(|p| p.0 == "N") && i + 3 == ph.len();
            if after_vowel && next_unstressed && !tn_ending {
                out.push('ɾ');
                continue;
            }
        }
        if let Some(c) = consonant_symbol(base) {
            out.push_str(c);
        }
    }
    out
}

// ── Words ─────────────────────────────────────────────────────────────

/// Function words in their usual unstressed (weak) forms, plus a few
/// common words whose first CMUdict entry is the less useful reading.
fn function_word(w: &str) -> Option<&'static str> {
    Some(match w {
        "a" => "ə",
        "an" => "ən",
        "the" => "ðə",
        "to" => "tə",
        "of" => "əv",
        "and" => "ænd",
        "or" => "ɔɹ",
        "but" => "bʌt",
        "for" => "fɔɹ",
        "from" => "fɹʌm",
        "at" => "æt",
        "in" => "ɪn",
        "on" => "ɑn",
        "as" => "æz",
        "is" => "ɪz",
        "are" => "ɑɹ",
        "was" => "wʌz",
        "were" => "wɜɹ",
        "be" => "bi",
        "been" => "bɪn",
        "by" => "bI",
        "it" => "ɪt",
        "its" => "ɪts",
        "that" => "ðæt",
        "than" => "ðæn",
        "with" => "wɪð",
        "your" => "jʊɹ",
        "you" => "ju",
        "we" => "wi",
        "he" => "hi",
        "she" => "ʃi",
        "they" => "ðA",
        "them" => "ðɛm",
        "his" => "hɪz",
        "her" => "hɜɹ",
        "our" => "Wəɹ",
        "me" => "mi",
        "my" => "mI",
        "i" => "I",
        "do" => "du",
        "does" => "dʌz",
        "can" => "kæn",
        "has" => "hæz",
        "have" => "hæv",
        "had" => "hæd",
        "will" => "wɪl",
        "would" => "wʊd",
        "should" => "ʃʊd",
        "could" => "kʊd",
        "if" => "ɪf",
        "so" => "sO",
        "up" => "ʌp",
        "into" => "ɪntu",
        // Present-tense readings (CMUdict lists the past / adjective first).
        "read" => "ɹˈid",
        "live" => "lˈɪv",
        "lead" => "lˈid",
        "wind" => "wˈɪnd",
        _ => return None,
    })
}

const LETTERS: [&str; 26] = [
    "EY1", "B IY1", "S IY1", "D IY1", "IY1", "EH1 F", "JH IY1", "EY1 CH", "AY1", "JH EY1", "K EY1", "EH1 L", "EH1 M", "EH1 N", "OW1", "P IY1", "K Y UW1",
    "AA1 R", "EH1 S", "T IY1", "Y UW1", "V IY1", "D AH1 B AH0 L Y UW0", "EH1 K S", "W AY1", "Z IY1",
];

/// Letter names, primary stress on the last letter ("DJ" → dˌiʤˈA).
fn spell(word: &str) -> Vec<String> {
    let letters: Vec<u8> = word.bytes().filter(u8::is_ascii_alphabetic).map(|c| c.to_ascii_lowercase()).collect();
    let mut out = Vec::new();
    for (k, c) in letters.iter().enumerate() {
        let last = k + 1 == letters.len();
        for p in LETTERS[(c - b'a') as usize].split_whitespace() {
            out.push(if !last && p.ends_with('1') { p.replace('1', "2") } else { p.to_string() });
        }
    }
    out
}

fn arpa(s: &str) -> Vec<String> {
    s.split_whitespace().map(String::from).collect()
}

fn last_base(phones: &[String]) -> &str {
    phones.last().map_or("", |p| split_stress(p).0)
}

/// Plural / possessive / 3rd-person -s after `stem`.
fn add_s(mut stem: Vec<String>) -> Vec<String> {
    match last_base(&stem) {
        "S" | "Z" | "SH" | "ZH" | "CH" | "JH" => {
            stem.push("IH0".into());
            stem.push("Z".into());
        }
        "P" | "T" | "K" | "F" | "TH" => stem.push("S".into()),
        _ => stem.push("Z".into()),
    }
    stem
}

/// Past tense -ed after `stem`.
fn add_ed(mut stem: Vec<String>) -> Vec<String> {
    match last_base(&stem) {
        "T" | "D" => {
            stem.push("IH0".into());
            stem.push("D".into());
        }
        "P" | "K" | "F" | "TH" | "S" | "SH" | "CH" => stem.push("T".into()),
        _ => stem.push("D".into()),
    }
    stem
}

/// Stems to try for a suffixed word: as is, with a restored final e, undoubled.
/// A base ending consonant-vowel-consonant before a vowel suffix tries the
/// e-form first ("vibing" → vibe, not vib: vib + ing would be spelled "vibbing").
fn stems(base: &str, vowel_suffix: bool) -> Vec<String> {
    let b = base.as_bytes();
    let v_ = |c: u8| matches!(c, b'a' | b'e' | b'i' | b'o' | b'u');
    let cvc = vowel_suffix && b.len() >= 3 && !v_(b[b.len() - 1]) && !matches!(b[b.len() - 1], b'w' | b'x' | b'y') && v_(b[b.len() - 2]) && !v_(b[b.len() - 3]);
    let mut v = if cvc { vec![format!("{base}e"), base.to_string()] } else { vec![base.to_string(), format!("{base}e")] };
    if b.len() >= 3 && b[b.len() - 1] == b[b.len() - 2] {
        v.push(base[..base.len() - 1].to_string());
    }
    if let Some(s) = base.strip_suffix('i') {
        v.push(format!("{s}y"));
    }
    v
}

fn dict_stem(base: &str, vowel_suffix: bool) -> Option<Vec<String>> {
    if base.len() < 2 {
        return None;
    }
    stems(base, vowel_suffix).iter().find_map(|s| cmu(s).map(arpa))
}

/// Suffix rules against the dictionary ("beatmakers", "vibing", "flexed").
fn morphology(w: &str) -> Option<Vec<String>> {
    if let Some(b) = w.strip_suffix("'s").or_else(|| w.strip_suffix("s'")) {
        return lookup_arpa(b, 1).map(add_s);
    }
    if let Some(b) = w.strip_suffix("in'") {
        // Dropped g: "nothin'" → nothing with a final N.
        return lookup_arpa(&format!("{b}ing"), 1).map(|mut p| {
            if last_base(&p) == "NG" {
                p.pop();
                p.push("N".into());
            }
            p
        });
    }
    if let Some(b) = w.strip_suffix("ies") {
        if let Some(p) = cmu(&format!("{b}y")) {
            return Some(add_s(arpa(p)));
        }
    }
    if let Some(b) = w.strip_suffix("es") {
        if b.ends_with(['s', 'x', 'z']) || b.ends_with("ch") || b.ends_with("sh") {
            if let Some(p) = cmu(b) {
                return Some(add_s(arpa(p)));
            }
        }
    }
    if let Some(b) = w.strip_suffix('s') {
        if !b.ends_with('s') {
            if let Some(p) = lookup_arpa(b, 1) {
                return Some(add_s(p));
            }
        }
    }
    if let Some(b) = w.strip_suffix("ed") {
        if let Some(p) = dict_stem(b, true) {
            return Some(add_ed(p));
        }
    }
    let suffixes: [(&str, &str); 10] = [
        ("ing", "IH0 NG"),
        ("ers", "ER0 Z"),
        ("er", "ER0"),
        ("est", "AH0 S T"),
        ("ly", "L IY0"),
        ("ness", "N AH0 S"),
        ("ment", "M AH0 N T"),
        ("ful", "F AH0 L"),
        ("less", "L AH0 S"),
        ("y", "IY0"),
    ];
    for (suf, ph) in suffixes {
        if let Some(b) = w.strip_suffix(suf) {
            if let Some(mut p) = dict_stem(b, suf.starts_with(['a', 'e', 'i', 'o', 'u', 'y'])) {
                p.extend(arpa(ph));
                return Some(p);
            }
        }
    }
    for (pre, ph) in [("un", "AH0 N"), ("re", "R IY0"), ("pre", "P R IY0"), ("over", "OW2 V ER0"), ("out", "AW2 T")] {
        if let Some(b) = w.strip_prefix(pre) {
            if b.len() >= 3 {
                if let Some(p) = cmu(b) {
                    let mut v = arpa(ph);
                    v.extend(arpa(p));
                    return Some(v);
                }
            }
        }
    }
    None
}

/// Two dictionary words glued together ("beatmaker", "lovesick"); the
/// second part's primary stress becomes secondary.
fn compound(w: &str) -> Option<Vec<String>> {
    let n = w.len();
    if n < 6 || !w.is_ascii() {
        return None;
    }
    let mut best: Option<(usize, Vec<String>)> = None;
    for i in 3..=n - 3 {
        let (a, b) = (&w[..i], &w[i..]);
        let (Some(pa), Some(pb)) = (cmu(a), cmu(b).map(arpa).or_else(|| morphology(b))) else {
            continue;
        };
        let score = a.len().min(b.len());
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            let mut v = arpa(pa);
            v.extend(pb.into_iter().map(|p| if p.ends_with('1') { p.replace('1', "2") } else { p }));
            best = Some((score, v));
        }
    }
    best.map(|b| b.1)
}

/// ARPAbet for one lowercase word: dictionary, then suffix / compound fallbacks
/// (`depth` bounds the recursion), else None.
fn lookup_arpa(w: &str, depth: u8) -> Option<Vec<String>> {
    if let Some(p) = cmu(w) {
        return Some(arpa(p));
    }
    if depth == 0 {
        return None;
    }
    morphology(w).or_else(|| compound(w))
}

/// How a word was resolved (tests and diagnostics).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Function,
    Dictionary,
    Derived,
    Spelled,
    Rules,
}

/// Kokoro phonemes for one word as written (case matters for acronyms).
pub fn word(original: &str) -> (String, Source) {
    let mut w: String = original.to_lowercase().trim_start_matches('\'').to_string();
    // A trailing apostrophe stays only where it means something ("vibin'", "dogs'").
    while w.ends_with('\'') && !(w.ends_with("in'") || w.ends_with("s'")) {
        w.pop();
    }
    if w.is_empty() {
        return (String::new(), Source::Rules);
    }
    if let Some(p) = function_word(&w) {
        return (p.into(), Source::Function);
    }
    let letters: Vec<char> = original.chars().filter(|c| c.is_alphabetic()).collect();
    let all_caps = letters.len() >= 2 && letters.iter().all(|c| c.is_uppercase());
    let has_vowel = w.chars().any(|c| "aeiouy".contains(c));
    // Short all-caps words the dictionary doesn't know, or without vowels: spell them ("DJ", "MC", "TV").
    if all_caps && letters.len() <= 5 && (!has_vowel || cmu(&w).is_none()) {
        return (arpabet_to_kokoro(&spell(&w)), Source::Spelled);
    }
    if let Some(p) = cmu(&w) {
        return (arpabet_to_kokoro(&arpa(p)), Source::Dictionary);
    }
    if let Some(p) = lookup_arpa(&w, 1) {
        return (arpabet_to_kokoro(&p), Source::Derived);
    }
    if w.len() == 1 && w.chars().all(|c| c.is_ascii_alphabetic()) {
        return (arpabet_to_kokoro(&spell(&w)), Source::Spelled);
    }
    let ascii: String = w.chars().filter(|c| c.is_ascii_lowercase()).collect();
    if ascii.is_empty() {
        return (String::new(), Source::Rules);
    }
    (arpabet_to_kokoro(&lts::word_to_arpabet(&ascii)), Source::Rules)
}

// ── Text → tokens ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// display text, spoken words
    Word(String, Vec<String>),
    /// punctuation Kokoro knows
    Punct(char),
}

const ABBREVIATIONS: [(&str, &str); 16] = [
    ("mr", "mister"),
    ("mrs", "missus"),
    ("ms", "miz"),
    ("dr", "doctor"),
    ("st", "saint"),
    ("jr", "junior"),
    ("sr", "senior"),
    ("vs", "versus"),
    ("etc", "et cetera"),
    ("prof", "professor"),
    ("feat", "featuring"),
    ("ft", "featuring"),
    ("approx", "approximately"),
    ("no", "number"),
    ("vol", "volume"),
    ("mt", "mount"),
];

fn abbreviation(w: &str) -> Option<&'static str> {
    let l = w.to_lowercase();
    ABBREVIATIONS.iter().find(|(a, _)| *a == l).map(|(_, b)| *b)
}

fn normalize_chars(text: &str) -> String {
    let mut s = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\u{2018}' | '\u{2019}' | '\u{02BC}' | '`' | '\u{00B4}' => s.push('\''),
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{00AB}' | '\u{00BB}' => s.push('"'),
            '\u{2013}' => s.push('-'),
            '\u{2014}' | '\u{2015}' => s.push_str(" — "),
            '\u{2026}' => s.push('…'),
            '\t' | '\r' => s.push(' '),
            c => s.push(c),
        }
    }
    s.replace("--", " — ").replace("...", "…")
}

/// Splits text into sentences (on . ! ? … and line breaks; not after
/// abbreviations or initials).
pub fn sentences(text: &str) -> Vec<String> {
    let text = normalize_chars(text);
    let mut out = Vec::new();
    for line in text.split('\n') {
        let chars: Vec<char> = line.chars().collect();
        let mut start = 0;
        let mut i = 0;
        while i < chars.len() {
            if matches!(chars[i], '.' | '!' | '?' | '…') {
                let mut j = i + 1;
                while j < chars.len() && matches!(chars[j], '.' | '!' | '?' | '…' | '"' | ')' | '\'') {
                    j += 1;
                }
                let at_break = j >= chars.len() || chars[j].is_whitespace();
                // The word before the period.
                let word: String = chars[start..i].iter().rev().take_while(|c| c.is_alphanumeric()).collect::<Vec<_>>().into_iter().rev().collect();
                let abbrev = chars[i] == '.' && (abbreviation(&word).is_some() || (word.chars().count() == 1 && word.chars().all(char::is_uppercase)));
                // "3.5": a period between digits is a decimal point.
                let decimal = chars[i] == '.' && i > 0 && chars[i - 1].is_ascii_digit() && chars.get(i + 1).is_some_and(|c| c.is_ascii_digit());
                if at_break && !abbrev && !decimal {
                    let s: String = chars[start..j].iter().collect();
                    if !s.trim().is_empty() {
                        out.push(s.trim().to_string());
                    }
                    start = j;
                }
                i = j;
            } else {
                i += 1;
            }
        }
        let s: String = chars[start..].iter().collect();
        if !s.trim().is_empty() {
            out.push(s.trim().to_string());
        }
    }
    out
}

fn spoken_core(core: &str, out: &mut Vec<Tok>) {
    if core.is_empty() {
        return;
    }
    let push_words = |display: &str, words: String, out: &mut Vec<Tok>| {
        let ws: Vec<String> = words.split_whitespace().map(String::from).collect();
        if !ws.is_empty() {
            out.push(Tok::Word(display.to_string(), ws));
        }
    };
    match core {
        "&" => return push_words(core, "and".into(), out),
        "+" => return push_words(core, "plus".into(), out),
        "@" => return push_words(core, "at".into(), out),
        "=" => return push_words(core, "equals".into(), out),
        "%" => return push_words(core, "percent".into(), out),
        "#" => return push_words(core, "number".into(), out),
        _ => {}
    }
    // Money: $5, $1.50, $2k
    if let Some(num) = core.strip_prefix('$') {
        let (num, mult) = match num.strip_suffix(['k', 'K']) {
            Some(n) => (n, " thousand"),
            None => match num.strip_suffix(['m', 'M']) {
                Some(n) => (n, " million"),
                None => (num, ""),
            },
        };
        if let Some((d, c)) = num.split_once('.') {
            if let (Ok(dollars), Ok(cents)) = (d.replace(',', "").parse::<u64>(), c.parse::<u64>()) {
                if c.len() == 2 && mult.is_empty() {
                    let dw = format!("{} {}", numbers::cardinal(dollars), if dollars == 1 { "dollar" } else { "dollars" });
                    let s = if cents == 0 { dw } else { format!("{dw} {} {}", numbers::cardinal(cents), if cents == 1 { "cent" } else { "cents" }) };
                    return push_words(core, s, out);
                }
            }
        }
        if let Some(words) = numbers::spell_token(num) {
            let one = num == "1" && mult.is_empty();
            return push_words(core, format!("{words}{mult} {}", if one { "dollar" } else { "dollars" }), out);
        }
    }
    if let Some(words) = numbers::spell_token(core) {
        return push_words(core, words, out);
    }
    // Hyphens and slashes join words: say each part.
    if core.contains(['-', '/', '_']) {
        for part in core.split(['-', '/', '_']) {
            spoken_core(part, out);
        }
        return;
    }
    // Letter/digit mixes ("4ever", "mp3"): split into runs.
    let has_digit = core.chars().any(|c| c.is_ascii_digit());
    let has_alpha = core.chars().any(|c| c.is_alphabetic());
    if has_digit && has_alpha && numbers::spell_token(core).is_none() {
        let mut run = String::new();
        let mut digit_run = false;
        for c in core.chars() {
            let d = c.is_ascii_digit();
            if !run.is_empty() && d != digit_run {
                spoken_core(&run, out);
                run.clear();
            }
            digit_run = d;
            run.push(c);
        }
        spoken_core(&run, out);
        return;
    }
    let cleaned: String = core.chars().filter(|c| c.is_alphanumeric() || *c == '\'').collect();
    if cleaned.trim_matches('\'').is_empty() {
        return;
    }
    out.push(Tok::Word(core.to_string(), vec![cleaned]));
}

fn tokenize(sentence: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let text = normalize_chars(sentence);
    let words: Vec<&str> = text.split_whitespace().collect();
    for (k, chunk) in words.iter().enumerate() {
        if *chunk == "—" {
            out.push(Tok::Punct('—'));
            continue;
        }
        let chars: Vec<char> = chunk.chars().collect();
        let mut a = 0;
        let mut b = chars.len();
        while a < b && matches!(chars[a], '"' | '(' | '[' | '{' | '\'' | '*' | '¿' | '¡') {
            if matches!(chars[a], '"' | '(') {
                out.push(Tok::Punct(chars[a]));
            }
            a += 1;
        }
        let mut trailing = Vec::new();
        while b > a && matches!(chars[b - 1], ',' | '.' | '!' | '?' | ';' | ':' | '…' | '"' | ')' | ']' | '}' | '*' | '\'') {
            // Keep a trailing apostrophe that belongs to the word ("nothin'", "dogs'").
            if chars[b - 1] == '\'' && b - 1 > a && (chars[b - 2] == 'n' || chars[b - 2] == 's') {
                break;
            }
            trailing.push(chars[b - 1]);
            b -= 1;
        }
        let core: String = chars[a..b].iter().collect();
        // An abbreviation swallows its own period ("Dr." → doctor, no sentence pause).
        let mut trailing: Vec<char> = trailing.into_iter().rev().collect();
        if trailing.first() == Some(&'.') && abbreviation(&core).is_some() && (k + 1 < words.len()) {
            let w = abbreviation(&core).unwrap_or_default();
            out.push(Tok::Word(format!("{core}."), w.split_whitespace().map(String::from).collect()));
            trailing.remove(0);
        } else {
            spoken_core(&core, &mut out);
        }
        for c in trailing {
            match c {
                ',' | '.' | '!' | '?' | ';' | ':' | '…' | '"' | ')' => out.push(Tok::Punct(c)),
                ']' | '}' => out.push(Tok::Punct(')')),
                _ => {}
            }
        }
    }
    out
}

// ── Sentence → phonemes ───────────────────────────────────────────────

/// One word of the input and the phoneme characters it produced.
#[derive(Debug, Clone, PartialEq)]
pub struct WordSpan {
    pub text: String,
    /// Character range in `Phonemized::phonemes` (each char is one Kokoro token).
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Phonemized {
    pub phonemes: String,
    pub words: Vec<WordSpan>,
}

const VOWEL_PHONEMES: &str = "AIOWYaeiouæɑɐɒɔəɛɜɪʊʌᵻ";

fn starts_with_vowel(ph: &str) -> bool {
    ph.chars().find(|c| !matches!(c, 'ˈ' | 'ˌ')).is_some_and(|c| VOWEL_PHONEMES.contains(c))
}

/// Phonemes for one sentence, with word spans.
pub fn phonemize(sentence: &str) -> Phonemized {
    let toks = tokenize(sentence);
    // Phonemes per word token (spoken pieces joined by spaces).
    let mut word_ph: Vec<Option<String>> = toks
        .iter()
        .map(|t| match t {
            Tok::Word(_, ws) => Some(ws.iter().map(|w| word(w).0).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")),
            Tok::Punct(_) => None,
        })
        .collect();
    // "the" before a vowel sound → ði; "a"/"to" stay weak.
    for i in 0..toks.len() {
        if let Tok::Word(_, ws) = &toks[i] {
            if ws.len() == 1 && ws[0].eq_ignore_ascii_case("the") {
                let next = word_ph[i + 1..].iter().flatten().next();
                if next.is_some_and(|n| starts_with_vowel(n)) {
                    word_ph[i] = Some("ði".into());
                }
            }
        }
    }
    let mut out = Phonemized::default();
    let mut len = 0usize; // in chars
    let mut open_quote = false;
    let push = |out: &mut Phonemized, len: &mut usize, s: &str| {
        out.phonemes.push_str(s);
        *len += s.chars().count();
    };
    for (t, ph) in toks.iter().zip(&word_ph) {
        match t {
            Tok::Word(display, _) => {
                let ph = ph.as_deref().unwrap_or("");
                if ph.is_empty() {
                    continue;
                }
                let last = out.phonemes.chars().last();
                if last.is_some() && !matches!(last, Some(' ') | Some('(')) && !(last == Some('"') && open_quote) {
                    push(&mut out, &mut len, " ");
                }
                let start = len;
                push(&mut out, &mut len, ph);
                out.words.push(WordSpan { text: display.clone(), start, end: len });
            }
            Tok::Punct(c) => match c {
                '(' => {
                    if !out.phonemes.is_empty() && !out.phonemes.ends_with(' ') {
                        push(&mut out, &mut len, " ");
                    }
                    push(&mut out, &mut len, "(");
                }
                '"' => {
                    if open_quote {
                        push(&mut out, &mut len, "\"");
                    } else {
                        if !out.phonemes.is_empty() && !out.phonemes.ends_with(' ') {
                            push(&mut out, &mut len, " ");
                        }
                        push(&mut out, &mut len, "\"");
                    }
                    open_quote = !open_quote;
                }
                '—' => {
                    if !out.phonemes.is_empty() && !out.phonemes.ends_with(' ') {
                        push(&mut out, &mut len, " ");
                    }
                    push(&mut out, &mut len, "—");
                }
                c => {
                    // No punctuation at the very start (Kokoro reads it as a pause).
                    if !out.phonemes.is_empty() {
                        let mut b = [0u8; 4];
                        push(&mut out, &mut len, c.encode_utf8(&mut b));
                    }
                }
            },
        }
    }
    out
}

/// Splits a phonemized sentence into pieces of at most `max` tokens, at the
/// last punctuation (else space) before the limit. Word spans move with
/// their text.
pub fn split_long(p: Phonemized, max: usize) -> Vec<Phonemized> {
    let chars: Vec<char> = p.phonemes.chars().collect();
    if chars.len() <= max {
        return vec![p];
    }
    let mut pieces = Vec::new();
    let mut start = 0usize;
    while chars.len() - start > max {
        let window = &chars[start..start + max];
        let cut = window
            .iter()
            .rposition(|c| matches!(c, ',' | ';' | ':' | '—' | '.' | '!' | '?'))
            .filter(|&i| i > max / 3)
            .map(|i| i + 1)
            .or_else(|| window.iter().rposition(|c| *c == ' ').filter(|&i| i > 0))
            .unwrap_or(max);
        pieces.push((start, start + cut));
        start += cut;
        while start < chars.len() && chars[start] == ' ' {
            start += 1;
        }
    }
    if start < chars.len() {
        pieces.push((start, chars.len()));
    }
    pieces
        .into_iter()
        .map(|(a, b)| {
            let text: String = chars[a..b].iter().collect::<String>();
            Phonemized {
                phonemes: text.trim_end().to_string(),
                words: p.words.iter().filter(|w| w.start >= a && w.end <= b).map(|w| WordSpan { text: w.text.clone(), start: w.start - a, end: w.end - a }).collect(),
            }
        })
        .filter(|x| !x.phonemes.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod tests;
