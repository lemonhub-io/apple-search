import { memo, type CSSProperties } from "react";
import type { UiResult } from "../engine";
import type { SearchMeta } from "../hooks/useSearch";
import { BadgeIcon } from "./icons";

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

// Memoized: typing in the search box re-renders App on every keystroke —
// the results subtree should only re-render when its own props change.
export const Results = memo(function Results({ meta, results, freshness, onFreshness }: Props) {
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
            // Key by id, not index: a re-search can reorder the same items —
            // keyed-by-id they move without remounting (no animation replay).
            <ResultItem key={r.id} result={r} index={i} />
          ))}
        </ol>
      )}
    </section>
  );
});

const ResultItem = memo(function ResultItem({ result: r, index }: { result: UiResult; index: number }) {
  return (
    <li style={{ "--i": index } as CSSProperties}>
      <div className="r-site">
        <span className="r-badge" aria-hidden>
          {r.host.charAt(0).toUpperCase()}
        </span>
        <span className="r-crumb">
          <span className="r-display">{r.display}</span>
          {r.cred && (
            <span
              className="r-cred"
              title={r.cred === "official" ? "The entity's own site" : "Institutional domain"}
            >
              <BadgeIcon />
              {r.cred === "official" ? "Official" : "Institution"}
            </span>
          )}
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
});
