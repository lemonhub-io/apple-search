import type { CSSProperties } from "react";
import type { UiResult } from "../engine";
import type { SearchMeta } from "../hooks/useSearch";

const FRESHNESS = [
  { id: "auto", label: "Auto" },
  { id: "noLimit", label: "Any time" },
  { id: "oneDay", label: "Past day" },
  { id: "oneWeek", label: "Past week" },
  { id: "oneMonth", label: "Past month" },
  { id: "oneYear", label: "Past year" },
] as const;

interface Props {
  meta: SearchMeta;
  results: UiResult[];
  freshness: string;
  onFreshness: (id: string) => void;
}

export function Results({ meta, results, freshness, onFreshness }: Props) {
  return (
    <section className="results-zone">
      <div className="rmeta">
        <span className="rmeta-left">
          {meta.count} of {meta.candidates} · {meta.ms.toFixed(0)} ms
          {meta.intent !== "general" && ` · ${meta.intent}`}
          {freshness === "auto" && meta.freshness !== "noLimit" &&
            ` · ${FRESHNESS.find((f) => f.id === meta.freshness)?.label.toLowerCase()}`}
          {meta.widened && " · widened to any time"}
          {meta.expanded && " · expanded query"}
          {meta.ai && " · ai"}
        </span>
        <nav className="fresh" aria-label="Filter by date">
          {FRESHNESS.map((f) => (
            <button
              key={f.id}
              className={`fresh-link${freshness === f.id ? " active" : ""}`}
              onClick={() => onFreshness(f.id)}
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
            <ResultItem key={`${r.id}-${i}`} result={r} index={i} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ResultItem({ result: r, index }: { result: UiResult; index: number }) {
  return (
    <li style={{ "--i": index } as CSSProperties}>
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
  );
}
