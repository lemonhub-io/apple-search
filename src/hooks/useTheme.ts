import { useCallback, useEffect, useRef, useState } from "react";
import { initialTheme, systemTheme, THEME_KEY, type Theme } from "../lib/platform";

/// Theme state: persisted choice, OS follow until the user picks, and
/// <meta name="theme-color"> kept in sync for the browser chrome.
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const manualTheme = useRef(localStorage.getItem(THEME_KEY) !== null);

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

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (!manualTheme.current) setTheme(systemTheme());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    manualTheme.current = true;
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
