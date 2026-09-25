// Result post-processing. The Rust engine is compiled to WebAssembly
// (wasm-pack → public/engine) and loaded at runtime.

import type { ApiResult } from "./api";

export type { ApiResult };

export interface Segment {
  text: string;
  mark: boolean;
}

export interface UiResult {
  id: string;
  title: Segment[];
  url: string;
  display: string;
  host: string;
  date: string | null;
  snippet: Segment[];
  score: number;
}

export interface Processed {
  results: UiResult[];
  intent: string;
  ms: number;
}

interface WasmEngine {
  default: (input?: unknown) => Promise<unknown>;
  process_results: (query: string, now_ms: number, raw_json: string) => string;
}

const ENGINE_URL = "/engine/search_core.js";

let enginePromise: Promise<WasmEngine> | null = null;

function loadEngine(): Promise<WasmEngine> {
  enginePromise ??= importEngine().catch((err: unknown) => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

async function importEngine(): Promise<WasmEngine> {
  try {
    // Dev servers refuse to import() modules straight out of /public — fetch
    // the glue and import it as a blob module instead. Its wasm is passed by
    // URL so the blob's import.meta.url never enters resolution.
    const res = await fetch(ENGINE_URL);
    if (!res.ok) throw new Error(String(res.status));
    const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }));
    let mod: WasmEngine;
    try {
      mod = (await import(/* @vite-ignore */ blobUrl)) as WasmEngine;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    await mod.default({
      module_or_path: new URL("/engine/search_core_bg.wasm", location.origin).href,
    });
    return mod;
  } catch {
    throw new Error("Search engine is unavailable.");
  }
}

if (typeof requestIdleCallback === "function") {
  requestIdleCallback(() => void loadEngine().catch(() => {}));
} else {
  setTimeout(() => void loadEngine().catch(() => {}), 1500);
}

export function cleanQuery(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 300);
}

/// Process raw upstream results through the WASM engine.
export async function processResults(
  query: string,
  apiResults: ApiResult[],
): Promise<Processed> {
  const t0 = performance.now();
  const wasm = await loadEngine();
  const out = wasm.process_results(query, Date.now(), JSON.stringify(apiResults));
  const parsed = JSON.parse(out) as { results: UiResult[]; intent: string };
  return { results: parsed.results, intent: parsed.intent ?? "general", ms: performance.now() - t0 };
}
