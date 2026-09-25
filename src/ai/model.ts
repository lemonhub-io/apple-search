// Shared constants for the on-device AI reranker. Consumed by the
// inference worker (src/ai/worker.ts) and by UI that describes the model
// (Onboarding).

// jina-reranker-v2-base-multilingual — a cross-encoder that judges whether
// a document is a good result for the query (trained on relevance data),
// unlike embedding similarity which only measures overlap.
export const REPO = "jinaai/jina-reranker-v2-base-multilingual";
export const MODEL_FILE = "onnx/model_quantized.onnx"; // int8

// Self-hosted: artifacts live in R2 behind models.asearch.world — no
// huggingface.co runtime dependency (supply chain pinned to our bucket).
export const MODEL_HOST = "https://models.asearch.world";
export const MODEL_URL = `${MODEL_HOST}/${REPO}/resolve/main/${MODEL_FILE}`;

// Exact upstream byte size — OPFS entries are validated against it, so a
// truncated write (killed mid-download) is detected and re-fetched rather
// than handed to ONNX as a corrupt buffer. Also the download fallback when
// Content-Length is missing.
export const MODEL_BYTES = 279_577_152;
export const MODEL_MB = Math.round(MODEL_BYTES / 1e6);

export const OPFS_NAME = "jina-reranker-v2-q8.onnx";
export const MAX_LEN = 256;
export const BATCH = 8;
