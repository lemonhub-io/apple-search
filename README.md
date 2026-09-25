# Search

A minimal, monochrome web search engine. React + TypeScript + Vite on the front,
a Rust → WebAssembly result engine, and a Cloudflare Worker proxying the
[LangSearch](https://langsearch.com) Web Search API.

## Architecture

```
Browser ──► Cloudflare Worker ──► LangSearch API
   │              │
   │              └── serves the static SPA (Workers Static Assets)
   └── /api/search ─ JSON, edge-cached for 5 min

Rust (crates/search-core) ──wasm-pack──► public/engine ──► runs in the browser:
URL deduplication, per-host capping, intent-aware BM25 ranking, term
highlighting, relative-date labels.
```

## Layout

```
src/
  api.ts              — fetchSearch() + the shared /api/search response contract
  engine.ts           — lazy-loads the WebAssembly engine
  lib/platform.ts     — theme, standalone-mode, and deep-link helpers
  hooks/              — useSearch, useTheme, useOnline, useInstallPrompt
  components/         — Nav, SearchBox, Results, Skeleton, icons
  worker/
    index.ts          — router (GET /api/search → handleSearch, else assets)
    search.ts         — validate → edge-cache → upstream → rescue → respond
    langsearch.ts     — LangSearch API client
    query.ts          — freshness inference + fallback-query simplification
    http.ts, env.ts   — json() helper, bindings
crates/search-core/src/
  lib.rs              — wasm-bindgen API + pipeline orchestration
  model.rs            — RawResult → Doc collection (dedupe, per-host cap)
  rank.rs             — BM25 + provider prior + intent boosts
  intent.rs           — navigate / learn / fresh / general classification
  highlight.rs        — term → marked segments
  text.rs, url.rs, date.rs — tokenize/truncate, URL forms, relative dates
  examples/rerank.rs  — rank a real API dump locally:
                        cargo run --example rerank "query" < results.json
```

## Development

```sh
npm install
npm run wasm     # requires wasm-pack and Rust; results are processed only by this build
npm run dev      # vite dev server (frontend only)

# full local worker preview (needs dist + a LangSearch key)
npm run build && npx wrangler dev
echo "LANGSEARCH_API_KEY=sk-..." > .dev.vars
```

## Deployment

GitHub Actions (`.github/workflows/deploy.yml`) builds the WASM engine, bundles
the frontend, and deploys with `wrangler` on every push to `main`.

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler deploys (Workers edit permission) |
| `CLOUDFLARE_ACCOUNT_ID` | Target account |
| `LANGSEARCH_API_KEY` | [LangSearch dashboard](https://langsearch.com/dashboard) → API keys |

The workflow also pushes `LANGSEARCH_API_KEY` into the Worker on each run, so
rotating the secret is a re-run away. The Worker serves
`https://asearch.world` (custom domain; `workers.dev` is disabled).
