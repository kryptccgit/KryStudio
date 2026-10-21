#[derive(Clone, Debug)]
pub struct IndexEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub tags: Vec<String>,
    pub genres: Vec<String>,
    pub root_note: Option<u8>,
    pub length_sec: f64,
    pub channels: u8,
    pub bpm: Option<f64>,
    pub bars: Option<u32>,
    pub peak_db: f32,
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

pub(crate) fn num(v: f64, decimals: usize) -> String {
    let s = format!("{v:.decimals$}");
    let s = if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s };
    if s == "-0" {
        "0".into()
    } else {
        s
    }
}

fn list(v: &[String]) -> String {
    let items: Vec<String> = v.iter().map(|s| esc(s)).collect();
    format!("[{}]", items.join(", "))
}

pub(crate) fn to_json(generator: &str, entries: &[IndexEntry]) -> String {
    let mut o = String::new();
    o.push_str("{\n  \"version\": 1,\n");
    o.push_str(&format!("  \"generator\": {},\n", esc(generator)));
    o.push_str("  \"samples\": [\n");
    for (i, e) in entries.iter().enumerate() {
        let mut f: Vec<String> = vec![
            format!("\"path\": {}", esc(&e.path)),
            format!("\"name\": {}", esc(&e.name)),
            format!("\"kind\": {}", esc(&e.kind)),
            format!("\"tags\": {}", list(&e.tags)),
            format!("\"genres\": {}", list(&e.genres)),
        ];
        if let Some(r) = e.root_note {
            f.push(format!("\"rootNote\": {r}"));
        }
        f.push(format!("\"lengthSec\": {}", num(e.length_sec, 4)));
        f.push(format!("\"channels\": {}", e.channels));
        if let Some(b) = e.bpm {
            f.push(format!("\"bpm\": {}", num(b, 3)));
        }
        if let Some(b) = e.bars {
            f.push(format!("\"bars\": {b}"));
        }
        f.push(format!("\"peakDb\": {}", num(e.peak_db as f64, 1)));
        o.push_str("    { ");
        o.push_str(&f.join(", "));
        o.push_str(if i + 1 < entries.len() { " },\n" } else { " }\n" });
    }
    o.push_str("  ]\n}\n");
    o
}
