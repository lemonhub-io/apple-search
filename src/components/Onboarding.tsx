import { useState } from "react";
import type { RerankerState } from "../hooks/useReranker";

interface Props {
  canInstall: boolean;
  onInstall: () => void;
  reranker: RerankerState;
  onDone: () => void;
}

const MODEL_MB = 280;

/// First-run setup: install the app, then optionally download the on-device
/// AI ranking model. Every step is skippable — the engine works without
/// either; AI just sharpens result ordering.
export function Onboarding({ canInstall, onInstall, reranker, onDone }: Props) {
  const [step, setStep] = useState(0);

  const steps = [
    {
      title: "Install the app",
      body: "Add Search to your home screen or dock — instant launch, works offline.",
      action: canInstall ? (
        <button className="btn primary" onClick={onInstall}>Install</button>
      ) : (
        <p className="hint">Use your browser's "Add to Home Screen" / install option.</p>
      ),
    },
    {
      title: "Smarter ranking",
      body: `Download a ~${MODEL_MB} MB AI model once. It stays on your device (OPFS), runs in a background worker, and re-ranks results for relevance — nothing is uploaded.`,
      action:
        reranker.status === "ready" ? (
          <p className="hint">Model ready.</p>
        ) : reranker.status === "downloading" || reranker.status === "loading" ? (
          <div className="dl">
            <div className="dl-bar">
              <div
                className="dl-fill"
                style={{ width: `${Math.round((reranker.progress ?? 0) * 100)}%` }}
              />
            </div>
            <p className="hint">
              {reranker.progress != null
                ? `${Math.round(reranker.progress * MODEL_MB)} of ~${MODEL_MB} MB`
                : "Preparing…"}
            </p>
          </div>
        ) : reranker.status === "error" ? (
          <p className="hint">Download failed — you can retry later or continue without it.</p>
        ) : (
          <button className="btn primary" onClick={reranker.enable}>
            Download &amp; enable
          </button>
        ),
    },
  ];

  const last = step === steps.length - 1;
  const done = () => {
    if (last) onDone();
    else setStep(step + 1);
  };

  return (
    <div className="onboarding">
      <div className="ob-card">
        <div className="ob-dots">
          {steps.map((_, i) => (
            <span key={i} className={`ob-dot ${i === step ? "on" : ""}`} />
          ))}
        </div>
        <h1>{steps[step].title}</h1>
        <p className="ob-body">{steps[step].body}</p>
        <div className="ob-action">{steps[step].action}</div>
        <div className="ob-foot">
          <button className="btn" onClick={done}>
            {last ? (reranker.status === "ready" ? "Start searching" : "Skip & start") : "Skip"}
          </button>
          {!last && (
            <button className="btn link" onClick={onDone}>
              Skip all
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
