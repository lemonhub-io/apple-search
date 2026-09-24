// Result post-processing. The Rust engine is compiled to WebAssembly
// (wasm-pack → public/engine) and loaded at runtime.

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

export interface ApiResult {
  id: string | null;
  name: string | null;
  url: string;
  displayUrl: string | null;
  snippet: string | null;
  summary: string | null;
  datePublished: string | null;
}

export interface Processed {
  results: UiResult[];
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
    const mod = (await import(/* @vite-ignore */ ENGINE_URL)) as WasmEngine;
    await mod.default();
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

export async function processResults(query: string, apiResults: ApiResult[]): Promise<Processed> {
  const t0 = performance.now();
  const wasm = await loadEngine();
  const out = wasm.process_results(query, Date.now(), JSON.stringify(apiResults));
  const parsed = JSON.parse(out) as { results: UiResult[] };
  return { results: parsed.results, ms: performance.now() - t0 };
}
