import type { Env } from "./env";
import { json } from "./http";
import { handleSearch } from "./search";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/search") {
      if (request.method === "HEAD") {
        // Cheap availability probe — no upstream call, mirrors GET's shape.
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      }
      if (request.method !== "GET") {
        return json(
          { error: "Method not allowed." },
          { status: 405, headers: { allow: "GET, HEAD" } },
        );
      }
      return handleSearch(url, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) {
      // API misses get JSON, not the SPA fallback HTML.
      return json({ error: "Not found." }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
