//! Letter-to-sound rules for words CMUdict doesn't know (names, slang,
//! made-up words): ordered grapheme rules with simple contexts, then a
//! stress heuristic. Output is ARPAbet with stress digits, like CMUdict, so
//! it goes through the same ARPAbet → Kokoro mapping. Krypt-original rule set
//! (written for this project in the style of classic context rules; no GPL
//! G2P such as eSpeak is used or consulted).
//!
//! Context symbols (left context is matched right-to-left from the letter):
//! - `#` one or more vowels (a e i o u y)
//! - `:` zero or more consonants
//! - `^` exactly one consonant
//! - `.` one voiced consonant (b d g j l m n r v w z)
//! - `+` one front vowel (e i y)
//! - `%` (right only) a suffix then the word end: e, es, ed, er, ers, ely, ing, en, y
//! - ` ` the word boundary
//! - letters match themselves

struct Rule {
    left: &'static str,
    g: &'static str,
    right: &'static str,
    out: &'static str,
}

const fn r(left: &'static str, g: &'static str, right: &'static str, out: &'static str) -> Rule {
    Rule { left, g, right, out }
}

/// First matching rule wins; rules are grouped by first letter (longest graphemes first).
const RULES: &[Rule] = &[
    // a
    r(" ", "are", " ", "AA R"),
    r("", "air", "", "EH R"),
    r("", "ar", "#", "EH R"),
    r("", "ar", "", "AA R"),
    r("", "ai", "", "EY"),
    r("", "ay", "", "EY"),
    r("", "augh", "", "AO"),
    r("", "au", "", "AO"),
    r("", "aw", "", "AO"),
    r("", "all", "", "AO L"),
    r("", "alk", "", "AO K"),
    r("", "a", "tion", "EY"),
    r("w", "a", "^", "AA"),
    r("", "a", "^%", "EY"),
    r("", "a", " ", "AH"),
    r("", "a", "", "AE"),
    // b
    r("m", "b", " ", ""),
    r("", "bb", "", "B"),
    r("", "b", "", "B"),
    // c
    r("", "chr", "", "K R"),
    r("", "ch", "", "CH"),
    r("", "ck", "", "K"),
    r("", "cc", "+", "K S"),
    r("", "cc", "", "K"),
    r("", "cious", "", "SH AH S"),
    r("", "cial", "", "SH AH L"),
    r("", "cian", "", "SH AH N"),
    r("", "c", "+", "S"),
    r("", "c", "", "K"),
    // d
    r("", "dge", "", "JH"),
    r("", "dd", "", "D"),
    r("", "d", "", "D"),
    // e
    r("#:", "e", " ", ""),
    r("#:", "es", " ", "Z"),
    r("", "eau", "", "OW"),
    r("", "ee", "", "IY"),
    r("", "ea", "", "IY"),
    r("", "ey", " ", "IY"),
    r("", "ei", "", "EY"),
    r("", "ey", "", "EY"),
    r("", "ew", "", "UW"),
    r("", "eu", "", "UW"),
    r("", "er", "#", "EH R"),
    r("", "er", "", "ER"),
    r("", "e", " ", "IY"),
    r("", "e", "^%", "IY"),
    r("", "e", "", "EH"),
    // f
    r("", "ff", "", "F"),
    r("", "f", "", "F"),
    // g
    r(" ", "gh", "", "G"),
    r("", "gh", "", ""),
    r(" ", "gn", "", "N"),
    r("", "gn", " ", "N"),
    r("", "gg", "", "G"),
    r("", "g", "+", "JH"),
    r("", "g", "", "G"),
    // h
    r("#", "h", " ", ""),
    r("", "h", "", "HH"),
    // i
    r("", "igh", "", "AY"),
    r("", "ie", " ", "IY"),
    r("", "ie", "", "IY"),
    r("", "ir", "", "ER"),
    r("", "ing", " ", "IH NG"),
    r("", "ind", " ", "AY N D"),
    r("", "ild", " ", "AY L D"),
    r("", "i", "^%", "AY"),
    r("", "i", "#", "IY"),
    r("", "i", "", "IH"),
    // j
    r("", "j", "", "JH"),
    // k
    r(" ", "kn", "", "N"),
    r("", "k", "", "K"),
    // l
    r("", "ll", "", "L"),
    r("", "l", "", "L"),
    // m
    r("", "mm", "", "M"),
    r("", "m", "", "M"),
    // n
    r("", "nn", "", "N"),
    r("", "ng", "#", "NG G"),
    r("", "ng", "", "NG"),
    r("", "nk", "", "NG K"),
    r("", "n", "", "N"),
    // o
    r("", "ook", "", "UH K"),
    r("", "oo", "", "UW"),
    r("", "ought", "", "AO T"),
    r("", "ough", "", "OW"),
    r("", "ous", " ", "AH S"),
    r("", "ould", "", "UH D"),
    r("", "ou", "", "AW"),
    r("", "ow", " ", "OW"),
    r("", "ow", "", "AW"),
    r("", "oi", "", "OY"),
    r("", "oy", "", "OY"),
    r("", "oa", "", "OW"),
    r("", "oe", " ", "OW"),
    r("", "or", "", "AO R"),
    r("", "o", "^%", "OW"),
    r("", "o", " ", "OW"),
    r("", "o", "ld", "OW"),
    r("", "o", "", "AA"),
    // p
    r("", "ph", "", "F"),
    r(" ", "ps", "", "S"),
    r("", "pp", "", "P"),
    r("", "p", "", "P"),
    // q
    r("", "qu", "", "K W"),
    r("", "q", "", "K"),
    // r
    r("", "rr", "", "R"),
    r("", "rh", "", "R"),
    r("", "r", "", "R"),
    // s
    r("", "sch", "", "S K"),
    r("", "sh", "", "SH"),
    r("", "ssion", "", "SH AH N"),
    r("#", "sion", "", "ZH AH N"),
    r("", "sion", "", "SH AH N"),
    r("", "sure", "", "SH ER"),
    r("", "ss", "", "S"),
    r(".", "s", " ", "Z"),
    r("#", "s", "#", "Z"),
    r("", "s", "", "S"),
    // t
    r("", "tion", "", "SH AH N"),
    r("", "tial", "", "SH AH L"),
    r("", "ture", "", "CH ER"),
    r("", "tch", "", "CH"),
    r("", "th", "", "TH"),
    r("", "tt", "", "T"),
    r("", "t", "", "T"),
    // u
    r("", "ue", " ", "UW"),
    r("", "ui", "", "UW"),
    r("", "ur", "#", "UH R"),
    r("", "ur", "", "ER"),
    r(" ", "u", "n", "AH"),
    r("", "u", "^%", "UW"),
    r("", "u", " ", "UW"),
    r("", "u", "", "AH"),
    // v
    r("", "v", "", "V"),
    // w
    r(" ", "wr", "", "R"),
    r("", "wh", "", "W"),
    r("", "war", "", "W AO R"),
    r("", "wor", "", "W ER"),
    r("", "w", "", "W"),
    // x
    r(" ", "x", "", "Z"),
    r("", "x", "", "K S"),
    // y
    r(" ", "y", "#", "Y"),
    r("#:", "y", " ", "IY"),
    r("", "y", " ", "AY"),
    r("", "y", "^%", "AY"),
    r("", "y", "#", "Y"),
    r("", "y", "", "IH"),
    // z
    r("", "zz", "", "Z"),
    r("", "z", "", "Z"),
];

