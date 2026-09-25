//! Search result post-processing engine compiled to WebAssembly.
//!
//! Pipeline: parse → dedupe/normalize → intent classify → BM25 rerank with
//! intent-conditioned boosts → highlight → serialize.

mod date;
mod highlight;
mod intent;
mod model;
mod rank;
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
    let terms = text::query_terms(query);
    let intent = intent::classify(query);
    let raw_results: Vec<RawResult> = serde_json::from_str(raw).unwrap_or_default();
    let docs = model::collect_docs(raw_results);

    let scored = rank::score_all(docs, &terms, query, intent, now_ms);

    let results = scored
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(_, score, d)| UiResult {
            title: highlight::mark_segments(&text::truncate_chars(&d.title, TITLE_LIMIT), &terms),
            id: d.id,
            display: d.display.unwrap_or_else(|| url::display_of(&d.url)),
            snippet: highlight::mark_segments(
                &text::truncate_chars(&d.body, SNIPPET_LIMIT),
                &terms,
            ),
            date: d.date_raw.as_deref().and_then(|v| date::label(now_ms, v)),
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
