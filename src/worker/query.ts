//! Pure query-understanding helpers — no I/O, trivially testable.

export const FRESHNESS = new Set(["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"]);

/// Map recency language to a LangSearch freshness window.
export function inferFreshness(query: string): string {
  const q = ` ${query.toLowerCase()} `;
  const has = (...markers: string[]) => markers.some((m) => q.includes(` ${m} `));
  if (has("today", "tonight", "breaking", "right now")) return "oneDay";
  if (has("latest", "news", "recent", "recently", "this week", "weekly", "announced", "update", "updates")) {
    return "oneWeek";
  }
  if (has("this month", "monthly")) return "oneMonth";
  if (has("this year", "annual", "yearly")) return "oneYear";
  return "noLimit";
}

/// Drop recency/navigational filler and stopwords to produce a broader
/// fallback query. Returns null when nothing meaningful remains.
export function simplifyQuery(query: string): string | null {
  const drop = new Set([
    "latest", "news", "recent", "recently", "today", "tonight", "breaking",
    "update", "updates", "weekly", "monthly", "announced",
    "login", "signin", "official", "website", "homepage", "site",
    "this", "the", "a", "an", "of", "for", "in", "on", "to", "and", "or",
    "is", "are", "what", "how", "why",
  ]);
  const alt = query
    .split(/\s+/)
    .filter((w) => !drop.has(w.toLowerCase()))
    .join(" ")
    .trim();
  return alt.length >= 2 && alt.toLowerCase() !== query.toLowerCase() ? alt : null;
}

/// Canonical URL form for cross-query merge dedupe.
export function normalizeUrl(u: string | undefined): string {
  return (u ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "");
}
