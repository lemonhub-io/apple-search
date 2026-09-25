import { useEffect } from "react";
import { CheckIcon, DownloadIcon } from "./icons";
import { InstallGuide } from "./InstallGuide";

interface Props {
  canInstall: boolean;
  installed: boolean;
  onInstall: () => void;
  onDone: () => void;
}

/// First-run install guide: a one-tap install when the browser offers it,
/// plus per-platform steps otherwise. Entirely optional — the CTA and Esc
/// both dismiss it.
export function Onboarding({ canInstall, installed, onInstall, onDone }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  return (
    <div className="onboarding">
      <div className="ob" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <div className="ob-mark" aria-hidden>
          <DownloadIcon />
        </div>
        <h1 id="ob-title" className="ob-head">
          Keep Search one tap away.
        </h1>
        <p className="ob-sub">
          Install the app — it opens in its own window and launches straight into search.
        </p>

        {installed ? (
          <div className="ob-items">
            <div className="ob-item">
              <span className="ob-ico" aria-hidden>
                <CheckIcon />
              </span>
              <span className="ob-text">
                <span className="ob-title">Installed</span>
                <span className="ob-desc">Find it on your home screen or dock.</span>
              </span>
              <span className="ob-act">
                <span className="ob-done">
                  <CheckIcon />
                  Done
                </span>
              </span>
            </div>
          </div>
        ) : (
          <>
            {canInstall && (
              <div className="ob-items">
                <div className="ob-item">
                  <span className="ob-ico" aria-hidden>
                    <DownloadIcon />
                  </span>
                  <span className="ob-text">
                    <span className="ob-title">One-tap install</span>
                    <span className="ob-desc">This browser can install it directly.</span>
                  </span>
                  <span className="ob-act">
                    <button className="btn primary sm" onClick={onInstall}>
                      Install
                    </button>
                  </span>
                </div>
              </div>
            )}
            <InstallGuide />
          </>
        )}

        <button className="btn primary ob-cta" onClick={onDone} autoFocus>
          Start searching
        </button>
        <p className="ob-note">Optional — press Esc to skip.</p>
      </div>
    </div>
  );
}
