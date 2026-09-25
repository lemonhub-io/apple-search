import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");

const rounded = (size) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#ffffff" stroke="#e5e5ea" stroke-width="1.5"/>
  <circle cx="28" cy="28" r="12" fill="none" stroke="#000000" stroke-width="5"/>
  <line x1="37" y1="37" x2="48" y2="48" stroke="#000000" stroke-width="5" stroke-linecap="round"/>
</svg>`;

const maskable = (size) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#ffffff"/>
  <g transform="translate(96 96) scale(5)">
    <circle cx="28" cy="28" r="12" fill="none" stroke="#000000" stroke-width="5"/>
    <line x1="37" y1="37" x2="48" y2="48" stroke="#000000" stroke-width="5" stroke-linecap="round"/>
  </g>
</svg>`;

async function png(name, svg) {
  const file = resolve(publicDir, name);
  await mkdir(dirname(file), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(file);
  console.log(name);
}

await png("favicon-32.png", rounded(32));
await png("apple-touch-icon.png", maskable(180));
await png("pwa-192.png", rounded(192));
await png("pwa-512.png", rounded(512));
await png("pwa-maskable-192.png", maskable(192));
await png("pwa-maskable-512.png", maskable(512));
