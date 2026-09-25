// Pure query-understanding helpers — no I/O, trivially testable.

export const FRESHNESS = new Set(["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"]);

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}$/;
// Operators the engine applies locally. Their operands still aid upstream
// recall ("wasm inurl:tutorial" → "wasm tutorial"), but the `op:` token
// itself is harmful — the index would treat it as literal text.
const OP_RE = /^(inurl|intitle|after|before):(\S{2,})$/;

export interface ParsedQuery {
  /** Query sent to LangSearch: operators removed, quotes unwrapped. */
  upstream: string;
  includeDomains: string[];
  excludeDomains: string[];
}

/// Extract search operators from raw input.
///
///   site:example.com   → includeDomains
///   -site:example.com  → excludeDomains
///   "exact phrase"     → unwrapped (the engine re-adds phrase weighting)
///   -term              → stripped upstream; the engine excludes locally
///   inurl:/intitle:/after:/before: → stripped upstream; engine filters locally
///
/// The upstream index treats operator syntax as literal text, so removing it
/// improves recall while the engine enforces the semantics client-side.
export function parseQuery(raw: string): ParsedQuery {
  const includeDomains: string[] = [];
  const excludeDomains: string[] = [];
  const terms: string[] = [];

  // Walk "..."-delimited chunks: odd indices are quoted phrases.
  const chunks = raw.split('"');
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isQuoted = i % 2 === 1 && i < chunks.length - 1; // balanced quotes only
    if (isQuoted) {
      if (chunk.trim()) terms.push(chunk.trim());
      continue;
    }
    for (const tok of chunk.split(/\s+/)) {
      if (!tok) continue;
      const neg = tok.startsWith("-");
      const bare = neg ? tok.slice(1) : tok;
      if (bare.toLowerCase().startsWith("site:")) {
        const domain = bare.slice(5).toLowerCase();
        if (DOMAIN_RE.test(domain)) {
          (neg ? excludeDomains : includeDomains).push(domain);
        } else {
          terms.push(tok); // not a domain — keep as plain text
        }
      } else if (neg && bare.length > 0) {
        continue; // -term: engine excludes these docs locally
      } else {
        // inurl:/intitle:/after:/before: — the engine filters locally;
        // upstream gets just the operand, which biases recall toward the
        // field/date constraint.
        const op = bare.match(OP_RE);
        terms.push(op ? op[2] : tok);
      }
    }
  }

  const upstream = terms.join(" ").trim();
  return {
    // Bare `site:` queries fall back to the domain itself as the query text.
    upstream: upstream.length >= 2 ? upstream : (includeDomains[0] ?? raw.trim()),
    includeDomains: [...new Set(includeDomains)].slice(0, 10),
    excludeDomains: [...new Set(excludeDomains)].slice(0, 10),
  };
}

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
