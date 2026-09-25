//! URL helpers: host extraction, dedupe keys, display forms.

use crate::text::truncate_chars;

const DISPLAY_LIMIT: usize = 72;

/// Hostname without scheme, path, or a leading "www.".
pub fn host_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split('/').next().unwrap_or(rest);
    host.trim_start_matches("www.").to_lowercase()
}

/// Canonical key for URL dedupe: scheme/www/trailing-slash/fragment-insensitive.
pub fn dedupe_key(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.trim_start_matches("www.")
        .trim_end_matches('/')
        .split('#')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

/// Does `host` match a filter domain (exact or subdomain)?
pub fn host_matches(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// Breadcrumb-style display form of a URL (scheme stripped, capped).
pub fn display_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    truncate_chars(rest.trim_end_matches('/'), DISPLAY_LIMIT)
}
