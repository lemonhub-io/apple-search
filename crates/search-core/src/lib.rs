//! Search result post-processing engine compiled to WebAssembly.
//!
//! Pipeline: parse → dedupe/normalize → intent classify → BM25 rerank with
//! intent-conditioned boosts → highlight → serialize.

mod date;
mod highlight;
mod intent;
mod model;
mod rank;
mod snippet;
mod text;
mod url;

use wasm_bindgen::prelude::*;

use model::{Processed, RawResult, UiResult};

const MAX_RESULTS: usize = 10;
const TITLE_LIMIT: usize = 140;
const SNIPPET_LIMIT: usize = 320;

/// Normalize a raw query string: collapse whitespace, cap length.
#[wasm_bindgen]
pub fn clean_query(input: &str) -> String {
    text::clean(input)
}

/// Post-process raw LangSearch candidates: dedupe, classify intent,
/// BM25 rerank with intent-conditioned boosts, highlight, format dates.
/// `raw` is a JSON array of result objects; `now_ms` is the client's epoch ms.
#[wasm_bindgen]
pub fn process_results(query: &str, now_ms: f64, raw: &str) -> String {
    let parsed = text::parse_query(query);
    let intent = intent::classify(&parsed.base);
    let raw_results: Vec<RawResult> = serde_json::from_str(raw).unwrap_or_default();
    let docs = model::collect_docs(raw_results, &parsed);

    let scored = rank::score_all(docs, &parsed, intent, now_ms);

    let results = scored
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(_, score, d)| UiResult {
            title: highlight::mark_segments(
                &text::truncate_chars(&d.title, TITLE_LIMIT),
                &parsed.terms,
            ),
            id: d.id,
            display: d.display.unwrap_or_else(|| url::display_of(&d.url)),
            snippet: highlight::mark_segments(
                &snippet::best_snippet(&d.body, &parsed.terms, SNIPPET_LIMIT),
                &parsed.terms,
            ),
            date: d.date_raw.as_deref().and_then(|v| date::label(now_ms, v)),
            cred: if rank::host_carries_term(&d.host, &parsed) {
                Some("official")
            } else if rank::vetted_namespace(&d.host) {
                Some("vetted")
            } else {
                None
            },
            host: d.host,
            url: d.url,
            score,
        })
        .collect();

    serde_json::to_string(&Processed { results, intent: intent.label() })
        .unwrap_or_else(|_| "{\"results\":[],\"intent\":\"general\"}".into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn navigate_prefers_homepage_over_utility_pages() {
        // The reported failure: listing/community pages outranked the
        // official destination for a navigational query.
        let raw = r#"[
            {"url":"https://github.com/orgs/github/packages","name":"Packages · GitHub","snippet":"github packages listing"},
            {"url":"https://github.com/orgs/github/discussions","name":"Discussions · GitHub","snippet":"github discussions community threads"},
            {"url":"https://github.com/","name":"GitHub · Build software better","snippet":"github is where people build software"}
        ]"#;
        let out = process_results("github", 1_760_000_000_000.0, raw);
        let home = out.find("\"https://github.com/\"").unwrap();
        let pkgs = out.find("orgs/github/packages").unwrap();
        assert!(home < pkgs, "homepage should outrank the packages listing");
    }

    #[test]
    fn navigate_modifier_finds_action_page() {
        // "github login" wants github.com/login, not the homepage.
        let raw = r#"[
            {"url":"https://github.com/","name":"GitHub · Build software better","snippet":"github is where people build software"},
            {"url":"https://github.com/login","name":"Sign in to GitHub","snippet":"sign in to your github account"}
        ]"#;
        let out = process_results("github login", 1_760_000_000_000.0, raw);
        let login = out.find("github.com/login").unwrap();
        let home = out.find("\"https://github.com/\"").unwrap();
        assert!(login < home, "the login page should win for 'github login'");
    }

    #[test]
    fn seo_stuffed_domain_loses_to_clean_match() {
        // Structural quality: hyphen-chained domain + fragment-soup extract.
        let raw = r#"[
            {"url":"https://best-rust-tutorial-2024.example.com/x","name":"Rust Tutorial | Learn Rust | Best Guide | Rust Examples | Top Tutorial","snippet":"Home | About | Links | Rust | More | Nav | Menu | Tags"},
            {"url":"https://doc.rust-lang.org/book/","name":"The Rust Programming Language","snippet":"The Rust Programming Language is an official guide that teaches you how to write Rust programs. It covers ownership, borrowing, and the type system in detail."}
        ]"#;
        let out = process_results("rust tutorial", 1_760_000_000_000.0, raw);
        let rustdoc = out.find("doc.rust-lang.org").unwrap();
        let seo = out.find("best-rust-tutorial-2024").unwrap();
        assert!(rustdoc < seo, "clean doc page should beat the SEO-stuffed page");
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

    #[test]
    fn field_operators_filter() {
        // inurl:/intitle: are hard filters — non-matching docs drop out.
        let raw = r#"[
            {"url":"https://a.com/docs/wasm-guide","name":"WASM Guide","snippet":"webassembly guide"},
            {"url":"https://b.com/other/page","name":"WASM Guide","snippet":"webassembly guide"},
            {"url":"https://c.com/docs/wasm-guide","name":"Totally Different","snippet":"webassembly guide"}
        ]"#;
        let out = process_results("wasm inurl:guide intitle:wasm", 1_760_000_000_000.0, raw);
        assert!(out.contains("a.com"));
        assert!(!out.contains("b.com"), "inurl:guide should drop b.com");
        assert!(!out.contains("c.com"), "intitle:wasm should drop c.com");
    }

    #[test]
    fn date_operators_filter_and_penalize_undated() {
        let raw = r#"[
            {"url":"https://a.com/old","name":"Rust WASM","snippet":"compiling rust to wasm targets","datePublished":"2020-01-15"},
            {"url":"https://b.com/new","name":"Rust WASM","snippet":"compiling rust to wasm targets","datePublished":"2025-06-01"},
            {"url":"https://c.com/undated","name":"Rust WASM","snippet":"compiling rust to wasm targets"}
        ]"#;
        let out = process_results("rust wasm after:2024", 1_760_000_000_000.0, raw);
        assert!(!out.contains("a.com"), "2020 doc should be dropped by after:2024");
        let b_pos = out.find("b.com").unwrap();
        let c_pos = out.find("c.com").unwrap();
        assert!(b_pos < c_pos, "dated doc should outrank the undated one under after:");
    }

    #[test]
    fn clickbait_and_blocked_pages_lose() {
        let raw = r#"[
            {"url":"https://spam.example.com/x","name":"BEST FREE Rust WASM Tutorial EVER!!!","snippet":"Click here NOW for the best rust wasm tips!!"},
            {"url":"https://walled.example.net/y","name":"Rust WASM Guide","snippet":"Please enable JavaScript to view this page. Checking your browser before access."},
            {"url":"https://good.example.org/z","name":"Rust WASM Tutorial — A Complete Guide","snippet":"A complete walkthrough of compiling Rust to WebAssembly targets, covering wasm-bindgen and the wasm32 toolchain in detail."}
        ]"#;
        let out = process_results("rust wasm tutorial", 1_760_000_000_000.0, raw);
        let good = out.find("good.example.org").unwrap();
        let spam = out.find("spam.example.com").unwrap();
        let walled = out.find("walled.example.net").unwrap();
        assert!(good < spam && good < walled, "clean page should beat clickbait and block pages");
    }

    #[test]
    fn cred_flags_mark_trusted_sources() {
        let raw = r#"[
            {"url":"https://blog.example.net/1","name":"GitHub blog post","snippet":"writing about github features"},
            {"url":"https://github.com/","name":"GitHub","snippet":"github is where people build software"},
            {"url":"https://nasa.gov/space","name":"NASA on collaboration","snippet":"github used for mission software"},
            {"url":"https://alice.github.io/gh","name":"My github notes","snippet":"things I learned about github"},
            {"url":"https://best-github-hacks-2026.example.com/x","name":"GitHub hacks","snippet":"github tricks and tips"}
        ]"#;
        let out = process_results("github", 1_760_000_000_000.0, raw);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let results = v["results"].as_array().unwrap();
        let find = |host: &str| results.iter().find(|r| r["host"] == host).unwrap();
        assert_eq!(find("github.com")["cred"], "official");
        assert_eq!(find("nasa.gov")["cred"], "vetted");
        // "github" inside a hyphen-chain or a user-space subdomain is not
        // the entity's own host — a badge must never overclaim.
        assert!(find("blog.example.net")["cred"].is_null());
        assert!(find("alice.github.io")["cred"].is_null());
        assert!(find("best-github-hacks-2026.example.com")["cred"].is_null());
    }

    #[test]
    fn adjacent_terms_outrank_scattered() {
        // "memory safety" adjacent beats "memory" and "safety" far apart.
        let raw = r#"[
            {"url":"https://a.com/1","name":"Memory layout tips","snippet":"memory layout. Forty lines of unrelated detail. The safety checklist follows much later."},
            {"url":"https://b.com/2","name":"Memory safety in Rust","snippet":"memory safety without garbage collection"}
        ]"#;
        let out = process_results("rust memory safety", 1_760_000_000_000.0, raw);
        let b_pos = out.find("b.com").unwrap();
        let a_pos = out.find("a.com").unwrap();
        assert!(b_pos < a_pos, "adjacent terms should outrank scattered ones");
    }
}
