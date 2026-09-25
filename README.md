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
URL deduplication, per-host capping, blended ranking, term highlighting,
relative-date labels.
```

- `src/App.tsx` — the interface (light/dark monochrome, keyboard: `/` focus, `Esc` clear)
- `src/engine.ts` — loads the WebAssembly engine
- `src/worker.ts` — Worker: `/api/search` → LangSearch, canonical cache keys
- `crates/search-core` — the Rust engine compiled to WASM

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
