# Contributing

Thanks for your interest. This project stays intentionally small — changes
should keep it fast, readable, and dependency-light.

## Setup

```sh
npm install
npm run dev                 # frontend only

# full stack (Worker + assets): requires a LangSearch key
npm run build && echo "LANGSEARCH_API_KEY=sk-..." > .dev.vars && npx wrangler dev
```

Rust/WASM work needs a Rust toolchain and `wasm-pack`:

```sh
cargo test --manifest-path crates/search-core/Cargo.toml
npm run wasm                # rebuilds public/engine/
```

CI rebuilds the WASM artifact on every push, so committing
`public/engine/` output is unnecessary.

## Conventions

- **TypeScript**: strict mode; `npm run build` must pass (it runs `tsc
  --noEmit`). Match the existing style — small functions, no comments
  unless they explain *why*.
- **Rust**: keep the engine allocation-lean and panic-free on malformed
  input (it parses untrusted API JSON). `cargo test` must pass.
- **Worker**: `/api/search` responses must keep conforming to the
  `SearchResponse` contract in `src/api.ts` — the frontend and any API
  consumers depend on it.
- **Dependencies**: prefer none. If one is truly needed, pin a version
  at least a week old.

## Where things live

| Want to change… | Look in |
| --- | --- |
| Ranking / intent / highlighting | `crates/search-core/src/` |
| Upstream calls, caching, query rescue | `src/worker/` |
| UI and interaction | `src/components/`, `src/hooks/` |
| Request/response shape | `src/api.ts` (shared contract) |

## Testing a ranking change

```sh
# dump real upstream results, then rerank them locally
curl -s https://api.langsearch.com/v1/web-search \
  -H "Authorization: Bearer $LANGSEARCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"your query","count":30}' \
  | jq '.data.webPages.value' > /tmp/results.json

cd crates/search-core
cargo run --example rerank "your query" < /tmp/results.json
```

## Pull requests

- One concern per PR; describe the *why*, not just the *what*.
- No secrets in commits — the LangSearch key lives in repository secrets
  and `.dev.vars` (gitignored).
- Every push to `main` deploys to production, so PRs get review before
  merge.
