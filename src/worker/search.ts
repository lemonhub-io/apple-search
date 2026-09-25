// GET /api/search — validate, edge-cache, call upstream, rescue starved
// queries, and shape the response contract the frontend consumes.

import type { SearchResponse } from "../api";
import type { Env } from "./env";
import { json } from "./http";
import { callUpstream, type LangSearchResult } from "./langsearch";
import { FRESHNESS, inferFreshness, normalizeUrl, simplifyQuery } from "./query";

const CACHE_TTL = 300; // seconds
const MAX_COUNT = 50;
const DEFAULT_COUNT = 30;
const STARVED_BELOW = 8; // fan out a simplified query under this many results
const WIDEN_BELOW = 5;   // widen a narrowed freshness window under this many

export async function handleSearch(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const query = (url.searchParams.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (!query) {
    return json({ error: "Missing query parameter `q`." }, { status: 400 });
  }
  if (!env.LANGSEARCH_API_KEY) {
    return json({ error: "Search backend is not configured (missing LANGSEARCH_API_KEY)." }, { status: 503 });
  }

  // Absent or unrecognized freshness → infer from recency markers in the query.
  const freshParam = url.searchParams.get("freshness");
  const freshness = freshParam && FRESHNESS.has(freshParam) ? freshParam : inferFreshness(query);
  const countParam = Number(url.searchParams.get("count") ?? String(DEFAULT_COUNT));
  const count = Number.isFinite(countParam)
    ? Math.min(Math.max(Math.trunc(countParam), 1), MAX_COUNT)
    : DEFAULT_COUNT;

  // Canonical cache key so identical searches share one edge-cached entry.
  const cacheKey = new Request(
    `${url.origin}/api/search?q=${encodeURIComponent(query)}&f=${freshness}&n=${count}`,
  );
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-cache", "HIT");
    return res;
  }

  const started = Date.now();
  let payload = await callUpstream(env, query, count, freshness);
  if (payload instanceof Response) {
    return payload;
  }

  let value = payload.data?.webPages?.value ?? [];
  let effectiveFreshness = freshness;

  // A narrow freshness window can starve the query — widen and retry once.
  if (freshness !== "noLimit" && value.length < WIDEN_BELOW) {
    const retry = await callUpstream(env, query, count, "noLimit");
    if (!(retry instanceof Response)) {
      const widened = retry.data?.webPages?.value ?? [];
      if (widened.length > value.length) {
        payload = retry;
        value = widened;
        effectiveFreshness = "noLimit";
      }
    }
  }

  // LangSearch's index is thin for some phrasings — when a query starves,
  // fan out once with a simplified variant and merge unique results.
  let expanded = false;
  if (value.length < STARVED_BELOW) {
    const alt = simplifyQuery(query);
    if (alt) {
      const extra = await callUpstream(env, alt, count, "noLimit");
      if (!(extra instanceof Response)) {
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
