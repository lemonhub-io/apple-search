//! Text normalization and tokenization.

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
