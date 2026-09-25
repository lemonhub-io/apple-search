import { useEffect, useState } from "react";
import { Nav } from "./components/Nav";
import { Onboarding } from "./components/Onboarding";
import { Results } from "./components/Results";
import { SearchBox } from "./components/SearchBox";
import { Skeleton } from "./components/Skeleton";
import { useInstallPrompt } from "./hooks/useInstallPrompt";
import { useOnline } from "./hooks/useOnline";
import { useReranker } from "./hooks/useReranker";
import { useSearch } from "./hooks/useSearch";
import { useTheme } from "./hooks/useTheme";
import { queryFromLocation } from "./lib/platform";

export default function App() {
  const online = useOnline();
  const { theme, toggle } = useTheme();
  const { canInstall, install } = useInstallPrompt();
  const reranker = useReranker();
  const { input, setInput, phase, results, meta, error, freshness, inputRef, runSearch } =
    useSearch(online, reranker.rescore);

  // First visit (no deep link): guided setup — PWA install, then the optional
  // on-device AI model. Every step skippable; ?q= links jump straight in.
  const [onboarded, setOnboarded] = useState(
    () => localStorage.getItem("onboarded") === "1" || !!queryFromLocation(),
  );
  const finishOnboarding = () => {
    localStorage.setItem("onboarded", "1");
    setOnboarded(true);
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
        {!onboarded && (
          <Onboarding
            canInstall={canInstall}
            onInstall={() => void install()}
            reranker={reranker}
            onDone={finishOnboarding}
          />
        )}

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
