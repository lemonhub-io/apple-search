//! Text normalization, tokenization, and query-operator parsing.

/// Normalize a raw query string: collapse whitespace, cap length.
pub fn clean(input: &str) -> String {
    let joined = input.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(300).collect()
}

/// Lowercase-ish word tokens (caller lowercases input).
pub fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Distinct query terms, longest-first so multi-char terms win in highlighting.
pub fn query_terms(query: &str) -> Vec<String> {
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

/// Truncate at `max` chars, appending an ellipsis when cut.
pub fn truncate_chars(s: &str, max: usize) -> String {
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

/// A query decomposed into operators and plain terms.
///
///   site:example.com   → include_hosts
///   -site:example.com  → exclude_hosts
///   "exact phrase"     → phrases (exact-containment boost)
///   -term              → excluded (docs containing it are dropped)
pub struct Parsed {
    /// Query text with operators stripped — input for intent classify and
    /// the whole-query phrase bonus.
    pub base: String,
    /// BM25 + highlighting terms.
    pub terms: Vec<String>,
    pub phrases: Vec<String>,
    pub excluded: Vec<String>,
    pub include_hosts: Vec<String>,
    pub exclude_hosts: Vec<String>,
}

/// Parse the raw user query into terms + operators. The worker strips the
/// same operators before calling upstream, but the engine re-parses the raw
/// query so phrase and exclusion semantics still apply during ranking.
pub fn parse_query(raw: &str) -> Parsed {
    let mut phrases: Vec<String> = Vec::new();
    let mut excluded: Vec<String> = Vec::new();
    let mut include_hosts: Vec<String> = Vec::new();
    let mut exclude_hosts: Vec<String> = Vec::new();
    let mut base_parts: Vec<&str> = Vec::new();

    let chunks: Vec<&str> = raw.split('"').collect();
    for (i, chunk) in chunks.iter().enumerate() {
        // Odd-index chunks are quoted — but only when a closing quote exists
        // (i.e. the chunk isn't last).
        if i % 2 == 1 && i + 1 < chunks.len() {
            let ph = chunk.trim().to_lowercase();
            if !ph.is_empty() {
                phrases.push(ph);
            }
            continue;
        }
        for tok in chunk.split_whitespace() {
            let (neg, bare) = match tok.strip_prefix('-') {
                Some(rest) if !rest.is_empty() => (true, rest),
                _ => (false, tok),
            };
            let bare_l = bare.to_lowercase();
            if let Some(domain) = bare_l.strip_prefix("site:") {
                let domain = domain.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-');
                if domain.contains('.')
                    && domain
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
                {
                    if neg {
                        exclude_hosts.push(domain.to_string());
                    } else {
                        include_hosts.push(domain.to_string());
                    }
                    continue;
                }
            }
            if neg {
                let t = bare_l.trim_matches(|c: char| !c.is_alphanumeric()).to_string();
                if t.chars().count() >= 2 {
                    excluded.push(t);
                }
            } else {
                base_parts.push(tok);
            }
        }
    }

    let base = base_parts.join(" ");
    Parsed {
        terms: query_terms(&base),
        base,
        phrases,
        excluded,
        include_hosts,
        exclude_hosts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_operators() {
        let p = parse_query(r#"rust workers site:github.com -site:reddit.com "edge compute" -game"#);
        assert_eq!(p.base, "rust workers");
        assert_eq!(p.include_hosts, vec!["github.com"]);
        assert_eq!(p.exclude_hosts, vec!["reddit.com"]);
        assert_eq!(p.phrases, vec!["edge compute"]);
        assert_eq!(p.excluded, vec!["game"]);
        assert!(p.terms.contains(&"rust".to_string()));
        assert!(!p.terms.contains(&"site".to_string()));
        assert!(!p.terms.contains(&"github".to_string()));
    }

    #[test]
    fn unbalanced_quote_is_plain_text() {
        // A dangling quote doesn't form a phrase; its text stays in the query.
        let p = parse_query(r#"rust "wasm"#);
        assert_eq!(p.base, "rust wasm");
        assert!(p.phrases.is_empty());
    }
}
