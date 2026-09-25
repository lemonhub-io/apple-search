import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// The AI worker loads ort wasm from /ort/<version>/ (see scripts/copy-ort.mjs).
// exports map doesn't expose ./package.json — resolve the entry then walk up.
const ortEntry = createRequire(import.meta.url).resolve("onnxruntime-web");
const ortVersion: string = JSON.parse(
  readFileSync(new URL("../package.json", `file://${ortEntry}`), "utf8"),
).version;

const icons = [
  { src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" as const },
  { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" as const },
  { src: "pwa-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" as const },
  { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" as const },
];

export default defineConfig({
  define: {
    __ORT_VERSION__: JSON.stringify(ortVersion),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: [
        "favicon.svg",
        "favicon-32.png",
        "apple-touch-icon.png",
        "pwa-192.png",
        "pwa-512.png",
        "pwa-maskable-192.png",
        "pwa-maskable-512.png",
      ],
      manifest: {
        id: "/",
        name: "Search",
        short_name: "Search",
        description: "Search the web.",
        lang: "en",
        dir: "ltr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        display_override: ["standalone", "minimal-ui"],
        orientation: "any",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        categories: ["utilities"],
        prefer_related_applications: false,
        handle_links: "preferred",
        launch_handler: { client_mode: ["navigate-existing", "auto"] },
        shortcuts: [
          {
            name: "New search",
            short_name: "Search",
            url: "/",
            icons: [{ src: "pwa-192.png", sizes: "192x192", type: "image/png" }],
          },
        ],
        icons,
        share_target: {
          action: "/",
          method: "GET",
          params: { text: "q", url: "url" },
        },
        screenshots: [
          {
            src: "screenshots/wide.png",
            sizes: "1280x720",
            type: "image/png",
            form_factor: "wide",
            label: "Search",
          },
          {
            src: "screenshots/narrow.png",
            sizes: "390x844",
            type: "image/png",
            form_factor: "narrow",
            label: "Search",
          },
        ],
      },
      workbox: {
        // Keep the ~11 MB ort wasm out of precache — it is fetched lazily,
        // only when the user enables AI ranking, and cached at runtime.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,wasm}"],
        globIgnores: ["ort/**"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/engine/"),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "search-engine",
              expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // /ort/<version>/ is immutable by construction.
            urlPattern: ({ url }) => url.pathname.startsWith("/ort/"),
            handler: "CacheFirst",
            options: {
              cacheName: "ort-runtime",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      plugins: [
        {
          // onnxruntime-web references WebGPU (jsep) wasm assets by URL; the
          // wasm backend never touches them — drop the ~44 MB from the build.
          name: "strip-ort-jsep",
          generateBundle(_, bundle) {
            for (const name of Object.keys(bundle)) {
              if (name.includes("jsep")) delete bundle[name];
            }
          },
        },
      ],
    },
  },
});
