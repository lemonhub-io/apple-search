import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { cleanQuery, processResults, type UiResult } from "./engine";

type Phase = "idle" | "loading" | "done" | "error";
type Theme = "light" | "dark";

interface Meta {
  count: number;
  ms: number;
  query: string;
}

const FRESHNESS = [
  { id: "noLimit", label: "Any time" },
  { id: "oneDay", label: "Past day" },
  { id: "oneWeek", label: "Past week" },
  { id: "oneMonth", label: "Past month" },
  { id: "oneYear", label: "Past year" },
] as const;

const THEME_KEY = "search-theme";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : systemTheme();
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function queryFromLocation(): string | null {
  const params = new URLSearchParams(location.search);
  return params.get("q") || params.get("url");
}

export default function App() {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<UiResult[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<string>("noLimit");
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);

  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const manualTheme = useRef(localStorage.getItem(THEME_KEY) !== null);
  const pendingRetry = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const color = theme === "dark" ? "#000000" : "#ffffff";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-active]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.dataset.active = "";
      document.head.appendChild(meta);
    }
    meta.content = color;
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
      if (!navigator.onLine) {
        pendingRetry.current = q;
        setResults([]);
        setError("You’re offline. The app stays available — search needs a connection.");
        setPhase("error");
        return;
      }
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&freshness=${fresh}&count=10`);
        let data: {
          error?: string;
          query?: string;
          results?: Parameters<typeof processResults>[1];
          took_ms?: number;
        };
        try {
          data = await res.json();
        } catch {
          throw new Error("Couldn’t complete the search.");
        }
        if (!res.ok) throw new Error(data.error || "Couldn’t complete the search.");
        const processed = await processResults(data.query ?? q, data.results ?? []);
        if (my !== seq.current) return;
        pendingRetry.current = null;
        setResults(processed.results);
        setMeta({
          count: processed.results.length,
          ms: (data.took_ms ?? 0) + processed.ms,
          query: data.query ?? q,
        });
        setPhase("done");
      } catch (e) {
        if (my !== seq.current) return;
        if (!navigator.onLine) pendingRetry.current = q;
        setResults([]);
        setError(e instanceof Error && e.message ? e.message : "Couldn’t complete the search.");
        setPhase("error");
      }
    },
    [],
  );

  // Deep link on first load.
  useEffect(() => {
    const q = queryFromLocation();
    if (q) void runSearch(q, "noLimit", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward navigation re-runs the query from the URL.
  useEffect(() => {
    const onPop = () => {
      const pq = queryFromLocation();
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

  // Track connectivity; auto-retry a search that failed while offline.
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (online && pendingRetry.current) {
      const q = pendingRetry.current;
      pendingRetry.current = null;
      void runSearch(q, freshness);
    }
  }, [online, freshness, runSearch]);

  // Offer install when the browser allows it; hide once installed.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallEvt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!installEvt) return;
    await installEvt.prompt();
    if ((await installEvt.userChoice).outcome === "accepted") setInstallEvt(null);
  };

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
        <div className="nav-side">
          {!online && <span className="off-badge">Offline</span>}
          {!installed && installEvt && (
            <button className="install-btn" onClick={() => void install()}>
              Install
            </button>
          )}
          <button
            className="theme-btn"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => {
              manualTheme.current = true;
              const next = theme === "dark" ? "light" : "dark";
              localStorage.setItem(THEME_KEY, next);
              setTheme(next);
            }}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <main className="main">
        <div className={`hero-wrap${compact ? " collapsed" : ""}`}>
          <div className="hero">
            <h1 className="headline">Search the web.</h1>
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
          <p className="notice" role="alert">
            {error}
          </p>
        )}

        {phase === "done" && meta && (
          <section className="results-zone">
            <div className="rmeta">
              <span className="rmeta-left">
                {meta.count} result{meta.count === 1 ? "" : "s"} · {meta.ms.toFixed(0)} ms
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
              <p className="notice">No results for “{meta.query}”.</p>
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
