use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

const MAX_RESULTS: usize = 10;
const MAX_PER_HOST: usize = 3;
const SNIPPET_LIMIT: usize = 320;
const DISPLAY_LIMIT: usize = 72;

// BM25 field weights and saturation constants.
const K1: f64 = 1.2;
const B: f64 = 0.75;
const TITLE_W: f64 = 2.6;
const BODY_W: f64 = 1.0;
const PRIOR_W: f64 = 0.30; // trust in the provider's own ordering

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
    intent: &'static str,
}

/// What the query is trying to do. Drives which signals dominate the ranking.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Intent {
    Navigate, // wants a specific site/page: "github", "docs", "download", "login"
    Learn,    // wants explanation: "how to", "what is", "vs", "tutorial"
    Fresh,    // wants recency: "latest", "news", "today"
    General,
}

impl Intent {
    fn label(self) -> &'static str {
        match self {
            Intent::Navigate => "navigate",
            Intent::Learn => "learn",
            Intent::Fresh => "fresh",
            Intent::General => "general",
        }
    }
}

const NAVIGATE_MARKERS: &[&str] = &[
    "login", "signin", "sign in", "official", "site", "website", "homepage", "home page",
    "download", "install", "pricing", "docs", "documentation", "github", "changelog",
    "console", "dashboard", "portal",
];
const LEARN_MARKERS: &[&str] = &[
    "how to", "how do", "what is", "what are", "why", "vs", "versus", "tutorial",
    "guide", "example", "examples", "explained", "compare", "difference", "best way",
    "meaning", "definition",
];
const FRESH_MARKERS: &[&str] = &[
    "today", "tonight", "breaking", "latest", "news", "recent", "recently",
    "this week", "this month", "this year", "weekly", "monthly", "announced",
    "release notes", "update", "updates",
];

// Hosts that republish other sites' content — snapshots, caches, mirrors.
const MIRROR_HOSTS: &[&str] = &[
    "web.archive.org", "archive.org", "webcache.googleusercontent.com",
    "realityripple.com", "cachedview.nl", "cc.bingj.com", "translate.google.com",
];

// Host prefixes that signal reference/teaching material (learn intent).
const DOC_HOST_PREFIXES: &[&str] = &[
    "docs.", "developer.", "learn.", "guide.", "guides.", "manual.", "man.", "wiki.",
    "reference.", "api.", "kb.", "help.",
];

/// Normalize a raw query string: collapse whitespace, cap length.
#[wasm_bindgen]
pub fn clean_query(input: &str) -> String {
    let joined = input.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(300).collect()
}

/// Post-process raw LangSearch candidates: dedupe, classify intent,
/// BM25 rerank with intent-conditioned boosts, highlight, format dates.
/// `raw` is a JSON array of result objects; `now_ms` is the client's epoch ms.
#[wasm_bindgen]
pub fn process_results(query: &str, now_ms: f64, raw: &str) -> String {
    let terms = query_terms(query);
    let intent = classify_intent(query);
    let raw_results: Vec<RawResult> = serde_json::from_str(raw).unwrap_or_default();

    let mut seen = HashSet::new();
    let mut seen_titles: HashSet<(String, String)> = HashSet::new();
    let mut per_host: HashMap<String, usize> = HashMap::new();
    let mut docs: Vec<Doc> = Vec::new();

    for (idx, r) in raw_results.into_iter().enumerate() {
        let url = match r.url.as_deref() {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => continue,
        };
        let host = host_of(&url);
        if !seen.insert(dedupe_key(&url)) {
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

        // Same host + same title almost always means a locale/AMP duplicate.
        if !seen_titles.insert((host.clone(), title.to_lowercase())) {
            continue;
        }

        let body = [r.snippet.as_deref(), r.summary.as_deref(), r.text.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string();

        docs.push(Doc {
            idx,
            id: r.id.unwrap_or_else(|| format!("r{idx}")),
            title_terms: tokenize(&title.to_lowercase()),
            body_terms: tokenize(&body.to_lowercase()),
            title,
            body,
            url,
            host,
            display: r
                .display_url
                .as_deref()
                .map(|d| truncate_chars(d.trim_end_matches('/'), DISPLAY_LIMIT))
                .filter(|d| !d.is_empty()),
            date_raw: r.date_published,
        });
    }

    // Corpus statistics for BM25.
    let df = document_frequency(&docs);
    let avg_title = avg_len(&docs, |d| d.title_terms.len());
    let avg_body = avg_len(&docs, |d| d.body_terms.len());

    let n = docs.len() as f64;
    let mut scored: Vec<(usize, f64, Doc)> = Vec::with_capacity(docs.len());
    for d in docs {
        let bm = TITLE_W * bm25(&d.title_terms, &terms, &df, avg_title, n)
            + BODY_W * bm25(&d.body_terms, &terms, &df, avg_body, n);
        let prior = 1.0 / (1.0 + d.idx as f64 * 0.1);
        let boost = intent_boost(intent, query, &terms, &d, now_ms);
        scored.push((d.idx, bm * (1.0 - PRIOR_W) + prior * PRIOR_W + boost, d));
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));

    let results = scored
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(_, score, d)| UiResult {
            title: mark_segments(&truncate_chars(&d.title, 140), &terms),
            id: d.id,
            display: d.display.unwrap_or_else(|| display_of(&d.url)),
            snippet: mark_segments(&truncate_chars(&d.body, SNIPPET_LIMIT), &terms),
            date: d.date_raw.as_deref().and_then(|v| date_label(now_ms, v)),
            host: d.host,
            url: d.url,
            score,
        })
        .collect();

    serde_json::to_string(&Processed { results, intent: intent.label() })
        .unwrap_or_else(|_| "{\"results\":[],\"intent\":\"general\"}".into())
}

