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

  const freshParam = url.searchParams.get("freshness") ?? "noLimit";
  const freshness = FRESHNESS.has(freshParam) ? freshParam : "noLimit";
  const countParam = Number(url.searchParams.get("count") ?? "10");
  const count = Number.isFinite(countParam) ? Math.min(Math.max(Math.trunc(countParam), 1), 10) : 10;

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
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.LANGSEARCH_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, count, freshness }),
      signal: AbortSignal.timeout(9000),
    });
  } catch {
    return json({ error: "Search provider timed out. Please try again." }, { status: 504 });
  }

  const tookMs = Date.now() - started;
  const payload = (await upstream.json().catch(() => null)) as LangSearchResponse | null;

  if (!upstream.ok || !payload || payload.code !== 200 || !payload.data) {
    const message = payload?.msg ?? payload?.message ?? `Upstream error (HTTP ${upstream.status}).`;
    return json({ error: message }, { status: upstream.status === 429 ? 429 : 502 });
  }

  const value = payload.data.webPages?.value ?? [];
  const body = {
    query: payload.data.queryContext?.originalQuery ?? query,
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
