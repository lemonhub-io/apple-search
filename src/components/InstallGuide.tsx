import { useMemo, useState, type ReactNode } from "react";
import {
  detectBrowser,
  detectPlatform,
  type BrowserName,
  type DevicePlatform,
} from "../lib/platform";
import { ShareIcon } from "./icons";

interface GuideSection {
  /// Browsers this section's steps apply to — the detected browser's
  /// section floats to the top. Omitted when it's the only section.
  match?: BrowserName[];
  name: string;
  steps: ReactNode[];
}

interface Guide {
  note?: ReactNode;
  sections: GuideSection[];
}

const PLATFORMS: { id: DevicePlatform; label: string }[] = [
  { id: "ios", label: "iOS" },
  { id: "android", label: "Android" },
  { id: "macos", label: "macOS" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

const GUIDES: Record<DevicePlatform, Guide> = {
  ios: {
    note: "Only Safari can add apps to the Home Screen on iOS.",
    sections: [
      {
        name: "Safari",
        steps: [
          <>
            Tap <ShareIcon /> <strong>Share</strong> in the toolbar.
          </>,
          <>
            Scroll down and tap <strong>Add to Home Screen</strong>.
          </>,
          <>
            Tap <strong>Add</strong>.
          </>,
        ],
      },
    ],
  },
  android: {
    sections: [
      {
        match: ["chrome", "edge", "other"],
        name: "Chrome / Edge",
        steps: [
          <>
            Tap <strong>⋮</strong> at the top right.
          </>,
          <>
            Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
          </>,
          <>
            Tap <strong>Install</strong>.
          </>,
        ],
      },
      {
        match: ["samsung"],
        name: "Samsung Internet",
        steps: [
          <>
            Tap <strong>☰</strong> at the bottom right.
          </>,
          <>
            Tap <strong>Add page to</strong> → <strong>Home screen</strong>.
          </>,
        ],
      },
      {
        match: ["firefox"],
        name: "Firefox",
        steps: [
          <>
            Tap <strong>⋮</strong> at the bottom right.
          </>,
          <>
            Tap <strong>Install</strong> or <strong>Add to Home screen</strong>.
          </>,
        ],
      },
    ],
  },
  macos: {
    sections: [
      {
        match: ["safari"],
        name: "Safari",
        steps: [
          <>
            In the menu bar, choose <strong>File → Add to Dock…</strong>
          </>,
          <>
            Click <strong>Add</strong>.
          </>,
        ],
      },
      {
        match: ["chrome", "edge", "other"],
        name: "Chrome / Edge",
        steps: [
          <>
            Click the <strong>install icon</strong> at the right end of the address bar, or open
            the menu → <strong>Save and share</strong> → <strong>Install page as app…</strong>
          </>,
          <>
            Click <strong>Install</strong>.
          </>,
        ],
      },
    ],
  },
  windows: {
    sections: [
      {
        match: ["chrome", "edge", "other"],
        name: "Chrome / Edge",
        steps: [
          <>
            Click the <strong>install icon</strong> at the right end of the address bar, or open{" "}
            <strong>⋯</strong> → <strong>Apps</strong> → <strong>Install</strong>.
          </>,
          <>
            Click <strong>Install</strong>.
          </>,
        ],
      },
      {
        match: ["firefox"],
        name: "Firefox",
        steps: [
          <>Firefox can’t install sites as apps — use Chrome or Edge, or keep Search in a tab.</>,
        ],
      },
    ],
  },
  linux: {
    sections: [
      {
        match: ["chrome", "edge", "other"],
        name: "Chrome / Chromium",
        steps: [
          <>
            Click the <strong>install icon</strong> in the address bar, or open <strong>⋮</strong>{" "}
            → <strong>Install Search…</strong>
          </>,
          <>
            Click <strong>Install</strong>.
          </>,
        ],
      },
      {
        match: ["firefox"],
        name: "Firefox",
        steps: [
          <>Not supported — use Chrome or Chromium to install, or keep Search in a tab.</>,
        ],
      },
    ],
  },
};

/// Platform picker (auto-detected) with numbered install steps per browser.
export function InstallGuide() {
  const [platform, setPlatform] = useState<DevicePlatform>(() => detectPlatform());
  const browser = useMemo(() => detectBrowser(), []);
  const guide = GUIDES[platform];

  // Float the section matching the current browser to the top.
  const sections = useMemo(() => {
    const i = guide.sections.findIndex((s) => s.match?.includes(browser));
    return i <= 0
      ? guide.sections
      : [guide.sections[i], ...guide.sections.slice(0, i), ...guide.sections.slice(i + 1)];
  }, [guide, browser]);

  return (
    <div className="ob-guide">
      <div className="ob-chips" role="radiogroup" aria-label="Choose your platform">
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={p.id === platform}
            className={`ob-chip${p.id === platform ? " on" : ""}`}
            onClick={() => setPlatform(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="ob-guide-body">
        {sections.map((s) => (
          <section className="ob-guide-sec" key={s.name}>
            <p className="ob-guide-name">{s.name}</p>
            {s.steps.length > 1 ? (
              <ol className="ob-steps">
                {s.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            ) : (
              // Single entries are notes, not steps — no list marker.
              <p className="ob-steps-note">{s.steps[0]}</p>
            )}
          </section>
        ))}
        {guide.note && <p className="ob-guide-note">{guide.note}</p>}
      </div>
    </div>
  );
}
