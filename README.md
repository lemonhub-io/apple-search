# Search

[![Deploy](https://github.com/lemonhub-io/apple-search/actions/workflows/deploy.yml/badge.svg)](https://github.com/lemonhub-io/apple-search/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![Live](https://img.shields.io/badge/live-asearch.world-black.svg)](https://asearch.world)

A minimal, monochrome web search engine. React + TypeScript + Vite on the
front, a Rust → WebAssembly result engine, and a Cloudflare Worker proxying
the [LangSearch](https://langsearch.com) Web Search API.

## Features

- **Intent-aware ranking** — queries are classified (navigate / learn /
  fresh / general; a bare single-token query counts as navigational) and
  rescored client-side with BM25, phrase matching, a provider-order prior,
  and intent-conditioned boosts. Navigational queries get structural
  destination signals: entity-in-domain matching at label granularity,
  modifier-in-path (`github login` → `github.com/login`), canonical
  shallow-path preference, and demotion of deep listing pages and
  parameter-bloated URLs.
- **Structural quality prior** — no domain whitelists: spam reveals itself
  through hyphen-chained/digit-spiked domains, punycode, keyword-stuffed
  titles (which also lose BM25 weight), thin or fragment-soup extracts, and
  compounding signals; restricted namespaces (.edu/.gov/.mil) get credit.
- **Readable snippets** — instead of raw DOM text, the engine scores each
  sentence by query-term coverage and returns the best passage extended
  forward, skipping navigation chrome like "Pinned Discussions".
- **Honest dates** — upstream `datePublished` is often stale crawl
  metadata, so labels are relative only inside a week ("Today",
  "3 days ago") and absolute ("Sep 14") beyond it — no fake precision.
- **Search operators** — `site:example.com` / `-site:example.com` map to
  LangSearch `includeDomains`/`excludeDomains`; `"exact phrase"` boosts
  verbatim containment; `-term` drops matching documents.
- **Query rescue** — the Worker widens freshness windows that starve a
  query and fans out a simplified fallback query when the upstream index
  returns too few candidates; transient upstream failures get one bounded
  jittered retry.
- **Edge-cached** — identical searches share a canonical cache entry at
  the Cloudflare edge for 5 minutes.
- **Installable PWA** — service worker precaches the app shell and the
  WASM engine; offline shell, install prompt, share target, persisted
  light/dark theme.
- **Keyboard-first** — `/` focuses the field, `Esc` clears, `?q=` deep
  links work, browser history is navigable.

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

## API

`GET /api/search` — JSON; the SPA consumes it, but it's usable directly.

| Parameter | Default | Notes |
| --- | --- | --- |
| `q` | *(required)* | Query string, capped at 300 chars |
| `count` | `50` | Upstream candidates fetched, `1`–`50` |
| `freshness` | inferred | `noLimit`, `oneDay`, `oneWeek`, `oneMonth`, `oneYear`; omit to let the worker infer from recency language |

Response: `query` (the operator-stripped form sent upstream),
`freshness` (effective), `freshness_requested`, `expanded` (a simplified
fallback query contributed results), `candidates`, `results[]` (`id`,
`name`, `url`, `displayUrl`, `snippet`, `summary`, `datePublished`),
`usage`, `took_ms`. Errors return `{ "error": "…" }` with a matching HTTP
status. `x-cache: HIT|MISS` marks edge-cache hits.

### Query syntax

| Operator | Example | Effect |
| --- | --- | --- |
| `site:` | `workers site:cloudflare.com` | Only results from that domain (subdomains included) |
| `-site:` | `rust -site:reddit.com` | Exclude a domain |
| `"…"` | `"edge compute platform"` | Exact-phrase boost |
| `-` | `rust -game` | Drop documents containing the term |

Operators are stripped before the upstream call (the index treats them as
literal text) and re-applied by the local ranking engine.

## Development

```sh
npm install
npm run wasm     # requires wasm-pack and Rust; results are processed only by this build
npm run dev      # vite dev server (frontend only)

# full local worker preview (needs dist + a LangSearch key)
npm run build && npx wrangler dev
echo "LANGSEARCH_API_KEY=sk-..." > .dev.vars

# rust engine tests
cargo test --manifest-path crates/search-core/Cargo.toml
```

## Deployment

GitHub Actions (`.github/workflows/deploy.yml`) builds the WASM engine,
bundles the frontend, and deploys with `wrangler` on every push to `main`.

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler deploys (Workers edit permission) |
| `CLOUDFLARE_ACCOUNT_ID` | Target account |
| `LANGSEARCH_API_KEY` | [LangSearch dashboard](https://langsearch.com/dashboard) → API keys |

The workflow also pushes `LANGSEARCH_API_KEY` into the Worker on each run,
so rotating the secret is a re-run away. The Worker serves
`https://asearch.world` (custom domain; `workers.dev` is disabled).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © LemonStudio-hub
