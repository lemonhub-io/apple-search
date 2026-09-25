// Browser/platform helpers shared by hooks.

export type Theme = "light" | "dark";

export const THEME_KEY = "search-theme";
export const ONBOARDED_KEY = "onboarded";
export const AI_RERANK_KEY = "ai-rerank";

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : systemTheme();
}

/// True when running as an installed PWA (or iOS standalone).
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/// `?q=` deep link, plus `?url=` from the share target.
export function queryFromLocation(): string | null {
  const params = new URLSearchParams(location.search);
  return params.get("q") || params.get("url");
}
