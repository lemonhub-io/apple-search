// Copies ONNX Runtime Web's wasm artifacts into public/ort/<version> so the
// AI reranker worker can load them at runtime. The versioned path makes them
// safely immutable/cache-first. Runs automatically before `vite`/`vite build`.
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "node_modules/onnxruntime-web/dist");
const { version } = JSON.parse(
  readFileSync(join(root, "node_modules/onnxruntime-web/package.json"), "utf8"),
);
const out = join(root, "public/ort", version);

mkdirSync(out, { recursive: true });
let copied = 0;
for (const f of readdirSync(dist)) {
  // wasm backend files only — jsep.* is the WebGPU path we don't use.
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(f) && !f.includes("jsep")) {
    cpSync(join(dist, f), join(out, f));
    copied++;
  }
}
console.log(`copy-ort: ${copied} files → public/ort/${version}`);
