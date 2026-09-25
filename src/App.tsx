import { useCallback, useEffect, useState } from "react";
import { Nav } from "./components/Nav";
import { Onboarding } from "./components/Onboarding";
import { Results } from "./components/Results";
import { SearchBox } from "./components/SearchBox";
import { Skeleton } from "./components/Skeleton";
import { useInstallPrompt } from "./hooks/useInstallPrompt";
import { useOnline } from "./hooks/useOnline";
import { useSearch } from "./hooks/useSearch";
import { useTheme } from "./hooks/useTheme";
import { ONBOARDED_KEY, queryFromLocation } from "./lib/platform";

export default function App() {
  const online = useOnline();
  const { theme, toggle } = useTheme();
  const { canInstall, installed, install } = useInstallPrompt();
  const { input, setInput, phase, results, meta, error, freshness, inputRef, runSearch } =
    useSearch(online);

  // First visit (no deep link): the PWA install guide. Skippable; ?q=
  // links jump straight in.
  const [onboarded, setOnboarded] = useState(
    () => localStorage.getItem(ONBOARDED_KEY) === "1" || !!queryFromLocation(),
  );
  const finishOnboarding = () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    setOnboarded(true);
  };

  // Stable callbacks — Results is memoized, so inline arrows would defeat it.
  const query = meta?.query ?? "";
  const onFreshness = useCallback(
    (f: string) => void runSearch(query, f),
    [query, runSearch],
  );
  const onInstall = useCallback(() => void install(), [install]);

  // "/" focuses the field, Escape clears it — but not while the onboarding
  // overlay is up, where the covered field would swallow the keystrokes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!onboarded) return;
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
  }, [onboarded, inputRef, setInput]);

  return (
    <div className="page">
      <Nav
        online={online}
        theme={theme}
        onToggleTheme={toggle}
        canInstall={canInstall}
        onInstall={onInstall}
      />

      <main className="main">
        {!onboarded && (
          <Onboarding
            canInstall={canInstall}
            installed={installed}
            onInstall={onInstall}
            onDone={finishOnboarding}
          />
        )}

        <SearchBox
          input={input}
          onInput={setInput}
          onSubmit={() => void runSearch(input, freshness)}
          inputRef={inputRef}
          compact={phase !== "idle"}
          autoFocus={onboarded}
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
            onFreshness={onFreshness}
          />
        )}
      </main>
    </div>
  );
}