struct Doc {
    idx: usize,
    id: String,
    title: String,
    body: String,
    url: String,
    host: String,
    display: Option<String>,
    date_raw: Option<String>,
    title_terms: Vec<String>,
    body_terms: Vec<String>,
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
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

fn classify_intent(query: &str) -> Intent {
    let q = query.to_lowercase();
    let words: HashSet<&str> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    // Single-word markers need a whole-word match; phrase markers use substring.
    let hit = |markers: &[&str]| {
        markers
            .iter()
            .any(|m| if m.contains(' ') { q.contains(m) } else { words.contains(m) })
    };
    if hit(FRESH_MARKERS) {
        Intent::Fresh
    } else if hit(NAVIGATE_MARKERS) {
        Intent::Navigate
    } else if hit(LEARN_MARKERS) {
        Intent::Learn
    } else {
        Intent::General
    }
}

fn document_frequency(docs: &[Doc]) -> HashMap<String, usize> {
    let mut df: HashMap<String, usize> = HashMap::new();
    for d in docs {
        let mut uniq: HashSet<&str> = HashSet::new();
        uniq.extend(d.title_terms.iter().map(String::as_str));
        uniq.extend(d.body_terms.iter().map(String::as_str));
        for t in uniq {
            *df.entry(t.to_string()).or_insert(0) += 1;
        }
    }
    df
}

fn avg_len(docs: &[Doc], f: impl Fn(&Doc) -> usize) -> f64 {
    if docs.is_empty() {
        return 1.0;
    }
    (docs.iter().map(|d| f(d)).sum::<usize>() as f64 / docs.len() as f64).max(1.0)
}

fn bm25(doc_terms: &[String], query_terms: &[String], df: &HashMap<String, usize>, avgdl: f64, n_docs: f64) -> f64 {
    if doc_terms.is_empty() || query_terms.is_empty() {
        return 0.0;
    }
    let mut freq: HashMap<&str, usize> = HashMap::new();
    for t in doc_terms {
        *freq.entry(t.as_str()).or_insert(0) += 1;
    }
    let dl = doc_terms.len() as f64;
    let mut score = 0.0;
    for t in query_terms {
        let f = *freq.get(t.as_str()).unwrap_or(&0) as f64;
        if f == 0.0 {
            continue;
        }
        let df_t = *df.get(t.as_str()).unwrap_or(&0) as f64;
        let idf = ((n_docs - df_t + 0.5) / (df_t + 0.5) + 1.0).ln();
        score += idf * (f * (K1 + 1.0)) / (f + K1 * (1.0 - B + B * dl / avgdl));
    }
    score
}

/// Intent-conditioned adjustments layered on top of BM25 + provider prior.
fn intent_boost(intent: Intent, query: &str, terms: &[String], d: &Doc, now_ms: f64) -> f64 {
    let mut boost = 0.0;
    let title_l = d.title.to_lowercase();
    let body_l = d.body.to_lowercase();
    let q_norm = clean_query(query).to_lowercase();

    // Exact phrase containment — the single strongest intent signal.
    if q_norm.chars().count() >= 3 {
        if title_l.contains(&q_norm) {
            boost += 0.45;
        } else if body_l.contains(&q_norm) {
            boost += 0.15;
        }
        // Slug form in URL: "cloudflare workers" → ".../cloudflare-workers/..."
        let slug = q_norm.split_whitespace().collect::<Vec<_>>().join("-");
        if !slug.is_empty() && d.url.to_lowercase().contains(&slug) {
            boost += 0.18;
        }
    }

    // Mirrors, caches, and archive snapshots almost never beat the source.
    if MIRROR_HOSTS
        .iter()
        .any(|m| d.host == *m || d.host.ends_with(&format!(".{m}")))
    {
        boost -= 0.30;
    }

    // Host carrying a query term is likely the primary site for the topic.
    if terms
        .iter()
        .any(|t| t.len() > 2 && d.host.contains(t.as_str()))
    {
        boost += match intent {
            Intent::Navigate => 0.30,
            _ => 0.18,
        };
    }

    match intent {
        Intent::Navigate => {
            let path_depth = d
                .url
                .split("://")
                .nth(1)
                .unwrap_or("")
                .split('/')
                .filter(|s| !s.is_empty())
                .count();
            if path_depth <= 1 {
                boost += 0.20;
            }
        }
        Intent::Learn => {
            // Rich body text and dated content help explanatory queries.
            if d.body.chars().count() > 200 {
                boost += 0.08;
            }
            // Documentation-style hosts.
            if DOC_HOST_PREFIXES.iter().any(|p| d.host.starts_with(p))
                || d.host.ends_with(".wikipedia.org")
                || d.host.ends_with(".edu")
                || d.host.ends_with(".gov")
            {
                boost += 0.15;
            }
            if d.date_raw.is_some() {
                boost += 0.03;
            }
        }
        Intent::Fresh => {
            if let Some(days) = d.date_raw.as_deref().and_then(|v| age_days(now_ms, v)) {
                boost += match days {
                    i64::MIN..=1 => 0.30,
                    2..=7 => 0.22,
                    8..=30 => 0.12,
                    31..=90 => 0.05,
                    _ => 0.0,
                };
            }
        }
        Intent::General => {
            if d.date_raw.is_some() {
                boost += 0.03;
            }
        }
    }

    if d.url.starts_with("https://") {
        boost += 0.02;
    }
    boost
}

fn age_days(now_ms: f64, date: &str) -> Option<i64> {
    let (y, m, d) = parse_ymd(date)?;
    Some((now_ms / 86_400_000.0).floor() as i64 - days_from_civil(y, m, d))
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
    let diff = age_days(now_ms, date)?;
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

    #[test]
    fn classifies_intent() {
        assert_eq!(classify_intent("how to deploy workers"), Intent::Learn);
        assert_eq!(classify_intent("github login"), Intent::Navigate);
        assert_eq!(classify_intent("latest rust release"), Intent::Fresh);
        assert_eq!(classify_intent("tokio runtime"), Intent::General);
    }

    #[test]
    fn phrase_beats_scattered_terms() {
        let raw = r#"[
            {"url":"https://a.com/1","name":"Cloud stuff for workers","snippet":"cloud topics and worker topics"},
            {"url":"https://b.com/2","name":"Cloudflare Workers","snippet":"edge compute platform"}
        ]"#;
        let out = process_results("cloudflare workers", 1_760_000_000_000.0, raw);
        let b_pos = out.find("b.com").unwrap();
        let a_pos = out.find("a.com").unwrap();
        assert!(b_pos < a_pos);
    }

