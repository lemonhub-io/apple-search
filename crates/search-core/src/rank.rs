//! Ranking: BM25 field scoring blended with a provider-order prior and
//! intent-conditioned boosts.

use std::collections::{HashMap, HashSet};

use crate::date;
use crate::intent::Intent;
use crate::model::Doc;
use crate::text::Parsed;

// BM25 field weights and saturation constants.
const K1: f64 = 1.2;
const B: f64 = 0.75;
const TITLE_W: f64 = 2.6;
const BODY_W: f64 = 1.0;
const PRIOR_W: f64 = 0.30; // trust in the provider's own ordering

// Hosts that republish other sites' content — snapshots, caches, mirrors.
// A functional dedup category (republished copies, not editorial judgment).
const MIRROR_HOSTS: &[&str] = &[
    "web.archive.org", "archive.org", "webcache.googleusercontent.com",
    "realityripple.com", "cachedview.nl", "cc.bingj.com", "translate.google.com",
];

// Host prefixes that signal reference/teaching material (learn intent) —
// a web-wide naming convention, not a site whitelist.
const DOC_HOST_PREFIXES: &[&str] = &[
    "docs.", "doc.", "developer.", "learn.", "guide.", "guides.", "manual.",
    "man.", "wiki.", "reference.", "api.", "kb.", "help.",
];

// Restricted-registration TLDs: vetting is a property of the namespace
// itself (you cannot buy a .edu/.gov without accreditation/authority).
const VETTED_TLDS: &[&str] = &["edu", "gov", "mil"];

// Title separators — a high count in a long title signals keyword stuffing.
const TITLE_SEPARATORS: [char; 4] = ['|', '·', '—', '»'];

/// Score every doc and return `(provider_idx, score, doc)` sorted by score
/// descending, ties broken by provider position.
pub fn score_all(
    docs: Vec<Doc>,
    parsed: &Parsed,
    intent: Intent,
    now_ms: f64,
) -> Vec<(usize, f64, Doc)> {
    // Scores are computed by reference (the df map borrows term strings from
    // the docs), then zipped back with the owned docs — order is preserved
    // because both sequences walk the same vector.
    let mut scores: Vec<(usize, f64)> = Vec::with_capacity(docs.len());
    {
        let df = document_frequency(&docs);
        let avg_title = avg_len(&docs, |d| d.title_terms.len());
        let avg_body = avg_len(&docs, |d| d.body_terms.len());
        let n = docs.len() as f64;
        for d in &docs {
            // A stuffed title is an SEO weapon, not a relevance signal —
            // demote its BM25 weight so separator-spam can't buy the top slot.
            let title_w = if title_stuffed(&d.title) { 1.0 } else { TITLE_W };
            let bm = title_w * bm25(&d.title_terms, &parsed.terms, &df, avg_title, n)
                + BODY_W * bm25(&d.body_terms, &parsed.terms, &df, avg_body, n);
            let prior = 1.0 / (1.0 + d.idx as f64 * 0.1);
            let boost = intent_boost(intent, parsed, d, now_ms);
            scores.push((d.idx, bm * (1.0 - PRIOR_W) + prior * PRIOR_W + boost));
        }
    }
    let mut scored: Vec<(usize, f64, Doc)> = scores
        .into_iter()
        .zip(docs)
        .map(|((idx, s), d)| (idx, s, d))
        .collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    scored
}

