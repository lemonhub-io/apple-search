import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { cleanQuery, processResults, type UiResult } from "./engine";

type Phase = "idle" | "loading" | "done" | "error";
type Theme = "light" | "dark";

interface Meta {
  count: number;
  tookMs: number;
  procMs: number;
  engine: "wasm" | "js";
  cached: boolean;
  query: string;
}

const FRESHNESS = [
  { id: "noLimit", label: "Any time" },
  { id: "oneDay", label: "Past day" },
  { id: "oneWeek", label: "Past week" },
  { id: "oneMonth", label: "Past month" },
  { id: "oneYear", label: "Past year" },
] as const;

const SUGGESTIONS = ["Cloudflare Workers", "WebAssembly", "LangSearch API", "Apple Human Interface"];

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<UiResult[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<string>("noLimit");
  const [theme, setTheme] = useState<Theme>(systemTheme);

  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const manualTheme = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const runSearch = useCallback(
    async (raw: string, fresh: string, push = true) => {
      const q = cleanQuery(raw);
      if (!q) return;
      const my = ++seq.current;
      setPhase("loading");
      setError(null);
      setFreshness(fresh);
      setInput(q);
      if (push) {
        const u = new URL(location.href);
        u.search = `?q=${encodeURIComponent(q)}`;
        history.pushState(null, "", u);
      }
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&freshness=${fresh}&count=10`);
        const data = (await res.json()) as {
          error?: string;
          query?: string;
          results?: Parameters<typeof processResults>[1];
          took_ms?: number;
        };
        if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status}).`);
        const processed = await processResults(data.query ?? q, data.results ?? []);
        if (my !== seq.current) return;
        setResults(processed.results);
        setMeta({
          count: processed.results.length,
          tookMs: data.took_ms ?? 0,
          procMs: processed.ms,
          engine: processed.engine,
          cached: res.headers.get("x-cache") === "HIT",
          query: data.query ?? q,
        });
        setPhase("done");
      } catch (e) {
        if (my !== seq.current) return;
        setResults([]);
        setError(e instanceof Error ? e.message : "Something went wrong.");
        setPhase("error");
      }
    },
    [],
  );

  // Deep link on first load.
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("q");
    if (q) void runSearch(q, "noLimit", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward navigation re-runs the query from the URL.
  useEffect(() => {
    const onPop = () => {
      const pq = new URLSearchParams(location.search).get("q");
      if (pq) void runSearch(pq, freshness, false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [freshness, runSearch]);

  // Follow OS theme changes until the user picks one explicitly.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (!manualTheme.current) setTheme(systemTheme());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // "/" focuses the field, Escape clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Escape" && document.activeElement === inputRef.current) {
        setInput("");
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const compact = phase !== "idle";

  return (
    <div className="page">
      <header className="nav">
        <span className="wordmark">
          <MagIcon className="wordmark-icon" />
          Search
        </span>
        <button
          className="theme-btn"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => {
            manualTheme.current = true;
            setTheme(theme === "dark" ? "light" : "dark");
          }}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>

      <main className="main">
        <div className={`hero-wrap${compact ? " collapsed" : ""}`}>
          <div className="hero">
            <h1 className="headline">Search the web.</h1>
            <p className="sub">
              LangSearch results, processed by Rust WebAssembly, delivered from the Cloudflare edge.
            </p>
          </div>
        </div>

        <form
          className="box"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(input, freshness);
          }}
        >
          <MagIcon className="box-icon" />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            aria-label="Search query"
            autoFocus
          />
          {input ? (
            <button type="button" className="clear" aria-label="Clear" onClick={() => setInput("")}>
              <ClearIcon />
            </button>
          ) : (
            <kbd className="kbd">/</kbd>
          )}
        </form>

        {phase === "idle" && (
          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" onClick={() => void runSearch(s, "noLimit")}>
                {s}
              </button>
            ))}
          </div>
        )}

        {phase === "loading" && (
          <ol className="rlist skeleton" aria-label="Loading results">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} style={{ "--i": i } as CSSProperties}>
                <div className="sk sk-site" />
                <div className="sk sk-title" />
                <div className="sk sk-line" />
                <div className="sk sk-line short" />
              </li>
            ))}
          </ol>
        )}

        {phase === "error" && (
          <div className="notice" role="alert">
            <p className="notice-title">Couldn’t complete the search.</p>
            <p className="notice-body">{error}</p>
          </div>
        )}

        {phase === "done" && meta && (
          <section className="results-zone">
            <div className="rmeta">
              <span className="rmeta-left">
                {meta.count} result{meta.count === 1 ? "" : "s"} · {(meta.tookMs + meta.procMs).toFixed(0)} ms
                {meta.cached ? " · cached" : ""} · engine {meta.engine === "wasm" ? "Rust/WASM" : "JS"}
              </span>
              <nav className="fresh" aria-label="Filter by date">
                {FRESHNESS.map((f) => (
                  <button
                    key={f.id}
                    className={`fresh-link${freshness === f.id ? " active" : ""}`}
                    onClick={() => void runSearch(meta.query, f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </nav>
            </div>

            {results.length === 0 ? (
              <div className="notice">
                <p className="notice-title">No results for “{meta.query}”.</p>
                <p className="notice-body">Try different keywords or a broader time range.</p>
              </div>
            ) : (
              <ol className="rlist">
                {results.map((r, i) => (
                  <li key={`${r.id}-${i}`} style={{ "--i": i } as CSSProperties}>
                    <div className="r-site">
                      <span className="r-badge" aria-hidden>
                        {r.host.charAt(0).toUpperCase()}
                      </span>
                      <span className="r-crumb">
                        <span className="r-display">{r.display}</span>
                        {r.date && <span className="r-date">{r.date}</span>}
                      </span>
                    </div>
                    <a className="r-title" href={r.url} target="_blank" rel="noopener noreferrer">
                      {r.title.map((s, j) =>
                        s.mark ? <mark key={j}>{s.text}</mark> : <span key={j}>{s.text}</span>,
                      )}
                    </a>
                    <p className="r-snippet">
                      {r.snippet.map((s, j) =>
                        s.mark ? <mark key={j}>{s.text}</mark> : <span key={j}>{s.text}</span>,
                      )}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </main>

      <footer className="foot">
        <span>Rust → WebAssembly · LangSearch API · Cloudflare Workers</span>
        <span className="foot-right">Monochrome edition</span>
      </footer>
    </div>
  );
}

function MagIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="6.2" stroke="currentColor" strokeWidth="1.8" />
      <line x1="13.6" y1="13.6" x2="18" y2="18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <path d="M5.5 5.5l5 5m0-5l-5 5" stroke="var(--bg)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M16.5 12.2A7.3 7.3 0 0 1 7.8 3.5 7.3 7.3 0 1 0 16.5 12.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
