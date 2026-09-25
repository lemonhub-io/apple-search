import { useEffect } from "react";
import { MODEL_MB } from "../ai/model";
import type { RerankerState } from "../hooks/useReranker";
import { CheckIcon, DownloadIcon, MagIcon, SparkIcon } from "./icons";

interface Props {
  canInstall: boolean;
  installed: boolean;
  onInstall: () => void;
  reranker: RerankerState;
  onDone: () => void;
}

/// First-run setup as a single checklist, not a wizard: both upgrades are
/// optional and independent, so sequencing them would only hide one behind
/// the other. One screen shows everything; one CTA dismisses it; Esc skips.
export function Onboarding({ canInstall, installed, onInstall, reranker, onDone }: Props) {
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
          <MagIcon />
        </div>
        <h1 id="ob-title" className="ob-head">
          Search the web.
        </h1>
        <p className="ob-sub">A minimal engine that keeps ranking on your device.</p>

        <div className="ob-items">
          <InstallItem canInstall={canInstall} installed={installed} onInstall={onInstall} />
          <ModelItem reranker={reranker} />
        </div>

        <button className="btn primary ob-cta" onClick={onDone} autoFocus>
          Start searching
        </button>
        <p className="ob-note">All optional. Press Esc to skip.</p>
      </div>
    </div>
  );
}

function InstallItem({
  canInstall,
  installed,
  onInstall,
}: {
  canInstall: boolean;
  installed: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="ob-item">
      <span className="ob-ico" aria-hidden>
        <DownloadIcon />
      </span>
      <span className="ob-text">
        <span className="ob-title">Install the app</span>
        <span className="ob-desc">Launch instantly from your dock or home screen.</span>
      </span>
      <span className="ob-act">
        {installed ? (
          <Done label="Installed" />
        ) : canInstall ? (
          <button className="btn primary sm" onClick={onInstall}>
            Install
          </button>
        ) : (
          <span className="ob-hint">Via browser menu</span>
        )}
      </span>
    </div>
  );
}

function ModelItem({ reranker }: { reranker: RerankerState }) {
  const { status, progress } = reranker;
  const busy = status === "loading" || status === "downloading";
  return (
    <div className="ob-item">
      <span className="ob-ico" aria-hidden>
        <SparkIcon />
      </span>
      <span className="ob-text">
        <span className="ob-title">Smarter ranking</span>
        {busy ? (
          <span className="ob-prog">
            <span
              className="ob-prog-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={MODEL_MB}
              aria-valuenow={
                status === "downloading" && progress != null
                  ? Math.round(progress * MODEL_MB)
                  : undefined
              }
            >
              <span
                className="ob-prog-fill"
                style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
              />
            </span>
            <span className="ob-prog-text">
              {status === "downloading" && progress != null
                ? `${Math.round(progress * MODEL_MB)} of ~${MODEL_MB} MB`
                : "Preparing…"}
            </span>
          </span>
        ) : (
          <span className="ob-desc">
            {status === "ready"
              ? "The model is on this device. Nothing leaves it."
              : status === "error"
                ? "Download failed. You can retry or skip this."
                : `On-device AI re-ranks results for relevance. ~${MODEL_MB} MB, downloaded once.`}
          </span>
        )}
      </span>
      <span className="ob-act">
        {status === "ready" ? (
          <Done label="Ready" />
        ) : busy ? (
          <button className="btn link sm" onClick={reranker.disable}>
            Cancel
          </button>
        ) : status === "error" ? (
          <button className="btn sm" onClick={reranker.enable}>
            Try again
          </button>
        ) : (
          <button className="btn primary sm" onClick={reranker.enable}>
            Download
          </button>
        )}
      </span>
    </div>
  );
}

function Done({ label }: { label: string }) {
  return (
    <span className="ob-done">
      <CheckIcon />
      {label}
    </span>
  );
}