fn document_frequency<'a>(docs: &'a [Doc]) -> HashMap<&'a str, usize> {
    let mut df: HashMap<&'a str, usize> = HashMap::new();
    for d in docs {
        let mut uniq: HashSet<&'a str> = HashSet::new();
        uniq.extend(d.title_terms.iter().map(String::as_str));
        uniq.extend(d.body_terms.iter().map(String::as_str));
        for t in uniq {
            *df.entry(t).or_insert(0) += 1;
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
    df: &HashMap<&str, usize>,
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
fn intent_boost(intent: Intent, parsed: &Parsed, d: &Doc, now_ms: f64) -> f64 {
    let mut boost = 0.0;
    let title_l = d.title.to_lowercase();
    let body_l = d.body.to_lowercase();
    let url_l = d.url.to_lowercase();

    // Quoted phrases ("exact match") get their own strong containment bonus.
    for ph in &parsed.phrases {
        if title_l.contains(ph.as_str()) {
            boost += 0.40;
        } else if body_l.contains(ph.as_str()) {
            boost += 0.15;
        }
        if url_l.contains(&ph.replace(' ', "-")) {
            boost += 0.15;
        }
    }

    // Whole-query containment — the single strongest implicit signal.
    let q_norm = parsed.base.to_lowercase();
    if q_norm.chars().count() >= 3 {
        if title_l.contains(&q_norm) {
            boost += 0.45;
        } else if body_l.contains(&q_norm) {
            boost += 0.15;
        }
        // Slug form in URL: "cloudflare workers" → ".../cloudflare-workers/..."
        let slug = q_norm.split_whitespace().collect::<Vec<_>>().join("-");
        if !slug.is_empty() && url_l.contains(&slug) {
            boost += 0.18;
        }
    }

    // Mirrors, caches, and archive snapshots are stale copies — they should
    // essentially never outrank the live source.
    if MIRROR_HOSTS
        .iter()
        .any(|m| crate::url::host_matches(&d.host, m))
    {
        boost -= 0.55;
    }

    boost += quality_prior(d);

    // Host carrying the entity is likely the primary site for the topic —
    // decisive for navigational queries, a hint otherwise.
    if host_carries_term(&d.host, parsed) {
        boost += match intent {
            Intent::Navigate => 0.55,
            _ => 0.18,
        };
    }

    match intent {
        Intent::Navigate => {
            // URL anatomy separates destinations from utility pages: the
            // homepage for "github" is depth-0 on github.com; the listing
            // page for it is github.com/orgs/github/packages (depth 3).
            let rest = d.url.split("://").nth(1).unwrap_or("");
            let path = rest.split_once('/').map(|(_, p)| p).unwrap_or("");
            let path_l = path.to_lowercase();
            let path_depth = path.split('/').filter(|s| !s.is_empty()).count();

            // Modifier in path: "github login" wants github.com/login.
            // Segment-aware, so "/authenticate/elogin" doesn't count.
            if parsed.terms.iter().any(|t| {
                t.len() > 2
                    && path_l
                        .split(|c: char| !c.is_alphanumeric())
                        .any(|p| p == t.as_str())
            }) {
                boost += 0.25;
            }
            match path_depth {
                0..=1 => boost += 0.25, // canonical landing page
                2 => {}
                _ => boost -= 0.15, // deep listing/utility/community page
            }
            // Parameter-bloated URLs are tracking/utility endpoints, not
            // destinations ("…/authorize?client_id=…&state=…").
            if let Some((_, qs)) = path.split_once('?') {
                if qs.len() > 40 {
                    boost -= 0.12;
                }
            }
            // A destination's title leads with the entity name
            // ("GitHub · Let's build…", "Rust — Official site").
            if parsed.terms.iter().any(|t| {
                t.len() > 2
                    && title_l
                        .split_whitespace()
                        .take(4)
                        .any(|w| w.contains(t.as_str()))
            }) {
                boost += 0.18;
            }
        }
        Intent::Learn => {
            // Rich body text and dated content help explanatory queries.
            if d.body.chars().count() > 200 {
                boost += 0.08;
            }
            // Documentation-style hosts (web naming convention).
            if DOC_HOST_PREFIXES.iter().any(|p| d.host.starts_with(p)) {
                boost += 0.15;
            }
            if d.date_raw.is_some() {
                boost += 0.03;
            }
        }
        Intent::Fresh => {
            if let Some(days) = d.date_raw.as_deref().and_then(|v| date::age_days(now_ms, v)) {
                // -1 covers timezone slop; farther-future dates are publisher
                // metadata lying, not freshness — they get no boost at all.
                boost += match days {
                    -1..=1 => 0.30,
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

/// Structural quality prior — no domain whitelists: spam and thin-content
/// pages betray themselves through URL shape, title stuffing, and
/// fragment-soup extracts, so these signals generalize to any host.
fn quality_prior(d: &Doc) -> f64 {
    let mut q = 0.0;

    // Domain shape: hyphen-chained or digit-spiked names are classic
    // disposable/SEO domains ("best-cheap-widgets-2024.example"); real
    // brands are short, clean labels. Punycode (xn--) marks IDN spoofs.
    let domain_part = d
        .host
        .rsplit_once('.')
        .map(|(rest, _)| rest)
        .unwrap_or(&d.host);
    let hyphens = domain_part.matches('-').count();
    if hyphens >= 2 {
        q -= 0.20;
    }
    if hyphens >= 1 && domain_part.chars().any(|c| c.is_ascii_digit()) {
        q -= 0.10;
    }
    if domain_part.split('.').any(|l| l.starts_with("xn--")) {
        q -= 0.15;
    }

    if title_stuffed(&d.title) {
        q -= 0.20;
    }
    // Same word repeated ≥3× in the title is repetition stuffing.
    let mut word_freq: HashMap<&str, usize> = HashMap::new();
    let title_lc = d.title.to_lowercase();
    for w in title_lc.split_whitespace() {
        *word_freq.entry(w).or_insert(0) += 1;
    }
    if word_freq.values().any(|&c| c >= 3) {
        q -= 0.15;
    }

    // Prose coherence: real articles and docs are complete sentences;
    // nav dumps, link lists, and scraped fragments are not. Only judged
    // when there's enough text to contain prose — a short snippet can't.
    let body = d.body.trim();
    if body.chars().count() >= 120 {
        let total = body.chars().count();
        let prose: usize = crate::snippet::split_sentences(body)
            .iter()
            .filter(|s| s.chars().count() >= 40)
            .map(|s| s.chars().count())
            .sum();
        let ratio = prose as f64 / total as f64;
        if ratio < 0.20 {
            q -= 0.30; // fragment soup — thin or scraped content
        } else if ratio > 0.55 {
            q += 0.05;
        }
    }

    // Restricted-registration namespaces carry institutional vetting.
    if VETTED_TLDS
        .iter()
        .any(|t| crate::url::host_matches(&d.host, t))
    {
        q += 0.10;
    }

    // Nearly empty extracts mean the provider saw almost no content —
    // thin, blocked, or boilerplate-only pages.
    let body_len = d.body.trim().chars().count();
    if body_len < 60 {
        q -= 0.12;
    }

    // Independent spam signals compound: several at once means the page is
    // almost certainly junk, so the demotion deepens non-linearly.
    if q <= -0.45 {
        q -= 0.35;
    }
    q
}

/// Does the host carry the entity as a domain label, or the whole query as
/// a squashed brand? Label granularity keeps "login" from crediting
/// "loginradius.com" while still matching "github"→github.com,
/// "workers"→workers.cloudflare.com, "stack overflow"→stackoverflow.com.
fn host_carries_term(host: &str, parsed: &Parsed) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let domain = labels[..labels.len() - 1].join("."); // everything before the TLD
    // Query term is a domain label or hyphen-part: "workers" ⊂ workers.cloudflare.com
    if parsed.terms.iter().any(|t| {
        t.len() > 2 && domain.split(['.', '-']).any(|p| p == t.as_str())
    }) {
        return true;
    }
    // Brand containment, either direction: "stack overflow" → stackoverflow.com,
    // "cloudflare workers" → cloudflare.com. "loginradius" satisfies neither.
    let brand = parsed.base.to_lowercase().replace(' ', "");
    let sld = labels[labels.len() - 2].replace('-', "");
    (sld.len() >= 4 && brand.contains(&sld)) || (brand.len() > 2 && sld.contains(&brand))
}

/// Keyword-stuffed title: dense separators, or several in a long title.
fn title_stuffed(title: &str) -> bool {
    let seps = title
        .chars()
        .filter(|c| TITLE_SEPARATORS.contains(c))
        .count();
    seps >= 3 || (seps >= 2 && title.chars().count() > 90)
}
