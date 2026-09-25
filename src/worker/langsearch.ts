// LangSearch Web Search API client.
// Contract: https://docs.langsearch.com/api/openapi.json

import { json } from "./http";
import type { Env } from "./env";

const UPSTREAM = "https://api.langsearch.com/v1/web-search";
const TIMEOUT_MS = 9000;
// Transient statuses worth one retry (per LangSearch docs: bounded retries,
// fix invalid requests before retrying — 4xx is never retried).
const RETRYABLE = new Set([500, 502, 503, 504]);

export interface LangSearchResult {
  id?: string;
  name?: string;
  url: string;
  displayUrl?: string;
  snippet?: string;
  text?: string;
  summary?: string;
  datePublished?: string;
}

export interface LangSearchResponse {
  code: number;
  msg?: string | null;
  message?: string | null;
  data?: {
    queryContext?: { originalQuery?: string };
    webPages?: { value?: LangSearchResult[] };
  };
  usage?: { input_tokens: number; output_tokens: number };
}

export interface SearchOptions {
  count: number;
  freshness: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** Retry once on a transient upstream failure (used on the primary call). */
  retry?: boolean;
}

/// Single upstream call. Returns the parsed payload, or an error Response
/// ready to send to the client.
export async function callUpstream(
  env: Env,
  query: string,
  opts: SearchOptions,
): Promise<LangSearchResponse | Response> {
  const body = {
    query,
    count: opts.count,
    freshness: opts.freshness,
    summary: true,
    ...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
    ...(opts.excludeDomains?.length ? { excludeDomains: opts.excludeDomains } : {}),
  };

  const attempts = opts.retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      // Bounded jittered backoff before the single retry.
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 450));
    }
    let upstream: Response;
    try {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.LANGSEARCH_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      if (attempt + 1 < attempts) continue;
      return json({ error: "Search provider timed out. Please try again." }, { status: 504 });
    }

    if (RETRYABLE.has(upstream.status) && attempt + 1 < attempts) continue;

    const payload = (await upstream.json().catch(() => null)) as LangSearchResponse | null;
    if (!upstream.ok || !payload || payload.code !== 200 || !payload.data) {
      if (upstream.status === 429) {
        return json(
          { error: "Search quota exhausted — the daily allowance resets at 00:00 UTC." },
          { status: 429 },
        );
      }
      const message = payload?.msg ?? payload?.message ?? `Upstream error (HTTP ${upstream.status}).`;
      return json({ error: message }, { status: 502 });
    }
    return payload;
  }
  return json({ error: "Search provider unavailable. Please try again." }, { status: 502 });
}
