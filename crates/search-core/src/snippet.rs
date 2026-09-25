//! Display-snippet selection: upstream snippets are often raw DOM dumps —
//! navigation chrome, list fragments, template text. Pick the most
//! query-relevant sentences instead of showing the head of the blob.

use crate::text::truncate_chars;

/// Sentence-ending punctuation, including CJK full-width forms.
const SENTENCE_END: [char; 6] = ['.', '!', '?', '。', '！', '？'];

/// Choose the display excerpt from a doc body.
///
/// Scores each sentence by unique query-term coverage, penalizes fragmentary
/// navigation boilerplate, then returns the best sentence extended forward
/// until `limit` — a coherent passage, not keyword soup.
pub fn best_snippet(body: &str, terms: &[String], limit: usize) -> String {
    let body = body.trim();
    if body.is_empty() {
        return String::new();
    }

    let sentences = split_sentences(body);
    if sentences.is_empty() {
        return truncate_chars(body, limit);
    }

    // Best-scoring sentence, earliest on ties.
    let mut best = 0usize;
    let mut best_score = f64::MIN;
    for (i, s) in sentences.iter().enumerate() {
        let sc = sentence_score(s, terms) + 0.05 * (1.0 - i as f64 / sentences.len() as f64);
        if sc > best_score {
            best_score = sc;
            best = i;
        }
    }

    // Extend forward with following sentences while they fit — the excerpt
    // reads like a coherent passage, preserving the source's own order.
    let mut out = sentences[best].to_string();
    for s in &sentences[best + 1..] {
        let candidate_len = out.chars().count() + 1 + s.chars().count();
        if candidate_len > limit || s.chars().count() < 20 {
            break;
        }
        out.push(' ');
        out.push_str(s);
    }
    truncate_chars(&out, limit)
}

// List/nav separators — DOM dumps join menu items with these instead of
// sentence punctuation, so they must split text for coherence checks too.
const LIST_SEPARATORS: [char; 5] = ['|', '•', '·', '»', '\n'];

/// Split on sentence terminators (kept), then on list separators (dropped);
/// trims junk. Also used by rank.rs for the prose-coherence quality signal.
pub(crate) fn split_sentences(body: &str) -> Vec<&str> {
    body.split_inclusive(SENTENCE_END)
        .flat_map(|s| s.split(LIST_SEPARATORS))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// Score a sentence: unique-term coverage dominates; tiny fragments
/// ("Pinned Discussions", "Sign in") and glue-word soup are penalized.
fn sentence_score(s: &str, terms: &[String]) -> f64 {
    let lower = s.to_lowercase();
    let hits: usize = terms.iter().filter(|t| lower.contains(t.as_str())).count();
    let mut score = hits as f64 * 1.0;

    // Extra weight for repeated term presence (mild tf).
    for t in terms {
        score += lower.matches(t.as_str()).count() as f64 * 0.08;
    }

    let chars = s.chars().count();
    // Nav/menu fragments are short, lowercase-term-free strings; complete
    // explanatory sentences run ~40–220 chars.
    if chars < 30 {
        score *= 0.25;
    } else if chars > 280 {
        score *= 0.85;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_relevant_sentence_over_nav_junk() {
        let body = "Pinned Discussions · Sign in · Explore. \
                    Cloudflare Workers is a serverless platform for running code at the edge. \
                    It deploys in seconds across a global network.";
        let terms = vec!["cloudflare".into(), "workers".into()];
        let out = best_snippet(body, &terms, 320);
        assert!(out.contains("serverless platform"));
        assert!(!out.contains("Pinned Discussions"));
    }

    #[test]
    fn falls_back_for_term_free_bodies() {
        let body = "Nav item one. This is a reasonably long explanatory sentence about the topic. More.";
        let out = best_snippet(body, &["zzz".into()], 320);
        assert!(out.contains("reasonably long explanatory"));
    }
}
