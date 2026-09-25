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
///   inurl:term         → in_url (URL must contain it)
///   intitle:term       → in_title (title must contain it)
///   after:YYYY[-MM[-DD]] → date_after (docs dated earlier are dropped)
///   before:YYYY[-MM[-DD]] → date_before
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
    pub in_url: Vec<String>,
    pub in_title: Vec<String>,
    /// ISO-ish date bound ("2024", "2024-06", "2024-06-01") — compared
    /// lexicographically against `datePublished`, so a year prefix matches
    /// any date inside that year.
    pub date_after: Option<String>,
    pub date_before: Option<String>,
}

/// Validate and normalize a `after:`/`before:` operand: YYYY, YYYY-MM, or
/// YYYY-MM-DD. Returns the operand unchanged when it matches.
fn date_bound(s: &str) -> Option<String> {
    let ok_len = matches!(s.len(), 4 | 7 | 10);
    let ok_shape = s
        .split('-')
        .enumerate()
        .all(|(i, p)| p.chars().all(|c| c.is_ascii_digit()) && p.len() == [4, 2, 2][i]);
    if !ok_len || !ok_shape || s.split('-').count() > 3 {
        return None;
    }
    Some(s.to_string())
}

/// Validate an `inurl:`/`intitle:` operand: a word-ish token.
fn field_term(s: &str) -> Option<String> {
    let t = s.trim_matches(|c: char| !c.is_alphanumeric());
    (t.chars().count() >= 2).then(|| t.to_string())
}

/// Parse the raw user query into terms + operators. The worker strips the
/// same operators before calling upstream, but the engine re-parses the raw
/// query so phrase and exclusion semantics still apply during ranking.
pub fn parse_query(raw: &str) -> Parsed {
    let mut phrases: Vec<String> = Vec::new();
    let mut excluded: Vec<String> = Vec::new();
    let mut include_hosts: Vec<String> = Vec::new();
    let mut exclude_hosts: Vec<String> = Vec::new();
    let mut in_url: Vec<String> = Vec::new();
    let mut in_title: Vec<String> = Vec::new();
    let mut date_after: Option<String> = None;
    let mut date_before: Option<String> = None;
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
            if !neg {
                if let Some(v) = bare_l.strip_prefix("inurl:").and_then(field_term) {
                    in_url.push(v);
                    continue;
                }
                if let Some(v) = bare_l.strip_prefix("intitle:").and_then(field_term) {
                    in_title.push(v);
                    continue;
                }
                if let Some(v) = bare_l.strip_prefix("after:").and_then(date_bound) {
                    date_after = Some(v);
                    continue;
                }
                if let Some(v) = bare_l.strip_prefix("before:").and_then(date_bound) {
                    date_before = Some(v);
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
        in_url,
        in_title,
        date_after,
        date_before,
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
    fn parses_field_and_date_ops() {
        let p = parse_query("wasm inurl:tutorial intitle:rust after:2024 before:2025-06");
        assert_eq!(p.base, "wasm");
        assert_eq!(p.in_url, vec!["tutorial"]);
        assert_eq!(p.in_title, vec!["rust"]);
        assert_eq!(p.date_after.as_deref(), Some("2024"));
        assert_eq!(p.date_before.as_deref(), Some("2025-06"));
        // Invalid operands fall through to plain text.
        let p = parse_query("after:tomorrow inurl:x");
        assert_eq!(p.base, "after:tomorrow inurl:x");
        assert!(p.date_after.is_none() && p.in_url.is_empty());
        // Negated field ops are not supported — "-inurl:x" is a plain -term.
        let p = parse_query("rust -inurl:blog");
        assert_eq!(p.excluded, vec!["inurl:blog"]);
    }

    #[test]
    fn unbalanced_quote_is_plain_text() {
        // A dangling quote doesn't form a phrase; its text stays in the query.
        let p = parse_query(r#"rust "wasm"#);
        assert_eq!(p.base, "rust wasm");
        assert!(p.phrases.is_empty());
    }
}
