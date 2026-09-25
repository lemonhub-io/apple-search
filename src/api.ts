// Shared contract between the Worker (writes it) and the frontend (reads it).

export interface ApiResult {
  id: string | null;
  name: string | null;
  url: string;
  displayUrl: string | null;
  snippet: string | null;
  summary: string | null;
  datePublished: string | null;
}

export interface SearchResponse {
  query: string;
  /** Freshness window actually used for the result set. */
  freshness: string;
  /** Freshness window originally requested or inferred. */
  freshness_requested: string;
  /** A simplified fallback query contributed extra candidates. */
  expanded: boolean;
  candidates: number;
  results: ApiResult[];
  usage: { input_tokens: number; output_tokens: number } | null;
  took_ms: number;
}

export interface ApiError {
  error: string;
}

export const SEARCH_COUNT = 50;
// Must outlast the worker's worst case: 9s upstream timeout × (retry +
// widen + expand rescue calls) plus engine time.
const TIMEOUT_MS = 35_000;

/// Fetch one search page. `freshness === "auto"` omits the parameter so the
/// worker can infer a window from recency markers in the query. Aborts when
/// `signal` fires (a newer search superseded this one) or after TIMEOUT_MS.
export async function fetchSearch(
  query: string,
  freshness: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const f = freshness === "auto" ? "" : `&freshness=${freshness}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(
      `/api/search?q=${encodeURIComponent(query)}${f}&count=${SEARCH_COUNT}`,
      { signal: ctrl.signal },
    );
    const data = (await res.json().catch(() => null)) as
      | (Partial<SearchResponse> & ApiError)
      | null;
    if (!res.ok || !data) {
      throw new Error(data?.error || "Couldn’t complete the search.");
    }
    return data as SearchResponse;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
