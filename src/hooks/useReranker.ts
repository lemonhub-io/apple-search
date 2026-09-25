import { useCallback, useEffect, useRef, useState } from "react";
import { reranker, type AiStatus } from "../ai/reranker";

const FLAG = "ai-rerank"; // localStorage: "on" once the user enabled it

export interface RerankerState {
  status: AiStatus;
  enabled: boolean;
  progress: number | null; // 0..1 while downloading
  enable: () => void;
  disable: () => void;
  /// Score the stage-1 top results; returns logits aligned to the raw
  /// candidate array (null where unscored), or null when AI is off.
  rescore: (query: string, candidates: { url: string; name: string | null; snippet: string | null }[], topUrls: string[]) => Promise<(number | null)[] | null>;
}

/// React wrapper around the reranker worker singleton. When the user has
/// enabled AI ranking, the model is re-opened from OPFS on every visit —
/// no download, just a short init.
export function useReranker(): RerankerState {
  const [status, setStatus] = useState<AiStatus>(reranker.status);
  const [progress, setProgress] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(() => localStorage.getItem(FLAG) === "on");
  const enabling = useRef(false);

  useEffect(
    () =>
      reranker.onStatus((s, p) => {
        setStatus(s);
        setProgress(p && p.total > 0 ? p.loaded / p.total : null);
        if (s === "ready") {
          localStorage.setItem(FLAG, "on");
          setEnabled(true);
        } else if (s === "error" || s === "off") {
          enabling.current = false;
        }
      }),
    [],
  );

  // Returning visit with AI enabled → warm the model from OPFS.
  useEffect(() => {
    if (enabled && reranker.status === "off" && !enabling.current) {
      enabling.current = true;
      reranker.enable();
    }
  }, [enabled]);

  const enable = useCallback(() => {
    enabling.current = true;
    reranker.enable();
  }, []);

  const disable = useCallback(() => {
    localStorage.removeItem(FLAG);
    setEnabled(false);
    reranker.disable();
  }, []);

  const rescore: RerankerState["rescore"] = useCallback(async (query, candidates, topUrls) => {
    if (reranker.status !== "ready") return null;
    // Score the stage-1 top results only — quality where it matters,
    // bounded latency on weak devices.
    const wanted = new Set(topUrls);
    const texts: string[] = [];
    const idx: number[] = [];
    candidates.forEach((c, i) => {
      if (wanted.has(c.url)) {
        idx.push(i);
        texts.push(`${c.name ?? ""}. ${(c.snippet ?? "").slice(0, 400)}`);
      }
    });
    if (!texts.length) return null;
    const scores = await reranker.score(query, texts);
    if (scores.length !== texts.length) return null;
    const out: (number | null)[] = new Array(candidates.length).fill(null);
    idx.forEach((rawIdx, j) => {
      out[rawIdx] = scores[j];
    });
    return out;
  }, []);

  return { status, enabled, progress, enable, disable, rescore };
}
