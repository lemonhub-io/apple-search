// Main-thread client for the AI reranker worker. The worker owns the model
// lifecycle (download → OPFS → ONNX session); this wrapper just manages the
// message protocol.

export type AiStatus = "off" | "loading" | "downloading" | "ready" | "error";

type Listener = (status: AiStatus, progress: { loaded: number; total: number } | null) => void;

// Bounded wait for one score batch — a hung inference must reject rather
// than leave a promise (and its search) pending forever.
const SCORE_TIMEOUT_MS = 60_000;

let worker: Worker | null = null;
let status: AiStatus = "off";
let lastError: string | null = null;
let seq = 0;
const pending = new Map<number, { res: (s: number[]) => void; rej: (e: Error) => void }>();
const listeners = new Set<Listener>();
let progressCb: ((loaded: number, total: number) => void) | null = null;

function setStatus(s: AiStatus, progress: { loaded: number; total: number } | null = null) {
  status = s;
  for (const l of listeners) l(status, progress);
}

function rejectAll(err: Error) {
  for (const p of pending.values()) p.rej(err);
  pending.clear();
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "progress") {
        progressCb?.(m.loaded, m.total);
        setStatus("downloading", { loaded: m.loaded, total: m.total });
      } else if (m.type === "ready") {
        setStatus("ready");
      } else if (m.type === "scores") {
        pending.get(m.id)?.res(m.scores);
        pending.delete(m.id);
      } else if (m.type === "error") {
        if (m.id !== undefined) {
          pending.get(m.id)?.rej(new Error(m.message));
          pending.delete(m.id);
        } else {
          const msg = m.message ?? "Reranker failed";
          lastError = msg;
          console.error("[ai]", msg);
          rejectAll(new Error(msg));
          setStatus("error");
        }
      }
    };
    worker.onerror = (e) => {
      lastError = e.message || "Reranker worker crashed";
      console.error("[ai]", lastError);
      rejectAll(new Error(lastError));
      setStatus("error");
    };
  }
  return worker;
}

export const reranker = {
  get status(): AiStatus {
    return status;
  },

  get error(): string | null {
    return lastError;
  },

  onStatus(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  /// Spawn the worker and start model load/download. Progress callbacks fire
  /// while the ~280 MB model downloads (first enable only; OPFS after that).
  enable(onProgress?: (loaded: number, total: number) => void) {
    if (status === "loading" || status === "downloading" || status === "ready") {
      return; // already running — a second click must not flap the session
    }
    progressCb = onProgress ?? null;
    lastError = null;
    setStatus("loading");
    ensureWorker().postMessage({ type: "init" });
  },

  disable() {
    rejectAll(new Error("Reranker disabled"));
    worker?.terminate();
    worker = null;
    progressCb = null;
    setStatus("off");
  },

  /// Score texts against the query; resolves to logits aligned with `texts`.
  score(query: string, texts: string[]): Promise<number[]> {
    if (status !== "ready") return Promise.resolve([]);
    const id = ++seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error("Rerank timed out"));
      }, SCORE_TIMEOUT_MS);
      pending.set(id, {
        res: (s) => {
          clearTimeout(timer);
          res(s);
        },
        rej: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
      ensureWorker().postMessage({ type: "score", id, query, texts });
    });
  },
};
