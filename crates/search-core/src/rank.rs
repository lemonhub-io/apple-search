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
const VETTED_TLDS: &[&str] = &["edu", "gov", "mil", "int"];
// Institutional second-level labels inside country-code TLDs — the same
// restricted-registration property, applied worldwide: cam.ac.uk,
// www.gov.uk, nic.go.jp, sat.gob.mx, impots.gouv.fr.
const VETTED_SLDS: &[&str] = &["ac", "edu", "gov", "go", "gob", "gouv", "govt", "mil"];

// Body text that means the provider hit a wall — the extract is the block
// page, not the article.
const BLOCKED_MARKERS: &[&str] = &[
    "enable javascript", "javascript is required", "javascript is disabled",
    "please enable js", "verify you are human", "verify that you are",
    "are you a robot", "access denied", "403 forbidden", "attention required",
    "checking your browser", "unsupported browser", "browser is out of date",
];
// Extracts dominated by consent/footer chrome — thin for our purposes, but
// not necessarily a junk page, so the penalty is shallower.
const BOILERPLATE_MARKERS: &[&str] = &[
    "accept cookies", "accept all cookies", "we use cookies", "cookie policy",
    "subscribe to our newsletter", "all rights reserved",
];

// User-space publishing platforms: subdomains belong to users, not the
// platform — foo.github.io isn't GitHub. Functional categorization
// (hosted user content), same class as MIRROR_HOSTS.
const USERSPACE_HOSTS: &[&str] = &[
    "github.io", "gitlab.io", "wordpress.com", "blogspot.com", "medium.com",
    "substack.com", "tumblr.com", "wixsite.com", "weebly.com", "webflow.io",
    "vercel.app", "netlify.app", "pages.dev", "workers.dev", "herokuapp.com",
    "firebaseapp.com", "web.app", "appspot.com", "notion.site", "ghost.io",
];

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
            // A manipulated title is an SEO weapon, not a relevance signal —
            // separator-stuffing and clickbait alike lose the title's full
            // BM25 weight so keyword density can't buy the top slot.
            let title_w = if title_stuffed(&d.title) || title_clickbait(&d.title) {
                1.0
            } else {
                TITLE_W
            };
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
    let q_norm = parsed.base.to_lowercase();

    // URL anatomy, shared across intents: real documents live at named
    // paths; tracking endpoints live in query strings.
    let rest = d.url.split("://").nth(1).unwrap_or("");
    let path = rest.split_once('/').map(|(_, p)| p).unwrap_or("");
    let path_l = path.to_lowercase();
    let term_in_path = parsed.terms.iter().any(|t| {
        t.len() > 2
            && path_l
                .split(|c: char| !c.is_alphanumeric())
                .any(|p| p == t.as_str())
    });

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

    // Term adjacency: consecutive query words appearing adjacent in the doc
    // is a relevance signal scattered-term matches can't express
    // ("memory safety" vs "memory … safety" 40 lines apart).
    let q_words = crate::text::tokenize(&q_norm);
    let mut title_bigrams = 0;
    for pair in q_words.windows(2) {
        let bigram = format!("{} {}", pair[0], pair[1]);
        if title_l.contains(&bigram) {
            if title_bigrams < 2 {
                title_bigrams += 1;
                boost += 0.10;
            }
        } else if body_l.contains(&bigram) {
            boost += 0.04;
        }
    }

    // Term as a URL path segment: "/docs/rate-limits" is a destination,
    // "/?q=rate-limits" is a form result. Navigate weighs it far higher —
    // "github login" wants github.com/login.
    if term_in_path {
        boost += match intent {
            Intent::Navigate => 0.25,
            _ => 0.07,
        };
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

    // Coverage honesty: a doc sharing no query term at all rode in on
    // provider prior alone — it has no claim to relevance.
    let covers_any = parsed
        .terms
        .iter()
        .any(|t| title_l.contains(t.as_str()) || body_l.contains(t.as_str()));
    if !covers_any && !parsed.terms.is_empty() {
        boost -= 0.10;
    }

    match intent {
        Intent::Navigate => {
            let path_depth = path.split('/').filter(|s| !s.is_empty()).count();
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
            if d.date_ymd.is_some() {
                boost += 0.03;
            }
        }
        Intent::Fresh => {
            if let Some(days) = d.date_ymd.as_deref().and_then(|v| date::age_days(now_ms, v)) {
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
            if d.date_ymd.is_some() {
                boost += 0.03;
            }
        }
    }

    // Date-operator queries: undated docs can't prove they qualify.
    if (parsed.date_after.is_some() || parsed.date_before.is_some()) && d.date_ymd.is_none() {
        boost -= 0.15;
    }
    // A date >2 days in the future is metadata lying, not freshness.
    if let Some(days) = d.date_ymd.as_deref().and_then(|v| date::age_days(now_ms, v)) {
        if days < -2 {
            boost -= 0.08;
        }
    }

    if d.url.starts_with("https://") {
        boost += 0.02;
    } else if d.url.starts_with("http://") {
        // Plain HTTP is unverified transport — mildly suspect for any page
        // still served that way.
        boost -= 0.08;
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
    if title_clickbait(&d.title) {
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

    // Block pages and consent walls: the extract is site chrome, not
    // content — nothing to rank or display.
    let body_lc = d.body.to_lowercase();
    if BLOCKED_MARKERS.iter().any(|m| body_lc.contains(m)) {
        q -= 0.30;
    } else if BOILERPLATE_MARKERS.iter().any(|m| body_lc.contains(m)) {
        q -= if body_lc.len() < 300 { 0.22 } else { 0.04 };
    }

    // Restricted-registration namespaces carry institutional vetting.
    if vetted_namespace(&d.host) {
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

/// Restricted-registration namespace check — a bare vetted TLD (x.edu) or
/// an institutional second level under a country code (x.ac.uk, x.gov.cn).
/// Pub for the UI trust cue.
pub(crate) fn vetted_namespace(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    match labels.as_slice() {
        [] | [_] => false,
        [.., tld] if VETTED_TLDS.contains(tld) => true,
        // SLD rule requires a country TLD so "ac.com"-style labels don't
        // slip through — `.ac`/`.go` are institutional only inside ccTLDs.
        [.., sld, tld] => tld.len() == 2 && VETTED_SLDS.contains(sld),
    }
}

/// Is the queried entity's name actually the registrable domain — i.e. the
/// host is (a subdomain of) the entity's own site? Only the SLD counts:
/// "github" in `github.evil-corp.com` is a subdomain squat, not ownership,
/// and `github` inside a hyphen-chain SLD (`best-github-hacks-2026`) is
/// impersonation bait. Matches: github.com, docs.github.com,
/// stack-overflow.com ("overflow"), stackoverflow.com ("stack overflow").
/// Pub for the UI trust cue — a badge that overclaims is worse than none.
pub(crate) fn host_carries_term(host: &str, parsed: &Parsed) -> bool {
    let sld_raw = match registrable_sld(host) {
        Some(s) => s,
        None => return false,
    };
    let sld = sld_raw.replace('-', "");
    // The SLD is a query term itself: github.com, or "cloudflare" in
    // workers.cloudflare.com.
    if parsed
        .terms
        .iter()
        .any(|t| t.len() > 2 && (sld_raw == t.as_str() || sld == *t))
    {
        return true;
    }
    // A hyphen-part of a clean SLD: "overflow" ⊂ stack-overflow.com.
    // ≥2 hyphens is the disposable-domain pattern, never ownership.
    if sld_raw.matches('-').count() <= 1
        && parsed
            .terms
            .iter()
            .any(|t| t.len() > 2 && sld_raw.split('-').any(|p| p == t.as_str()))
    {
        return true;
    }
    // Whole-query brand squash: "stack overflow" → stackoverflow.com.
    let brand = parsed.base.to_lowercase().replace(' ', "");
    brand.len() > 2 && sld == brand
}

/// The label that actually identifies the registrable owner: normally the
/// SLD (github.com → "github"), but on user-space platforms the account
/// label directly left of the platform suffix (alice.github.io → "alice").
fn registrable_sld<'a>(host: &'a str) -> Option<&'a str> {
    let labels: Vec<&'a str> = host.split('.').collect();
    for uh in USERSPACE_HOSTS {
        let depth = uh.split('.').count();
        if labels.len() > depth && crate::url::host_matches(host, uh) {
            return labels.get(labels.len() - depth - 1).copied();
        }
    }
    labels.get(labels.len().checked_sub(2)?).copied()
}

/// Keyword-stuffed title: dense separators, or several in a long title.
fn title_stuffed(title: &str) -> bool {
    let seps = title
        .chars()
        .filter(|c| TITLE_SEPARATORS.contains(c))
        .count();
    seps >= 3 || (seps >= 2 && title.chars().count() > 90)
}

/// Attention-bait title: ALL-CAPS word runs, repeated !/?, or pictographs —
/// signals of clickbait and scraped SEO pages, not of edited publications.
fn title_clickbait(title: &str) -> bool {
    let caps_words = title
        .split_whitespace()
        .filter(|w| {
            let mut n = 0;
            w.chars().filter(|c| c.is_alphabetic()).all(|c| {
                n += 1;
                c.is_uppercase()
            }) && n >= 2
        })
        .count();
    if caps_words >= 3 {
        return true;
    }
    if title.chars().filter(|c| matches!(c, '!' | '?')).count() >= 2 {
        return true;
    }
    // Emoji/pictograph blocks — a legit headline might carry one, not two+.
    title.chars().filter(|&c| (c as u32) >= 0x1F000).count() >= 2
}
