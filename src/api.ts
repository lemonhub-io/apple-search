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

export const SEARCH_COUNT = 30;

/// Fetch one search page. `freshness === "auto"` omits the parameter so the
/// worker can infer a window from recency markers in the query.
export async function fetchSearch(query: string, freshness: string): Promise<SearchResponse> {
  const f = freshness === "auto" ? "" : `&freshness=${freshness}`;
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}${f}&count=${SEARCH_COUNT}`);
  const data = (await res.json().catch(() => null)) as (Partial<SearchResponse> & ApiError) | null;
  if (!res.ok || !data) {
    throw new Error(data?.error || "Couldn’t complete the search.");
  }
  return data as SearchResponse;
}
