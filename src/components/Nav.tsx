import type { Theme } from "../lib/platform";
import { MagIcon, MoonIcon, SunIcon } from "./icons";

interface Props {
  online: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  canInstall: boolean;
  onInstall: () => void;
}

export function Nav({ online, theme, onToggleTheme, canInstall, onInstall }: Props) {
  return (
    <header className="nav">
      <span className="wordmark">
        <MagIcon className="wordmark-icon" />
        Search
      </span>
      <div className="nav-side">
        {!online && <span className="off-badge">Offline</span>}
        {canInstall && (
          <button className="install-btn" onClick={onInstall}>
            Install
          </button>
        )}
        <button
          className="theme-btn"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={onToggleTheme}
        >
          {/* Keyed remount replays the spin-in on every flip. */}
          <span className="theme-ico" key={theme}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </span>
        </button>
      </div>
    </header>
  );
}
