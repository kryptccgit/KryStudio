//! Numbers → English words for the G2P front end ("1990" → "nineteen
//! ninety", "3.5" → "three point five", "21st" → "twenty first").
//! Words are space-separated (no hyphens) because the G2P looks words up one
//! at a time. Krypt-original.

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen",
];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [(u64, &str); 4] = [(1_000_000_000_000, "trillion"), (1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand")];

fn below_100(n: u64, out: &mut Vec<String>) {
    if n < 20 {
        out.push(ONES[n as usize].into());
    } else {
        out.push(TENS[(n / 10) as usize].into());
        if !n.is_multiple_of(10) {
            out.push(ONES[(n % 10) as usize].into());
        }
    }
}

fn below_1000(n: u64, out: &mut Vec<String>) {
    if n >= 100 {
        out.push(ONES[(n / 100) as usize].into());
        out.push("hundred".into());
        if !n.is_multiple_of(100) {
            below_100(n % 100, out);
        }
    } else {
        below_100(n, out);
    }
}

/// "one hundred twenty three". Numbers ≥ 10^15 are read digit by digit.
pub fn cardinal(n: u64) -> String {
    if n >= 1_000_000_000_000_000 {
        return digits(&n.to_string());
    }
    if n == 0 {
        return "zero".into();
    }
    let mut out = Vec::new();
    let mut rest = n;
    for (scale, name) in SCALES {
        if rest >= scale {
            below_1000(rest / scale, &mut out);
            out.push(name.into());
            rest %= scale;
        }
    }
    if rest > 0 {
        below_1000(rest, &mut out);
    }
    out.join(" ")
}

/// Each digit as a word ("3 1 4" → "three one four").
pub fn digits(s: &str) -> String {
    s.chars().filter_map(|c| c.to_digit(10)).map(|d| ONES[d as usize]).collect::<Vec<_>>().join(" ")
}

/// "first", "twenty second", "one hundredth".
pub fn ordinal(n: u64) -> String {
    let c = cardinal(n);
    let (head, last) = match c.rfind(' ') {
        Some(i) => (&c[..=i], &c[i + 1..]),
        None => ("", c.as_str()),
    };
    let last = match last {
        "one" => "first".to_string(),
        "two" => "second".into(),
        "three" => "third".into(),
        "five" => "fifth".into(),
        "eight" => "eighth".into(),
        "nine" => "ninth".into(),
        "twelve" => "twelfth".into(),
        w if w.ends_with('y') => format!("{}ieth", &w[..w.len() - 1]),
        w => format!("{w}th"),
    };
    format!("{head}{last}")
}

/// Years as spoken: 1990 → "nineteen ninety", 1905 → "nineteen oh five",
/// 2000 → "two thousand", 2007 → "two thousand seven", 2024 → "twenty twenty four".
pub fn year(n: u64) -> String {
    if !(1000..=2999).contains(&n) {
        return cardinal(n);
    }
    let (hi, lo) = (n / 100, n % 100);
    if (2000..=2009).contains(&n) || lo == 0 && n.is_multiple_of(1000) {
        return cardinal(n);
    }
    let mut out = Vec::new();
    below_100(hi, &mut out);
    if lo == 0 {
        out.push("hundred".into());
    } else if lo < 10 {
        out.push("oh".into());
        out.push(ONES[lo as usize].into());
    } else {
        below_100(lo, &mut out);
    }
    out.join(" ")
}

/// Plural of a number's last word for decades: "nineties", "twenties".
pub fn plural(words: &str) -> String {
    if let Some(stem) = words.strip_suffix('y') {
        format!("{stem}ies")
    } else if words.ends_with('x') || words.ends_with('s') {
        format!("{words}es")
    } else {
        format!("{words}s")
    }
}

/// Spoken form of one numeric token (digits with optional `,` grouping,
/// a decimal part, an ordinal suffix, an `s` decade suffix or a `%`).
/// None when the token is not a number this understands.
pub fn spell_token(tok: &str) -> Option<String> {
    let t = tok.trim();
    if t.is_empty() || !t.chars().next()?.is_ascii_digit() {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    let (body, pct) = match lower.strip_suffix('%') {
        Some(b) => (b, true),
        None => (lower.as_str(), false),
    };
    let tail = |s: String| if pct { format!("{s} percent") } else { s };
    for suf in ["st", "nd", "rd", "th"] {
        if let Some(num) = body.strip_suffix(suf) {
            let n: u64 = num.replace(',', "").parse().ok()?;
            return Some(tail(ordinal(n)));
        }
    }
    if let Some(num) = body.strip_suffix("'s").or_else(|| body.strip_suffix('s')) {
        let n: u64 = num.parse().ok()?;
        let w = if (1000..=2999).contains(&n) { year(n) } else { cardinal(n) };
        return Some(tail(plural(&w)));
    }
    if let Some((int, frac)) = body.split_once('.') {
        if frac.is_empty() || !frac.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let i: u64 = if int.is_empty() { 0 } else { int.replace(',', "").parse().ok()? };
        return Some(tail(format!("{} point {}", cardinal(i), digits(frac))));
    }
    if !body.chars().all(|c| c.is_ascii_digit() || c == ',') {
        return None;
    }
    let grouped = body.contains(',');
    let digits_only = body.replace(',', "");
    // A leading zero ("007") reads digit by digit.
    if digits_only.len() > 1 && digits_only.starts_with('0') {
        return Some(tail(digits(&digits_only)));
    }
    let n: u64 = digits_only.parse().ok()?;
    // Four-digit numbers without grouping that look like years read as years.
    if !grouped && !pct && digits_only.len() == 4 && (1100..=2099).contains(&n) {
        return Some(year(n));
    }
    Some(tail(cardinal(n)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cardinals() {
        assert_eq!(cardinal(0), "zero");
        assert_eq!(cardinal(7), "seven");
        assert_eq!(cardinal(42), "forty two");
        assert_eq!(cardinal(100), "one hundred");
        assert_eq!(cardinal(1234), "one thousand two hundred thirty four");
        assert_eq!(cardinal(2_000_005), "two million five");
    }

    #[test]
    fn ordinals_years_tokens() {
        assert_eq!(ordinal(1), "first");
        assert_eq!(ordinal(22), "twenty second");
        assert_eq!(ordinal(40), "fortieth");
        assert_eq!(year(1990), "nineteen ninety");
        assert_eq!(year(1905), "nineteen oh five");
        assert_eq!(year(2005), "two thousand five");
        assert_eq!(year(2024), "twenty twenty four");
        assert_eq!(spell_token("1,000").as_deref(), Some("one thousand"));
        assert_eq!(spell_token("3.14").as_deref(), Some("three point one four"));
        assert_eq!(spell_token("90s").as_deref(), Some("nineties"));
        assert_eq!(spell_token("1980s").as_deref(), Some("nineteen eighties"));
        assert_eq!(spell_token("21st").as_deref(), Some("twenty first"));
        assert_eq!(spell_token("50%").as_deref(), Some("fifty percent"));
        assert_eq!(spell_token("007").as_deref(), Some("zero zero seven"));
        assert_eq!(spell_token("abc"), None);
    }
}
