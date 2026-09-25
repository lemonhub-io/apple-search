interface Env {
  ASSETS: Fetcher;
  LANGSEARCH_API_KEY?: string;
}

const UPSTREAM = "https://api.langsearch.com/v1/web-search";
const CACHE_TTL = 300; // seconds
const FRESHNESS = new Set(["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"]);

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/search") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return handleSearch(url, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleSearch(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
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
  const countParam = Number(url.searchParams.get("count") ?? "30");
  const count = Number.isFinite(countParam) ? Math.min(Math.max(Math.trunc(countParam), 1), 50) : 30;

  // Canonical cache key so identical searches share one edge-cached entry.
  const cacheKey = new Request(`${url.origin}/api/search?q=${encodeURIComponent(query)}&f=${freshness}&n=${count}`);
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
  if (freshness !== "noLimit" && value.length < 5) {
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

  const tookMs = Date.now() - started;
  const body = {
    query: payload.data?.queryContext?.originalQuery ?? query,
    freshness: effectiveFreshness,
    freshness_requested: freshness,
    candidates: value.length,
    results: value.map((r, i) => ({
      id: r.id ?? `r${i}`,
      name: r.name ?? null,
      url: r.url,
      displayUrl: r.displayUrl ?? null,
      snippet: r.snippet ?? null,
      summary: r.summary ?? null,
      datePublished: r.datePublished ?? null,
    })),
    usage: payload.usage ?? null,
    took_ms: tookMs,
  };

  const res = json(body, {
    headers: { "cache-control": `public, max-age=${CACHE_TTL}`, "x-cache": "MISS" },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/// Single upstream call. Returns the parsed payload, or an error Response
/// ready to send to the client.
async function callUpstream(
  env: Env,
  query: string,
  count: number,
  freshness: string,
): Promise<LangSearchResponse | Response> {
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.LANGSEARCH_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, count, freshness, summary: true }),
      signal: AbortSignal.timeout(9000),
    });
  } catch {
    return json({ error: "Search provider timed out. Please try again." }, { status: 504 });
  }

  const payload = (await upstream.json().catch(() => null)) as LangSearchResponse | null;
  if (!upstream.ok || !payload || payload.code !== 200 || !payload.data) {
    const message = payload?.msg ?? payload?.message ?? `Upstream error (HTTP ${upstream.status}).`;
    return json({ error: message }, { status: upstream.status === 429 ? 429 : 502 });
  }
  return payload;
}

/// Map recency language to a LangSearch freshness window.
function inferFreshness(query: string): string {
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

interface LangSearchResult {
  id?: string;
  name?: string;
  url: string;
  displayUrl?: string;
  snippet?: string;
  summary?: string;
  datePublished?: string;
}

interface LangSearchResponse {
  code: number;
  msg?: string | null;
  message?: string | null;
  data?: {
    queryContext?: { originalQuery?: string };
    webPages?: { value?: LangSearchResult[] };
  };
  usage?: { input_tokens: number; output_tokens: number };
}
