// AI reranker worker — owns the whole model lifecycle off the main thread:
// download (with progress) → OPFS persistence → ONNX Runtime Web session
// (WASM; SIMD + threads when cross-origin isolation allows) → cross-encoder
// scoring of (query, document) pairs.
//
// Protocol (postMessage):
//   in : {type:"init"} | {type:"score", id, query, texts}
//   out: {type:"progress", loaded, total} | {type:"ready", cached}
//        {type:"scores", id, scores} | {type:"error", stage, message}

import * as ort from "onnxruntime-web";
import { AutoTokenizer, env } from "@huggingface/transformers";
import {
  BATCH,
  MAX_LEN,
  MODEL_BYTES,
  MODEL_HOST,
  MODEL_URL,
  OPFS_NAME,
  REPO,
} from "./model";

const DOWNLOAD_ATTEMPTS = 2;

// vite `define` — the installed onnxruntime-web version; matches the
// directory scripts/copy-ort.mjs writes under public/ort/.
declare const __ORT_VERSION__: string;

// DOM lib's `self` is a Window; this file runs as a dedicated worker.
const scope = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  readonly crossOriginIsolated: boolean;
};

let session: ort.InferenceSession | null = null;
let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let initPromise: Promise<void> | null = null;

async function ensureSession() {
  initPromise ??= init().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

async function init() {
  // ORT wasm artifacts live in /ort/<version> (copied from the package at
  // build time). Threads need SharedArrayBuffer → only under
  // crossOriginIsolated; otherwise ort runs the same binary single-threaded.
  ort.env.wasm.wasmPaths = `/ort/${__ORT_VERSION__}/`;
  ort.env.wasm.numThreads = scope.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1;
  env.allowLocalModels = false;
  // Tokenizer files are served from our bucket in HF repo layout
  // (trailing slash — env builds `${remoteHost}{model}/resolve/{rev}/...`).
  env.remoteHost = `${MODEL_HOST}/`;

  const bytes = await modelBytes();
  const t0 = performance.now();
  session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });

  // Tokenizer (~17 MB) — transformers.js caches it in the browser Cache.
  tokenizer = await AutoTokenizer.from_pretrained(REPO);
  post({ type: "ready", load_ms: Math.round(performance.now() - t0) });
}

/// Model bytes: OPFS first (persistent, on-device), else download with
/// progress and persist for next launch.
async function modelBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const cached = await opfsRead();
  if (cached) return cached;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const bytes = await download(MODEL_URL);
      void opfsWrite(bytes).catch(() => {}); // persist async; session can start now
      return bytes;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Model download failed");
}

/// Stream the model into a single preallocated buffer (Content-Length is
/// always set by the model worker), reporting progress per chunk. A short
/// or truncated body is an error — never silently accepted.
async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || MODEL_BYTES;
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.byteLength > out.length) {
      throw new Error(`Model larger than expected (${total} bytes)`);
    }
    out.set(value, loaded);
    loaded += value.byteLength;
    post({ type: "progress", loaded, total });
  }
  if (loaded !== out.length) {
    throw new Error(`Truncated model (${loaded}/${out.length} bytes)`);
  }
  return out;
}

/// OPFS read — validates the exact expected size so a partial write from a
/// killed download is deleted and re-fetched instead of crashing ONNX.
async function opfsRead(): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(OPFS_NAME);
    const file = await fh.getFile();
    if (file.size !== MODEL_BYTES) {
      await dir.removeEntry(OPFS_NAME).catch(() => {});
      return null;
    }
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function opfsWrite(bytes: Uint8Array<ArrayBuffer>) {
  try {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(OPFS_NAME, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    // Verify what actually landed — quota or a killed session can leave a
    // short file that would masquerade as a good cache entry.
    if ((await fh.getFile()).size !== bytes.length) {
      await dir.removeEntry(OPFS_NAME).catch(() => {});
    }
  } catch {
    // Quota or browser limitation — model simply re-downloads next time.
  }
}

/// Score (query, text) pairs → relevance logits, in batches.
async function score(id: number, query: string, texts: string[]) {
  if (!session || !tokenizer) throw new Error("model not ready");
  const scores = new Float32Array(texts.length);
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const enc = await tokenizer(Array(batch.length).fill(query), {
      text_pair: batch,
      padding: true,
      truncation: true,
      max_length: MAX_LEN,
    });
    const dims = enc.input_ids.dims;
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", enc.input_ids.data as BigInt64Array, dims),
      attention_mask: new ort.Tensor("int64", enc.attention_mask.data as BigInt64Array, dims),
    };
    const out = await session.run(feeds);
    const logits = out.logits.data as Float32Array;
    for (let j = 0; j < batch.length; j++) scores[i + j] = logits[j];
  }
  post({ type: "scores", id, scores: Array.from(scores) });
}

function post(msg: unknown) {
  scope.postMessage(msg);
}

scope.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "init") {
    ensureSession().catch((err: unknown) =>
      post({ type: "error", stage: "init", message: err instanceof Error ? err.message : String(err) }),
    );
  } else if (m.type === "score") {
    ensureSession()
      .then(() => score(m.id, m.query, m.texts))
      .catch((err: unknown) =>
        post({ type: "error", stage: "score", id: m.id, message: err instanceof Error ? err.message : String(err) }),
      );
  }
};

export {};
