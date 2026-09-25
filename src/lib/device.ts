// Device capability probe for onboarding page 2. Answers "can this device
// run the on-device reranker well?" — hard failures (no WASM, no workers,
// very little RAM) skip the download page entirely; softer gaps (no SIMD,
// no OPFS cache, single-threaded) only warn.

import { MODEL_BYTES, MODEL_MB } from "../ai/model";

export type CheckState = "pass" | "warn" | "fail" | "unknown";

export interface DeviceCheck {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export type Verdict = "pass" | "warn" | "fail";

export interface DeviceReport {
  checks: DeviceCheck[];
  verdict: Verdict;
}

// A header-only module validates everywhere WASM exists at all; the second
// is wasm-feature-detect's SIMD probe — a function body using i32x4 ops,
// rejected by validate() where SIMD isn't implemented.
const WASM_EMPTY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const WASM_SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
  1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

// Model + tokenizer + ort wasm, plus working headroom for the session.
const NEED_BYTES = MODEL_BYTES + 60_000_000;

function fmtBytes(n: number): string {
  if (n >= 1e9) {
    const g = n / 1e9;
    return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB`;
  }
  return `${Math.round(n / 1e6)} MB`;
}

function wasmOk(bytes: BufferSource): boolean {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(bytes);
  } catch {
    return false;
  }
}

export async function runDeviceChecks(): Promise<DeviceReport> {
  const checks: DeviceCheck[] = [];
  const push = (id: string, label: string, state: CheckState, detail: string) =>
    checks.push({ id, label, state, detail });

  const wasm = wasmOk(WASM_EMPTY);
  push("wasm", "WebAssembly", wasm ? "pass" : "fail", wasm ? "Supported" : "Not available");

  const workers = typeof Worker === "function";
  push(
    "worker",
    "Background workers",
    workers ? "pass" : "fail",
    workers ? "Supported" : "Not available",
  );

  const streams = typeof ReadableStream === "function";
  push(
    "stream",
    "Streaming downloads",
    streams ? "pass" : "fail",
    streams ? "Supported" : "Not available",
  );

  // navigator.deviceMemory is Chromium-only and quantized to powers of
  // two — absent means "couldn't measure", not zero.
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  push(
    "memory",
    "Memory",
    mem == null ? "unknown" : mem < 2 ? "fail" : mem < 4 ? "warn" : "pass",
    mem == null
      ? "Not reported by this browser"
      : mem < 2
        ? "Under 2 GB, not enough for the model"
        : mem < 4
          ? `~${mem} GB, workable but tight`
          : `${mem}+ GB`,
  );

  // OPFS is optional (the worker falls back to downloading per session),
  // but without it the ~280 MB model never persists.
  let opfs = false;
  try {
    if (typeof navigator.storage?.getDirectory !== "function") throw new Error("no opfs");
    await navigator.storage.getDirectory();
    opfs = true;
  } catch {
    opfs = false;
  }
  push(
    "opfs",
    "On-device storage",
    opfs ? "pass" : "warn",
    opfs ? "Model can be cached locally" : "Unavailable, model re-downloads every visit",
  );

  let quota: number | null = null;
  try {
    quota = (await navigator.storage?.estimate?.())?.quota ?? null;
  } catch {
    quota = null;
  }
  push(
    "quota",
    "Free space",
    quota == null ? "unknown" : quota >= NEED_BYTES ? "pass" : "warn",
    quota == null
      ? "Couldn’t be measured"
      : quota >= NEED_BYTES
        ? `${fmtBytes(quota)} available`
        : `Only ${fmtBytes(quota)} free, needs ~${fmtBytes(NEED_BYTES)}`,
  );

  const simd = wasmOk(WASM_SIMD);
  push(
    "simd",
    "SIMD acceleration",
    !wasm ? "unknown" : simd ? "pass" : "warn",
    !wasm ? "Needs WebAssembly" : simd ? "Enabled" : "Not supported, scoring runs slower",
  );

  // COOP/COEP headers turn on SharedArrayBuffer → multi-threaded WASM.
  const isolated = self.crossOriginIsolated === true;
  push(
    "threads",
    "Multi-threading",
    isolated ? "pass" : "warn",
    isolated ? "Enabled" : "Single-threaded only",
  );

  const cores = navigator.hardwareConcurrency || 0;
  push(
    "cores",
    "CPU",
    cores === 0 ? "unknown" : cores >= 4 ? "pass" : "warn",
    cores === 0
      ? "Not reported"
      : cores >= 4
        ? `${cores} cores`
        : `${cores} ${cores === 1 ? "core" : "cores"}, scoring will be slow`,
  );

  const conn = (
    navigator as { connection?: { effectiveType?: string; saveData?: boolean } }
  ).connection;
  const online = navigator.onLine;
  const slow = conn?.effectiveType === "2g" || conn?.effectiveType === "slow-2g";
  push(
    "net",
    "Connection",
    !online ? "warn" : conn?.saveData || slow ? "warn" : "pass",
    !online
      ? "Offline, needed for the download"
      : conn?.saveData
        ? `Data-saver is on, model is ~${MODEL_MB} MB`
        : slow
          ? "Slow connection, download may take a while"
          : "Online",
  );

  const verdict: Verdict = checks.some((c) => c.state === "fail")
    ? "fail"
    : checks.some((c) => c.state === "warn")
      ? "warn"
      : "pass";

  return { checks, verdict };
}
