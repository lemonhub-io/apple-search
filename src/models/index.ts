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

function headers(key: string): Headers {
  const h = new Headers();
  h.set("Content-Type", contentType(key));
  // Objects are immutable — versioned content, safe to cache forever.
  h.set("Cache-Control", "public, max-age=31536000, immutable");
  // Browser fetches come cross-origin from asearch.world.
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");
  h.set("Accept-Ranges", "bytes");
  h.set("X-Content-Type-Options", "nosniff");
  return h;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headers(url.pathname) });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const key = decodeURIComponent(url.pathname.slice(1));
    if (!key.startsWith(KEY_PREFIX) || key.includes("..")) {
      return new Response("Not found", { status: 404 });
    }

    // Edge-cache full-object GETs; Range requests stream straight from R2.
    const range = req.headers.get("Range");
    if (!range) {
      const cached = await edgeCache.match(req);
      if (cached) return cached;
    }

    let obj: R2ObjectBody | null;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) return new Response("Invalid range", { status: 416 });
      const offset = Number(m[1]);
      const length = m[2] === "" ? undefined : Number(m[2]) - offset + 1;
      obj = await env.MODELS.get(key, { range: { offset, length } });
    } else {
      obj = await env.MODELS.get(key);
    }
    if (!obj) return new Response("Not found", { status: 404 });

    const h = headers(key);
    obj.writeHttpMetadata(h);
    if (range) {
      // R2 reports the effective range regardless of request shape.
      const r = obj.range as { offset: number; end: number };
      h.set("Content-Range", `bytes ${r.offset}-${r.end}/${obj.size}`);
      h.set("Content-Length", String(r.end - r.offset + 1));
    } else {
      h.set("Content-Length", String(obj.size));
    }

    const res = new Response(req.method === "HEAD" ? null : obj.body, {
      status: range ? 206 : 200,
      headers: h,
    });
    if (!range) ctx.waitUntil(edgeCache.put(req, res.clone()));
    return res;
  },
} satisfies ExportedHandler<Env>;
