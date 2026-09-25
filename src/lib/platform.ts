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

export type DevicePlatform = "ios" | "android" | "macos" | "windows" | "linux";

/// Best-effort OS detection, used to preselect install instructions — a
/// display hint, never a gate. iPadOS reports as Macintosh, so touch is
/// the tell.
export function detectPlatform(): DevicePlatform {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return "ios";
  if (/android/i.test(ua)) return "android";
  if (/macintosh|mac os/i.test(ua)) return "macos";
  if (/windows/i.test(ua)) return "windows";
  return "linux";
}

export type BrowserName =
  | "safari"
  | "chrome"
  | "edge"
  | "firefox"
  | "samsung"
  | "other";

/// UA-based browser detection — order matters: Edge, Samsung, and Chrome
/// all contain "Chrome", Safari tokens only appear in real Safari.
export function detectBrowser(): BrowserName {
  const ua = navigator.userAgent;
  if (/samsungbrowser/i.test(ua)) return "samsung";
  if (/edg(a|ios)?\//i.test(ua)) return "edge";
  if (/fxios|firefox/i.test(ua)) return "firefox";
  if (/crios|chrome|chromium/i.test(ua)) return "chrome";
  if (/safari/i.test(ua)) return "safari";
  return "other";
}
