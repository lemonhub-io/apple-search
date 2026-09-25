import type { Env } from "./env";
import { json } from "./http";
import { handleSearch } from "./search";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/search") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(
          { error: "Method not allowed." },
          { status: 405, headers: { allow: "GET, HEAD" } },
        );
      }
      return handleSearch(url, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
