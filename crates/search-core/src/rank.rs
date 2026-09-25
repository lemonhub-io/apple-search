//! Ranking: BM25 field scoring blended with a provider-order prior and
//! intent-conditioned boosts.

use std::collections::{HashMap, HashSet};

use crate::date;
use crate::intent::Intent;
use crate::model::Doc;
use crate::text;

// BM25 field weights and saturation constants.
const K1: f64 = 1.2;
const B: f64 = 0.75;
const TITLE_W: f64 = 2.6;
const BODY_W: f64 = 1.0;
const PRIOR_W: f64 = 0.30; // trust in the provider's own ordering

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

/// Score every doc and return `(provider_idx, score, doc)` sorted by score
/// descending, ties broken by provider position.
pub fn score_all(
    docs: Vec<Doc>,
    terms: &[String],
    query: &str,
    intent: Intent,
    now_ms: f64,
) -> Vec<(usize, f64, Doc)> {
    let df = document_frequency(&docs);
    let avg_title = avg_len(&docs, |d| d.title_terms.len());
    let avg_body = avg_len(&docs, |d| d.body_terms.len());
    let n = docs.len() as f64;

    let mut scored: Vec<(usize, f64, Doc)> = Vec::with_capacity(docs.len());
    for d in docs {
        let bm = TITLE_W * bm25(&d.title_terms, terms, &df, avg_title, n)
            + BODY_W * bm25(&d.body_terms, terms, &df, avg_body, n);
        let prior = 1.0 / (1.0 + d.idx as f64 * 0.1);
        let boost = intent_boost(intent, query, terms, &d, now_ms);
        scored.push((d.idx, bm * (1.0 - PRIOR_W) + prior * PRIOR_W + boost, d));
    }
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    scored
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

fn bm25(
    doc_terms: &[String],
    query_terms: &[String],
    df: &HashMap<String, usize>,
    avgdl: f64,
    n_docs: f64,
) -> f64 {
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
    let q_norm = text::clean(query).to_lowercase();

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
            if let Some(days) = d.date_raw.as_deref().and_then(|v| date::age_days(now_ms, v)) {
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