fn is_vowel(c: u8) -> bool {
    matches!(c, b'a' | b'e' | b'i' | b'o' | b'u' | b'y')
}

fn is_consonant(c: u8) -> bool {
    c.is_ascii_lowercase() && !is_vowel(c)
}

fn is_voiced(c: u8) -> bool {
    matches!(c, b'b' | b'd' | b'g' | b'j' | b'l' | b'm' | b'n' | b'r' | b'v' | b'w' | b'z')
}

const SUFFIXES: [&str; 9] = ["ers", "ely", "ing", "es", "ed", "er", "en", "e", "y"];

/// Match `pat` forward against `w[pos..]` (`w` is padded with spaces on both ends).
fn match_right(pat: &[u8], w: &[u8], mut pos: usize) -> bool {
    let mut i = 0;
    while i < pat.len() {
        let c = w.get(pos).copied().unwrap_or(b' ');
        match pat[i] {
            b'#' => {
                if !is_vowel(c) {
                    return false;
                }
                while w.get(pos).copied().is_some_and(is_vowel) {
                    pos += 1;
                }
            }
            b':' => {
                while w.get(pos).copied().is_some_and(is_consonant) {
                    pos += 1;
                }
            }
            b'^' => {
                if !is_consonant(c) {
                    return false;
                }
                pos += 1;
            }
            b'.' => {
                if !is_voiced(c) {
                    return false;
                }
                pos += 1;
            }
            b'+' => {
                if !matches!(c, b'e' | b'i' | b'y') {
                    return false;
                }
                pos += 1;
            }
            b'%' => {
                let rest = &w[pos.min(w.len())..];
                return SUFFIXES.iter().any(|s| rest.starts_with(s.as_bytes()) && rest.get(s.len()).copied().unwrap_or(b' ') == b' ');
            }
            lit => {
                if c != lit {
                    return false;
                }
                pos += 1;
            }
        }
        i += 1;
    }
    true
}

