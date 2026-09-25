import { useEffect } from "react";
import { Nav } from "./components/Nav";
import { Results } from "./components/Results";
import { SearchBox } from "./components/SearchBox";
import { Skeleton } from "./components/Skeleton";
import { useInstallPrompt } from "./hooks/useInstallPrompt";
import { useOnline } from "./hooks/useOnline";
import { useSearch } from "./hooks/useSearch";
import { useTheme } from "./hooks/useTheme";

export default function App() {
  const online = useOnline();
  const { theme, toggle } = useTheme();
  const { canInstall, install } = useInstallPrompt();
  const { input, setInput, phase, results, meta, error, freshness, inputRef, runSearch } =
    useSearch(online);

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
  }, [inputRef, setInput]);

  return (
    <div className="page">
      <Nav
        online={online}
        theme={theme}
        onToggleTheme={toggle}
        canInstall={canInstall}
        onInstall={() => void install()}
      />

      <main className="main">
        <SearchBox
          input={input}
          onInput={setInput}
          onSubmit={() => void runSearch(input, freshness)}
          inputRef={inputRef}
          compact={phase !== "idle"}
        />

        {phase === "loading" && <Skeleton />}

        {phase === "error" && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}

        {phase === "done" && meta && (
          <Results
            meta={meta}
            results={results}
            freshness={freshness}
            onFreshness={(f) => void runSearch(meta.query, f)}
          />
        )}
      </main>
    </div>
  );
}
