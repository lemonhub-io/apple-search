import { useCallback, useEffect, useRef, useState } from "react";
import { MODEL_MB } from "../ai/model";
import { useDeviceCheck } from "../hooks/useDeviceCheck";
import type { RerankerState } from "../hooks/useReranker";
import type { DeviceCheck, DeviceReport } from "../lib/device";
import {
  CheckIcon,
  ChevronIcon,
  ChipIcon,
  DownloadIcon,
  MinusIcon,
  SparkIcon,
  WarnIcon,
  XIcon,
} from "./icons";
import { InstallGuide } from "./InstallGuide";

interface Props {
  canInstall: boolean;
  installed: boolean;
  onInstall: () => void;
  reranker: RerankerState;
  onDone: () => void;
}

const STEP_COUNT = 3;

/// First-run setup as a three-page wizard: install → device check → model
/// download. A failed device check skips the download page outright (there's
/// nothing to download for hardware that can't run it). Every page carries a
/// Skip control, Back walks the stack, and Esc dismisses the whole flow.
export function Onboarding({ canInstall, installed, onInstall, reranker, onDone }: Props) {
  const [step, setStep] = useState(0);
  const dir = useRef(1); // page-transition direction: 1 forward, -1 back
  const report = useDeviceCheck();

  const go = (n: number) => {
    dir.current = n > step ? 1 : -1;
    setStep(n);
  };

  // After the device page a failing verdict ends the flow — offering the
  // model page to a device that can't run it would be a dead end.
  const next = useCallback(() => {
    if (step === 1 && report?.verdict === "fail") onDone();
    else if (step < STEP_COUNT - 1) go(step + 1);
    else onDone();
  }, [step, report, onDone]);

  // Accepting the install prompt flips `installed` mid-flow — let the
  // confirmation read for a beat, then move on.
  const installedAtEntry = useRef(installed);
  useEffect(() => {
    if (installedAtEntry.current || !installed || step !== 0) return;
    dir.current = 1;
    const t = setTimeout(() => setStep(1), 900);
    return () => clearTimeout(t);
  }, [installed, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const checking = step === 1 && !report;
  const cta =
    step === STEP_COUNT - 1 ? "Start searching" : checking ? "Checking…" : "Continue";

  return (
    <div className="onboarding">
      <div className="ob" role="dialog" aria-modal="true" aria-labelledby="ob-title">
        <div className="ob-top">
          {step > 0 ? (
            <button className="ob-nav" onClick={() => go(step - 1)}>
              <ChevronIcon />
              Back
            </button>
          ) : (
            <span className="ob-top-spacer" aria-hidden />
          )}
          <button className="ob-nav" onClick={onDone}>
            Skip
          </button>
        </div>

        <div className="ob-stage" data-dir={dir.current > 0 ? "fwd" : "back"} key={`s${step}`}>
          {step === 0 && (
            <InstallPage canInstall={canInstall} installed={installed} onInstall={onInstall} />
          )}
          {step === 1 && <DevicePage report={report} />}
          {step === 2 && <ModelPage reranker={reranker} />}
        </div>

        <div className="ob-dots" aria-hidden>
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <span
              key={i}
              className={`ob-dot${i === step ? " on" : i < step ? " done" : ""}${
                // The skipped download page shows as a hollow dot once the
                // check has failed.
                i === STEP_COUNT - 1 && step === 1 && report?.verdict === "fail" ? " off" : ""
              }`}
            />
          ))}
        </div>

        <button
          key={`cta${step}`}
          className="btn primary ob-cta"
          onClick={next}
          disabled={checking}
          autoFocus
        >
          {cta}
        </button>
        <p className="ob-note">Everything here is optional.</p>
      </div>
    </div>
  );
}

/* ————— Page 1: install ————— */

function InstallPage({
  canInstall,
  installed,
  onInstall,
}: {
  canInstall: boolean;
  installed: boolean;
  onInstall: () => void;
}) {
  return (
    <>
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
              <Done label="Done" />
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
    </>
  );
}

/* ————— Page 2: device check ————— */

function DevicePage({ report }: { report: DeviceReport | null }) {
  const sub = !report
    ? "Checking what this device can do…"
    : report.verdict === "pass"
      ? "Good to go — on-device AI runs comfortably here."
      : report.verdict === "warn"
        ? "Workable, with the caveats below."
        : "This device can’t run the on-device model, so the download step is skipped. Search works regardless.";
  return (
    <>
      <div className="ob-mark" aria-hidden>
        <ChipIcon />
      </div>
      <h1 id="ob-title" className="ob-head">
        Device check
      </h1>
      <p className="ob-sub">{sub}</p>

      <div className="ob-panel" aria-live="polite">
        {report
          ? report.checks.map((c) => <CheckRow key={c.id} c={c} />)
          : [0, 1, 2, 3].map((i) => (
              <div className="ob-check" key={i} aria-hidden>
                <span className="ob-check-ico" />
                <span className="sk ob-check-sk" style={{ width: `${52 - i * 9}%` }} />
              </div>
            ))}
      </div>
    </>
  );
}

function CheckRow({ c }: { c: DeviceCheck }) {
  return (
    <div className="ob-check">
      <span className={`ob-check-ico s-${c.state}`} aria-hidden>
        {c.state === "pass" ? (
          <CheckIcon />
        ) : c.state === "warn" ? (
          <WarnIcon />
        ) : c.state === "fail" ? (
          <XIcon />
        ) : (
          <MinusIcon />
        )}
      </span>
      <span className="ob-check-label">{c.label}</span>
      <span className="ob-check-detail">{c.detail}</span>
    </div>
  );
}

/* ————— Page 3: model download ————— */

function ModelPage({ reranker }: { reranker: RerankerState }) {
  return (
    <>
      <div className="ob-mark" aria-hidden>
        <SparkIcon />
      </div>
      <h1 id="ob-title" className="ob-head">
        Smarter ranking
      </h1>
      <p className="ob-sub">
        An on-device AI re-ranks results for relevance. ~{MODEL_MB} MB, downloaded once —
        nothing leaves this device.
      </p>

      <div className="ob-items">
        <ModelItem reranker={reranker} />
      </div>
    </>
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
        <span className="ob-title">Ranking model</span>
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
                ? `Setup failed${reranker.error ? `: ${reranker.error}` : ". You can retry or skip this."}`
                : `Downloads once and stays cached. Works on any connection after that.`}
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
