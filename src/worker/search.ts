// GET /api/search — validate, edge-cache, call upstream, rescue starved
// queries, and shape the response contract the frontend consumes.

import type { SearchResponse } from "../api";
import type { Env } from "./env";
import { json } from "./http";
import { callUpstream, type LangSearchResult, type SearchOptions } from "./langsearch";
import { FRESHNESS, inferFreshness, normalizeUrl, parseQuery, simplifyQuery } from "./query";

const CACHE_TTL = 300; // seconds
const MAX_COUNT = 50;
const DEFAULT_COUNT = 50; // upstream max — more candidates = better rerank input
const STARVED_BELOW = 8; // fan out a simplified query under this many results
const WIDEN_BELOW = 5;   // widen a narrowed freshness window under this many

export async function handleSearch(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = (url.searchParams.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (!raw) {
    return json({ error: "Missing query parameter `q`." }, { status: 400 });
  }
  if (!env.LANGSEARCH_API_KEY) {
    return json({ error: "Search backend is not configured (missing LANGSEARCH_API_KEY)." }, { status: 503 });
  }

  // Operators (site:, -site:, "phrase", -term) are parsed out before the
  // upstream call; the client-side engine re-applies them during ranking.
  const parsed = parseQuery(raw);
  const query = parsed.upstream;

  // Absent or unrecognized freshness → infer from recency markers in the query.
  const freshParam = url.searchParams.get("freshness");
  const freshness = freshParam && FRESHNESS.has(freshParam) ? freshParam : inferFreshness(query);
  const countParam = Number(url.searchParams.get("count") ?? String(DEFAULT_COUNT));
  const count = Number.isFinite(countParam)
    ? Math.min(Math.max(Math.trunc(countParam), 1), MAX_COUNT)
    : DEFAULT_COUNT;

  // Canonical cache key so identical searches share one edge-cached entry.
  const cacheKey = new Request(
    `${url.origin}/api/search?q=${encodeURIComponent(raw)}&f=${freshness}&n=${count}`,
  );
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-cache", "HIT");
    return res;
  }

  const domains: Pick<SearchOptions, "includeDomains" | "excludeDomains"> = {
    includeDomains: parsed.includeDomains,
    excludeDomains: parsed.excludeDomains,
  };

  const started = Date.now();
  let payload = await callUpstream(env, query, { count, freshness, retry: true, ...domains });
  if (payload instanceof Response) {
    return payload;
  }

  let value = payload.data?.webPages?.value ?? [];
  let effectiveFreshness = freshness;
  let expanded = false;

  // Query rescue — a narrow freshness window and LangSearch's thin index are
  // independent problems, so the widen retry and the simplified fallback fan
  // out in parallel instead of chaining two upstream waits.
  const needWiden = freshness !== "noLimit" && value.length < WIDEN_BELOW;
  const alt = value.length < STARVED_BELOW ? simplifyQuery(query) : null;
  if (needWiden || alt) {
    const [widened, extra] = await Promise.all([
      needWiden
        ? callUpstream(env, query, { count, freshness: "noLimit", ...domains })
        : null,
      alt
        ? callUpstream(env, alt, { count, freshness: "noLimit", ...domains })
        : null,
    ]);

    // A narrow freshness window can starve the query — widen and retry once.
    if (widened && !(widened instanceof Response)) {
      const v = widened.data?.webPages?.value ?? [];
      if (v.length > value.length) {
        payload = widened;
        value = v;
        effectiveFreshness = "noLimit";
      }
    }

    // A starved query fans out once with a simplified variant; merge unique
    // results into whatever the first pass (or the widen) produced.
    if (extra && !(extra instanceof Response)) {
      const have = new Set(value.map((r) => normalizeUrl(r.url)));
      let added = 0;
      for (const r of extra.data?.webPages?.value ?? []) {
        if (have.add(normalizeUrl(r.url))) {
          value.push(r);
          added++;
        }
      }
      expanded = added > 0;
    }
  }

  const body: SearchResponse = {
    query: payload.data?.queryContext?.originalQuery ?? query,
    freshness: effectiveFreshness,
    freshness_requested: freshness,
    expanded,
    candidates: value.length,
    results: value.map(toApiResult),
    usage: payload.usage ?? null,
    took_ms: Date.now() - started,
  };

  const res = json(body, {
    headers: { "cache-control": `public, max-age=${CACHE_TTL}`, "x-cache": "MISS" },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function toApiResult(r: LangSearchResult, i: number) {
  return {
    id: r.id ?? `r${i}`,
    name: r.name ?? null,
    url: r.url,
    displayUrl: r.displayUrl ?? null,
    snippet: r.snippet ?? null,
    summary: r.summary ?? null,
    datePublished: r.datePublished ?? null,
  };
}