/// Match `pat` backward: its last symbol against `w[pos - 1]`, and so on.
fn match_left(pat: &[u8], w: &[u8], pos: usize) -> bool {
    let mut p = pos as isize - 1;
    let at = |p: isize| if p >= 0 { w.get(p as usize).copied().unwrap_or(b' ') } else { b' ' };
    for &s in pat.iter().rev() {
        let c = at(p);
        match s {
            b'#' => {
                if !is_vowel(c) {
                    return false;
                }
                while p >= 0 && is_vowel(at(p)) {
                    p -= 1;
                }
            }
            b':' => {
                while p >= 0 && is_consonant(at(p)) {
                    p -= 1;
                }
            }
            b'^' => {
                if !is_consonant(c) {
                    return false;
                }
                p -= 1;
            }
            b'.' => {
                if !is_voiced(c) {
                    return false;
                }
                p -= 1;
            }
            b'+' => {
                if !matches!(c, b'e' | b'i' | b'y') {
                    return false;
                }
                p -= 1;
            }
            lit => {
                if c != lit {
                    return false;
                }
                p -= 1;
            }
        }
    }
    true
}

const VOWELS: [&str; 15] = ["AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"];

pub fn is_vowel_phone(p: &str) -> bool {
    VOWELS.contains(&p.trim_end_matches(|c: char| c.is_ascii_digit()))
}

/// Unstressed prefixes: stress moves to the next syllable ("believe", "record").
const UNSTRESSED_PREFIXES: [&str; 10] = ["be", "de", "re", "con", "com", "ex", "pre", "pro", "per", "a"];

/// ARPAbet (with stress digits) for a lowercase a–z word.
pub fn word_to_arpabet(word: &str) -> Vec<String> {
    let w: Vec<u8> = word.bytes().filter(|c| c.is_ascii_lowercase()).collect();
    let mut phones: Vec<String> = Vec::new();
    let mut pos = 0;
    while pos < w.len() {
        let mut matched = false;
        for rule in RULES {
            let g = rule.g.as_bytes();
            if w[pos..].starts_with(g) && match_left(rule.left.as_bytes(), &w, pos) && match_right(rule.right.as_bytes(), &w, pos + g.len()) {
                phones.extend(rule.out.split_whitespace().map(String::from));
                pos += g.len();
                matched = true;
                break;
            }
        }
        if !matched {
            pos += 1; // unreachable for a–z (every letter has a catch-all rule)
        }
    }
    // Two identical consonant phones in a row (from "ck" + "k" etc.) collapse.
    phones.dedup_by(|a, b| a == b && !is_vowel_phone(a));
    assign_stress(word, &mut phones);
    phones
}

/// Primary stress on one vowel, the rest unstressed (reduced vowels → AH0).
fn assign_stress(word: &str, phones: &mut [String]) {
    let vowels: Vec<usize> = (0..phones.len()).filter(|&i| is_vowel_phone(&phones[i])).collect();
    if vowels.is_empty() {
        return;
    }
    let n = vowels.len();
    let primary = if n == 1 {
        0
    } else if ["tion", "sion", "cian", "cial", "tial", "cious", "ic", "ics"].iter().any(|s| word.ends_with(s)) {
        n - 2
    } else if word.ends_with("ity") && n >= 3 {
        n - 3
    } else if UNSTRESSED_PREFIXES.iter().any(|p| word.starts_with(p) && word.len() > p.len() + 2) {
        1
    } else {
        0
    };
    for (k, &i) in vowels.iter().enumerate() {
        let base = phones[i].clone();
        phones[i] = if k == primary {
            format!("{base}1")
        } else if matches!(base.as_str(), "AA" | "AE" | "AH" | "EH") && k + 1 != n {
            "AH0".into()
        } else {
            format!("{base}0")
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(w: &str) -> String {
        word_to_arpabet(w).join(" ")
    }

    #[test]
    fn simple_words() {
        assert_eq!(s("cat"), "K AE1 T");
        assert_eq!(s("make"), "M EY1 K");
        assert_eq!(s("bike"), "B AY1 K");
        assert_eq!(s("ship"), "SH IH1 P");
        assert_eq!(s("night"), "N AY1 T");
        assert_eq!(s("phone"), "F OW1 N");
        assert_eq!(s("sky"), "S K AY1");
        assert_eq!(s("knock"), "N AA1 K");
    }

    #[test]
    fn multi_syllable() {
        assert_eq!(s("happy"), "HH AE1 P IY0");
        assert_eq!(s("station"), "S T EY1 SH AH0 N");
        assert_eq!(s("dogs"), "D AA1 G Z");
        // Every vowel gets a stress digit, exactly one primary.
        for w in ["zorblax", "kryptonite", "flimflam", "brrrap", "skrrt"] {
            let p = word_to_arpabet(w);
            assert!(p.iter().filter(|x| x.ends_with('1')).count() <= 1, "{w}: {p:?}");
            assert!(p.iter().all(|x| !is_vowel_phone(x) || x.ends_with(|c: char| c.is_ascii_digit())), "{w}: {p:?}");
        }
    }
}
