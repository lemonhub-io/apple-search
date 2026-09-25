import type { CSSProperties } from "react";

/// Loading placeholder rows shown while a search is in flight.
export function Skeleton() {
  return (
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
  );
}
