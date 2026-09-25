//! Data model: upstream input shape, internal doc, and UI output shape.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::highlight::Segment;
use crate::text::{self, Parsed};
use crate::url;

/// Max results admitted per host before the engine moves on.
const MAX_PER_HOST: usize = 3;
const DISPLAY_LIMIT: usize = 72;

/// One result as delivered by the upstream search API.
#[derive(Deserialize)]
pub struct RawResult {
    pub id: Option<String>,
    pub name: Option<String>,
    pub url: Option<String>,
    #[serde(rename = "displayUrl")]
    pub display_url: Option<String>,
    pub snippet: Option<String>,
    pub text: Option<String>,
    pub summary: Option<String>,
    #[serde(rename = "datePublished")]
    pub date_published: Option<String>,
}

/// A normalized, tokenized candidate ready for scoring.
pub struct Doc {
    pub idx: usize,
    pub id: String,
    pub title: String,
    pub body: String,
    pub url: String,
    pub host: String,
    pub display: Option<String>,
    pub date_raw: Option<String>,
    pub title_terms: Vec<String>,
    pub body_terms: Vec<String>,
}

/// Does `host` match a filter domain (exact or subdomain)?
fn host_matches(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// Filter and normalize raw candidates into docs: drops entries without a
/// URL, enforces `site:`/`-site:` and `-term` operators, dedupes by canonical
/// URL and by (host, title), caps per-host count.
pub fn collect_docs(raw_results: Vec<RawResult>, parsed: &Parsed) -> Vec<Doc> {
    let mut seen = HashSet::new();
    let mut seen_titles: HashSet<(String, String)> = HashSet::new();
    let mut per_host: HashMap<String, usize> = HashMap::new();
    let mut docs: Vec<Doc> = Vec::new();

    for (idx, r) in raw_results.into_iter().enumerate() {
        let url_str = match r.url.as_deref() {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => continue,
        };
        let host = url::host_of(&url_str);

        // Domain operators — upstream filters these too; this is a
        // defense-in-depth check for cached or expanded results.
        if !parsed.include_hosts.is_empty()
            && !parsed.include_hosts.iter().any(|d| host_matches(&host, d))
        {
            continue;
        }
        if parsed.exclude_hosts.iter().any(|d| host_matches(&host, d)) {
            continue;
        }

        if !seen.insert(url::dedupe_key(&url_str)) {
            continue;
        }

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

        // -term exclusion: a doc carrying the term anywhere is out.
        let haystack = format!("{} {} {}", title.to_lowercase(), body.to_lowercase(), host);
        if parsed.excluded.iter().any(|t| haystack.contains(t.as_str())) {
            continue;
        }

        let count = per_host.entry(host.clone()).or_insert(0);
        if *count >= MAX_PER_HOST {
            continue;
        }
        *count += 1;

        docs.push(Doc {
            idx,
            id: r.id.unwrap_or_else(|| format!("r{idx}")),
            title_terms: text::tokenize(&title.to_lowercase()),
            body_terms: text::tokenize(&body.to_lowercase()),
            title,
            body,
            url: url_str,
            host,
            display: r
                .display_url
                .as_deref()
                .map(|d| text::truncate_chars(d.trim_end_matches('/'), DISPLAY_LIMIT))
                .filter(|d| !d.is_empty()),
            date_raw: r.date_published,
        });
    }
    docs
}

/// One result as rendered by the UI.
#[derive(Serialize)]
pub struct UiResult {
    pub id: String,
    pub title: Vec<Segment>,
    pub url: String,
    pub display: String,
    pub host: String,
    pub date: Option<String>,
    pub snippet: Vec<Segment>,
    pub score: f64,
}

/// Top-level payload returned to the JS side.
#[derive(Serialize)]
pub struct Processed {
    pub results: Vec<UiResult>,
    pub intent: &'static str,
}