    #[test]
    fn mirrors_and_primary_domain() {
        // An archive snapshot and a random republisher should lose to a
        // host that carries the query term.
        let raw = r#"[
            {"url":"https://web.archive.org/web/x","name":"Cloudflare Workers | Cloudflare","snippet":"cloudflare workers edge compute platform snapshot"},
            {"url":"https://copy.example.net/post","name":"Cloudflare Workers explained","snippet":"cloudflare workers edge compute platform"},
            {"url":"https://workers.cloudflare.com/","name":"Cloudflare Workers","snippet":"edge compute platform"}
        ]"#;
        let out = process_results("cloudflare workers", 1_760_000_000_000.0, raw);
        let primary = out.find("workers.cloudflare.com").unwrap();
        let archive = out.find("web.archive.org").unwrap();
        assert!(primary < archive);
    }

    #[test]
    fn dedupes_same_host_same_title() {
        let raw = r#"[
            {"url":"https://developer.mozilla.org/en-US/docs/x","name":"Compiling Rust to WASM","snippet":"one"},
            {"url":"https://developer.mozilla.org/fr/docs/x","name":"Compiling Rust to WASM","snippet":"two"},
            {"url":"https://other.dev/","name":"Different page","snippet":"three"}
        ]"#;
        let out = process_results("rust wasm", 1_760_000_000_000.0, raw);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["results"].as_array().unwrap().len(), 2);
    }
}
