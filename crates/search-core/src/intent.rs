//! Query intent classification. Drives which ranking signals dominate.

use std::collections::HashSet;

/// What the query is trying to do.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Intent {
    Navigate, // wants a specific site/page: "github", "docs", "download", "login"
    Learn,    // wants explanation: "how to", "what is", "vs", "tutorial"
    Fresh,    // wants recency: "latest", "news", "today"
    General,
}

impl Intent {
    pub fn label(self) -> &'static str {
        match self {
            Intent::Navigate => "navigate",
            Intent::Learn => "learn",
            Intent::Fresh => "fresh",
            Intent::General => "general",
        }
    }
}

const NAVIGATE_MARKERS: &[&str] = &[
    "login", "signin", "sign in", "official", "site", "website", "homepage", "home page",
    "download", "install", "pricing", "docs", "documentation", "github", "changelog",
    "console", "dashboard", "portal",
];
const LEARN_MARKERS: &[&str] = &[
    "how to", "how do", "what is", "what are", "why", "vs", "versus", "tutorial",
    "guide", "example", "examples", "explained", "compare", "difference", "best way",
    "meaning", "definition",
];
const FRESH_MARKERS: &[&str] = &[
    "today", "tonight", "breaking", "latest", "news", "recent", "recently",
    "this week", "this month", "this year", "weekly", "monthly", "announced",
    "release notes", "update", "updates",
];

/// Classify a query into an intent bucket.
///
/// Single-word markers require a whole-word match (so "vs" doesn't hit
/// "versus" inside another word); multi-word markers use substring match.
pub fn classify(query: &str) -> Intent {
    let q = query.to_lowercase();
    let words: HashSet<&str> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    let hit = |markers: &[&str]| {
        markers
            .iter()
            .any(|m| if m.contains(' ') { q.contains(m) } else { words.contains(m) })
    };
    if hit(FRESH_MARKERS) {
        Intent::Fresh
    } else if hit(NAVIGATE_MARKERS) {
        Intent::Navigate
    } else if hit(LEARN_MARKERS) {
        Intent::Learn
    } else {
        Intent::General
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_intent() {
        assert_eq!(classify("how to deploy workers"), Intent::Learn);
        assert_eq!(classify("github login"), Intent::Navigate);
        assert_eq!(classify("latest rust release"), Intent::Fresh);
        assert_eq!(classify("tokio runtime"), Intent::General);
    }
}
