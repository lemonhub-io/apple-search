// LangSearch Web Search API client.

import { json } from "./http";
import type { Env } from "./env";

const UPSTREAM = "https://api.langsearch.com/v1/web-search";
const TIMEOUT_MS = 9000;

export interface LangSearchResult {
  id?: string;
  name?: string;
  url: string;
  displayUrl?: string;
  snippet?: string;
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

/// Single upstream call. Returns the parsed payload, or an error Response
/// ready to send to the client.
export async function callUpstream(
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
