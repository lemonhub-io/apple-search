import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const icons = [
  { src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" as const },
  { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" as const },
  { src: "pwa-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" as const },
  { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" as const },
];

export default defineConfig({
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
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,wasm}"],
        navigateFallback: "index.html",
        // API and engine wasm must never fall back to the SPA.
        navigateFallbackDenylist: [/^\/api\//, /^\/engine\//],
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
  },
});
