use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const MAX_RESULTS: usize = 10;
const MAX_PER_HOST: usize = 3;
const SNIPPET_LIMIT: usize = 320;
const DISPLAY_LIMIT: usize = 72;

#[derive(Deserialize)]
struct RawResult {
    id: Option<String>,
    name: Option<String>,
    url: Option<String>,
    #[serde(rename = "displayUrl")]
    display_url: Option<String>,
    snippet: Option<String>,
    text: Option<String>,
    summary: Option<String>,
    #[serde(rename = "datePublished")]
    date_published: Option<String>,
}

#[derive(Serialize)]
struct Segment {
    text: String,
    mark: bool,
}

#[derive(Serialize)]
struct UiResult {
    id: String,
    title: Vec<Segment>,
    url: String,
    display: String,
    host: String,
    date: Option<String>,
    snippet: Vec<Segment>,
    score: f64,
}

#[derive(Serialize)]
struct Processed {
    results: Vec<UiResult>,
}

/// Normalize a raw query string: collapse whitespace, cap length.
#[wasm_bindgen]
pub fn clean_query(input: &str) -> String {
    let joined = input.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(300).collect()
}

/// Post-process raw LangSearch results: dedupe, rank, highlight, format dates.
/// `raw` is a JSON array of result objects; `now_ms` is the client's epoch ms.
#[wasm_bindgen]
pub fn process_results(query: &str, now_ms: f64, raw: &str) -> String {
    let terms = query_terms(query);
    let raw_results: Vec<RawResult> = serde_json::from_str(raw).unwrap_or_default();

    let mut seen = std::collections::HashSet::new();
    let mut per_host: HashMap<String, usize> = HashMap::new();
    let mut scored: Vec<(usize, f64, UiResult)> = Vec::new();

    for (idx, r) in raw_results.into_iter().enumerate() {
        let url = match r.url.as_deref() {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => continue,
        };
        let host = host_of(&url);
        let key = dedupe_key(&url);
        if !seen.insert(key) {
            continue;
        }
        let count = per_host.entry(host.clone()).or_insert(0);
        if *count >= MAX_PER_HOST {
            continue;
        }
        *count += 1;

        let title = r
            .name
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or(&host)
            .to_string();
        let body = r
            .snippet
            .as_deref()
            .or(r.summary.as_deref())
            .or(r.text.as_deref())
            .unwrap_or("")
            .trim()
            .to_string();

        let score = rank_score(idx, &title, &body, &url, &terms, r.date_published.is_some());
        let date = r
            .date_published
            .as_deref()
            .and_then(|d| date_label(now_ms, d));

        scored.push((
            idx,
            score,
            UiResult {
                id: r.id.unwrap_or_else(|| format!("r{idx}")),
                title: mark_segments(&truncate_chars(&title, 140), &terms),
                url: url.clone(),
                display: r
                    .display_url
                    .as_deref()
                    .map(|d| truncate_chars(d.trim_end_matches('/'), DISPLAY_LIMIT))
                    .filter(|d| !d.is_empty())
                    .unwrap_or_else(|| display_of(&url)),
                host,
                date,
                snippet: mark_segments(&truncate_chars(&body, SNIPPET_LIMIT), &terms),
                score,
            },
        ));
    }

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let results = scored.into_iter().take(MAX_RESULTS).map(|(_, _, r)| r).collect();
    serde_json::to_string(&Processed { results }).unwrap_or_else(|_| "{\"results\":[]}".into())
}

fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 2)
        .map(str::to_string)
        .collect();
    terms.sort();
    terms.dedup();
    terms.sort_by_key(|t| std::cmp::Reverse(t.len()));
    terms
}

fn host_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split('/').next().unwrap_or(rest);
    host.trim_start_matches("www.").to_lowercase()
}

fn dedupe_key(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.trim_start_matches("www.")
        .trim_end_matches('/')
        .split('#')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn display_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    truncate_chars(rest.trim_end_matches('/'), DISPLAY_LIMIT)
}

/// Blend of original position, query-term coverage, and freshness signals.
fn rank_score(idx: usize, title: &str, body: &str, url: &str, terms: &[String], has_date: bool) -> f64 {
    let mut score = 1.0 / (1.0 + idx as f64 * 0.12);
    if !terms.is_empty() {
        let title_l = title.to_lowercase();
        let body_l = body.to_lowercase();
        let in_title = terms.iter().filter(|t| title_l.contains(t.as_str())).count() as f64;
        let in_body = terms.iter().filter(|t| body_l.contains(t.as_str())).count() as f64;
        score += 0.40 * (in_title / terms.len() as f64) + 0.15 * (in_body / terms.len() as f64);
    }
    if url.starts_with("https://") {
        score += 0.03;
    }
    if has_date {
        score += 0.04;
    }
    score
}

/// Split text into marked/unmarked segments at case-insensitive term hits.
fn mark_segments(text: &str, terms: &[String]) -> Vec<Segment> {
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

fn truncate_chars(s: &str, max: usize) -> String {
    let mut chars = s.chars();
    let truncated: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        let mut t = truncated.trim_end().to_string();
        t.push('…');
        t
    } else {
        truncated
    }
}

/// Relative label ("3 days ago") from an ISO-8601-ish date string.
fn date_label(now_ms: f64, date: &str) -> Option<String> {
    let (y, m, d) = parse_ymd(date)?;
    let then_days = days_from_civil(y, m, d);
    let now_days = (now_ms / 86_400_000.0).floor() as i64;
    let diff = now_days - then_days;
    let label = match diff {
        i64::MIN..=0 => "Today".to_string(),
        1 => "Yesterday".to_string(),
        2..=6 => format!("{diff} days ago"),
        7..=29 => {
            let w = diff / 7;
            if w == 1 { "1 week ago".into() } else { format!("{w} weeks ago") }
        }
        30..=364 => {
            let mo = diff / 30;
            if mo == 1 { "1 month ago".into() } else { format!("{mo} months ago") }
        }
        _ => {
            let yr = diff / 365;
            if yr == 1 { "1 year ago".into() } else { format!("{yr} years ago") }
        }
    };
    Some(label)
}

fn parse_ymd(date: &str) -> Option<(i64, u32, u32)> {
    let b = date.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y = date.get(0..4)?.parse::<i64>().ok()?;
    let m = date.get(5..7)?.parse::<u32>().ok()?;
    let d = date.get(8..10)?.parse::<u32>().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

/// Howard Hinnant's days_from_civil — days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((m + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 9, 24), 20720);
    }

    #[test]
    fn highlights_terms() {
        let segs = mark_segments("Rust and WebAssembly in Rust", &["rust".into(), "wasm".into()]);
        assert!(segs.iter().any(|s| s.mark && s.text == "Rust"));
        assert!(segs.iter().filter(|s| s.mark).count() >= 2);
    }

    #[test]
    fn dedupes_urls() {
        let raw = r#"[
            {"url":"https://a.com/x/","name":"A","snippet":"one"},
            {"url":"http://www.a.com/x","name":"A dup","snippet":"two"},
            {"url":"https://b.com/y","name":"B","snippet":"three"}
        ]"#;
        let out = process_results("test", 1_760_000_000_000.0, raw);
        assert!(out.contains("\"B\""));
        assert!(!out.contains("A dup"));
    }
}
