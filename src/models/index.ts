// Download worker for models.asearch.world — serves AI model artifacts from
// the apple-search-models R2 bucket. Objects are stored under HF-style keys
// (org/repo/resolve/rev/path) so transformers.js works by just pointing
// env.remoteHost at this origin. No .workers.dev — custom domain only.

interface Env {
  MODELS: R2Bucket;
}

// Workers' edge cache — DOM lib types `caches` as plain CacheStorage.
const edgeCache = (caches as unknown as { default: Cache }).default;

const KEY_PREFIX = "jinaai/"; // only our model artifacts are servable

const TYPES: Record<string, string> = {
  ".onnx": "application/octet-stream",
  ".json": "application/json",
  ".model": "application/octet-stream",
};

function contentType(key: string): string {
  const ext = key.slice(key.lastIndexOf("."));
  return TYPES[ext] ?? "application/octet-stream";
}

// CORS travels on every response — including 404s. transformers.js probes
// optional artifact paths, and an opaque CORS-blocked error reads as
// "fetch failed" rather than "file absent".
function baseHeaders(): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  h.set("X-Content-Type-Options", "nosniff");
  return h;
}

function objectHeaders(key: string): Headers {
  const h = baseHeaders();
  h.set("Content-Type", contentType(key));
  // Objects are immutable — versioned content, safe to cache forever.
  h.set("Cache-Control", "public, max-age=31536000, immutable");
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");
  h.set("Accept-Ranges", "bytes");
  return h;
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: baseHeaders() });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      const h = baseHeaders();
      h.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers: h });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: baseHeaders() });
    }

    const key = decodeURIComponent(url.pathname.slice(1));
    if (!key.startsWith(KEY_PREFIX) || key.includes("..")) {
      return notFound();
    }

    // Only "bytes=start-end" / "bytes=start-" forms are needed by the client.
    const rangeHeader = req.headers.get("Range");
    let offset: number | null = null;
    let length: number | undefined;
    if (rangeHeader) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (!m || (m[2] !== "" && Number(m[2]) < Number(m[1]))) {
        return new Response("Invalid range", { status: 416, headers: baseHeaders() });
      }
      offset = Number(m[1]);
      length = m[2] === "" ? undefined : Number(m[2]) - offset + 1;
    }
    const ranged = offset !== null;

    // Edge-cache full-object GETs only; Range requests stream straight from
    // R2 (the 280 MB model should not be cached piecemeal).
    if (!ranged && req.method === "GET") {
      const cached = await edgeCache.match(req);
      if (cached) return cached;
    }

    let res: Response;
    if (req.method === "HEAD") {
      // head() avoids pulling the object body — metadata only.
      const meta = await env.MODELS.head(key);
      if (!meta) return notFound();
      const h = objectHeaders(key);
      meta.writeHttpMetadata(h);
      if (offset === null) {
        h.set("Content-Length", String(meta.size));
      } else {
        if (offset >= meta.size) {
          return new Response("Invalid range", { status: 416, headers: baseHeaders() });
        }
        const end = Math.min(meta.size - 1, offset + (length ?? meta.size - offset) - 1);
        h.set("Content-Range", `bytes ${offset}-${end}/${meta.size}`);
        h.set("Content-Length", String(end - offset + 1));
      }
      res = new Response(null, { status: ranged ? 206 : 200, headers: h });
    } else {
      const obj = offset === null
        ? await env.MODELS.get(key)
        : await env.MODELS.get(key, { range: { offset, length } });
      if (!obj) return notFound();
      const h = objectHeaders(key);
      obj.writeHttpMetadata(h);
      if (ranged) {
        // R2 reports the effective range regardless of request shape.
        const r = obj.range as { offset: number; end: number };
        h.set("Content-Range", `bytes ${r.offset}-${r.end}/${obj.size}`);
        h.set("Content-Length", String(r.end - r.offset + 1));
      } else {
        h.set("Content-Length", String(obj.size));
      }
      res = new Response(obj.body, { status: ranged ? 206 : 200, headers: h });
    }

    if (!ranged && req.method === "GET") ctx.waitUntil(edgeCache.put(req, res.clone()));
    return res;
  },
} satisfies ExportedHandler<Env>;
