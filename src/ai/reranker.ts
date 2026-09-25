// Main-thread client for the AI reranker worker. The worker owns the model
// lifecycle (download → OPFS → ONNX session); this wrapper just manages the
// message protocol.

export type AiStatus = "off" | "loading" | "downloading" | "ready" | "error";

type Listener = (status: AiStatus, progress: { loaded: number; total: number } | null) => void;

let worker: Worker | null = null;
let status: AiStatus = "off";
let seq = 0;
const pending = new Map<number, { res: (s: number[]) => void; rej: (e: Error) => void }>();
const listeners = new Set<Listener>();
let progressCb: ((loaded: number, total: number) => void) | null = null;

function setStatus(s: AiStatus, progress: { loaded: number; total: number } | null = null) {
  status = s;
  for (const l of listeners) l(status, progress);
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
          setStatus("error");
        }
      }
    };
    worker.onerror = () => setStatus("error");
  }
  return worker;
}

export const reranker = {
  get status(): AiStatus {
    return status;
  },

  onStatus(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  /// Spawn the worker and start model load/download. Progress callbacks fire
  /// while the ~280 MB model downloads (first enable only; OPFS after that).
  enable(onProgress?: (loaded: number, total: number) => void) {
    progressCb = onProgress ?? null;
    setStatus("loading");
    ensureWorker().postMessage({ type: "init" });
  },

  disable() {
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
      pending.set(id, { res, rej });
      ensureWorker().postMessage({ type: "score", id, query, texts });
    });
  },
};
