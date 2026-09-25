import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSearch } from "../api";
import { cleanQuery, processResults, type UiResult } from "../engine";
import { queryFromLocation } from "../lib/platform";

export type Phase = "idle" | "loading" | "done" | "error";

export interface SearchMeta {
  count: number;
  candidates: number;
  ms: number;
  intent: string;
  freshness: string;
  widened: boolean;
  expanded: boolean;
  query: string;
}

export interface SearchState {
  input: string;
  setInput: (v: string) => void;
  phase: Phase;
  results: UiResult[];
  meta: SearchMeta | null;
  error: string | null;
  freshness: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  runSearch: (raw: string, fresh: string, push?: boolean) => Promise<void>;
}

/// Search state machine: input, request lifecycle, deep links, history
/// navigation, and retry-on-reconnect for searches that ran while offline.
export function useSearch(online: boolean): SearchState {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<UiResult[]>([]);
  const [meta, setMeta] = useState<SearchMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freshness, setFreshness] = useState("auto");

  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const pendingRetry = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const runSearch = useCallback(async (raw: string, fresh: string, push = true) => {
    const q = cleanQuery(raw);
    if (!q) return;
    const my = ++seq.current;
    // A newer search supersedes — kill the previous request outright
    // instead of letting it drain bandwidth in the background.
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setPhase("loading");
    setError(null);
    setFreshness(fresh);
    setInput(q);
    if (push) {
      const u = new URL(location.href);
      u.search = `?q=${encodeURIComponent(q)}`;
      history.pushState(null, "", u);
    }
    if (!navigator.onLine) {
      pendingRetry.current = q;
      setResults([]);
      setError("You’re offline. The app stays available — search needs a connection.");
      setPhase("error");
      return;
    }
    try {
      const data = await fetchSearch(q, fresh, ctrl.signal);
      // The engine re-parses the raw query itself — operators like
      // site: / -term / "phrase" still apply during ranking.
      const processed = await processResults(q, data.results ?? []);
      if (my !== seq.current) return;
      pendingRetry.current = null;
      setResults(processed.results);
      setMeta({
        count: processed.results.length,
        candidates: data.candidates ?? processed.results.length,
        ms: (data.took_ms ?? 0) + processed.ms,
        intent: processed.intent,
        freshness: data.freshness ?? "noLimit",
        widened: !!data.freshness_requested && data.freshness_requested !== data.freshness,
        expanded: !!data.expanded,
        // The raw query — not data.query (the operator-stripped upstream
        // form): re-running it must preserve site:/-term/"phrase" semantics.
        query: q,
      });
      setPhase("done");
    } catch (e) {
      if (my !== seq.current) return;
      if (!navigator.onLine) pendingRetry.current = q;
      setResults([]);
      setError(e instanceof Error && e.message ? e.message : "Couldn’t complete the search.");
      setPhase("error");
    }
  }, []);

  // Deep link on first load — "auto" so the worker can infer freshness
  // from recency language in the query, same as a typed search.
  useEffect(() => {
    const q = queryFromLocation();
    if (q) void runSearch(q, "auto", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kill the in-flight request if the app unmounts.
  useEffect(() => () => inFlight.current?.abort(), []);

  // Back/forward navigation re-runs the query from the URL.
  useEffect(() => {
    const onPop = () => {
      const pq = queryFromLocation();
      if (pq) void runSearch(pq, freshness, false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [freshness, runSearch]);

  // A search that failed while offline retries when connectivity returns.
  useEffect(() => {
    if (online && pendingRetry.current) {
      const q = pendingRetry.current;
      pendingRetry.current = null;
      void runSearch(q, freshness);
    }
  }, [online, freshness, runSearch]);

  return { input, setInput, phase, results, meta, error, freshness, inputRef, runSearch };
}
