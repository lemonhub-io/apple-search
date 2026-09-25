//! Term highlighting: split text into marked/unmarked segments.

use serde::Serialize;

#[derive(Serialize)]
pub struct Segment {
    pub text: String,
    pub mark: bool,
}

/// Split text into marked/unmarked segments at case-insensitive term hits.
pub fn mark_segments(text: &str, terms: &[String]) -> Vec<Segment> {
    if terms.is_empty() || text.is_empty() {
        return vec![Segment { text: text.to_string(), mark: false }];
    }
    let lower = text.to_lowercase();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for t in terms {
        let mut start = 0;
        while start + t.len() <= lower.len() {
            match lower[start..].find(t.as_str()) {
                Some(pos) => {
                    let s = start + pos;
                    let e = s + t.len();
                    ranges.push((s, e));
                    start = e;
                }
                None => break,
            }
        }
    }
    ranges.sort_unstable();

    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (s, e) in ranges {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }

    // Byte offsets come from `lower`; slicing `text` may fail where case-folding
    // changed byte lengths — `get` guards that, falling back to unmarked text.
    let mut out: Vec<Segment> = Vec::new();
    let mut cursor = 0;
    for (s, e) in merged {
        if s < cursor {
            continue;
        }
        match (text.get(cursor..s), text.get(s..e)) {
            (Some(plain), Some(hit)) => {
                if !plain.is_empty() {
                    out.push(Segment { text: plain.to_string(), mark: false });
                }
                out.push(Segment { text: hit.to_string(), mark: true });
                cursor = e;
            }
            _ => break,
        }
    }
    if let Some(tail) = text.get(cursor..) {
        if !tail.is_empty() {
            out.push(Segment { text: tail.to_string(), mark: false });
        }
    }
    if out.is_empty() {
        out.push(Segment { text: text.to_string(), mark: false });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_terms() {
        let segs = mark_segments("Rust and WebAssembly in Rust", &["rust".into(), "wasm".into()]);
        assert!(segs.iter().any(|s| s.mark && s.text == "Rust"));
        assert!(segs.iter().filter(|s| s.mark).count() >= 2);
    }
}
