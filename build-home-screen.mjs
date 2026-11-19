// Builds docs/ (the folder GitHub Pages serves), the installable iPad home screen version of the game, from index.html (the artifact source).
// Run: node build-home-screen.mjs   Safe to rerun: it rebuilds docs/ from scratch and the output is byte-identical.
// Needs Node 18 or newer and nothing else. The font comes from vendor/baloo2, so the build never touches the network.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, 'docs');
const APP_NAME = 'Gel Lan Buraya';
const FONT_FILE = 'Baloo2-latin.woff2';
const FONT_LATIN_RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const ICONS = [
  { file: 'icons/apple-touch-icon-180.png', size: 180, purpose: null },
  { file: 'icons/icon-192.png', size: 192, purpose: 'any' },
  { file: 'icons/icon-512.png', size: 512, purpose: 'any' },
  { file: 'icons/icon-maskable-512.png', size: 512, purpose: 'maskable' },
];

/* ---------- Reading the artifact source ---------- */

function splitArtifact(source) {
  const styleStart = source.indexOf('<style>'), styleEnd = source.indexOf('</style>');
  if (!source.startsWith('<title>') || styleStart < 0 || styleEnd < styleStart) {
    throw new Error('index.html is not in the expected artifact format: it should start with <title>, then metas, then one <style> block, then the markup and script. Restore that order and rerun.');
  }
  const head = source.slice(0, styleStart);
  if (!head.includes('fonts.googleapis.com')) {
    throw new Error('index.html no longer links the Google Fonts stylesheet before <style>. The build swaps that link for the bundled Baloo 2 font; update build-home-screen.mjs to match the new font setup.');
  }
  return { style: source.slice(styleStart, styleEnd + '</style>'.length), body: source.slice(styleEnd + '</style>'.length).trim() };
}

function readTokens(style) {
  const tokens = {};
  for (const m of style.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]] = m[2].toLowerCase();
  for (const name of ['bg', 'sky-top', 'sky-low', 'star', 'moon', 'noah', 'noah-dark', 'skin', 'cheek', 'hair', 'ink', 'blanket', 'blanket-2', 'pillow', 'text', 'accent']) {
    if (!tokens[name]) throw new Error(`The color token --${name} is missing from index.html :root. The icons and theme color are drawn from it; add it back or update the build.`);
  }
  return tokens;
}

/* ---------- Icons: a tiny supersampled rasterizer and PNG encoder ---------- */

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const polygon = (pts) => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const roundTop = (x0, y0, x1, y1, r) => (x, y) => rect(x0, y0 + r, x1, y1)(x, y) || rect(x0 + r, y0, x1 - r, y1)(x, y) || circle(x0 + r, y0 + r, r)(x, y) || circle(x1 - r, y0 + r, r)(x, y);

// Noah peeking over the blanket: same palette and round-face style as the game's characters.
// scale shrinks the character toward the centre so a maskable icon keeps him inside the safe zone.
function iconLayers(t, scale) {
  const s = (v) => 0.5 + (v - 0.5) * scale;
  const c = (x, y, r) => circle(s(x), s(y), r * scale);
  const e = (x, y, rx, ry) => ellipse(s(x), s(y), rx * scale, ry * scale);
  const blanketTop = s(0.66);
  return [
    { shape: c(0.84, 0.17, 0.075), color: hex(t.moon) },
    ...[[0.14, 0.14], [0.27, 0.07], [0.62, 0.1], [0.1, 0.36], [0.9, 0.42], [0.72, 0.3]].map(([x, y]) => ({ shape: circle(x, y, 0.012), color: hex(t.star) })),
    { shape: c(0.5, 0.6, 0.31), color: hex(t['noah-dark']) },
    { shape: c(0.5, 0.585, 0.285), color: hex(t.noah) },
    { shape: c(0.5, 0.555, 0.205), color: hex(t.skin) },
    { shape: polygon([[s(0.36), s(0.42)], [s(0.45), s(0.3)], [s(0.5), s(0.38)], [s(0.58), s(0.29)], [s(0.64), s(0.42)]]), color: hex(t.hair) },
    { shape: c(0.425, 0.53, 0.045), color: hex(t.pillow) },
    { shape: c(0.575, 0.53, 0.045), color: hex(t.pillow) },
    { shape: c(0.415, 0.515, 0.024), color: hex(t.ink) },
    { shape: c(0.565, 0.515, 0.024), color: hex(t.ink) },
    { shape: e(0.375, 0.6, 0.035, 0.022), color: mix(hex(t.skin), hex(t.cheek), 0.6) },
    { shape: e(0.625, 0.6, 0.035, 0.022), color: mix(hex(t.skin), hex(t.cheek), 0.6) },
    { shape: roundTop(-0.02, blanketTop, 1.02, 1.02, 0.06), color: hex(t.blanket) },
    ...[0.1, 0.2, 0.3].map((dy) => ({ shape: rect(-0.02, blanketTop + dy * scale, 1.02, blanketTop + (dy + 0.04) * scale), color: hex(t['blanket-2']) })),
    { shape: e(0.36, 0.665, 0.06, 0.04), color: hex(t.skin) },
    { shape: e(0.64, 0.665, 0.06, 0.04), color: hex(t.skin) },
  ];
}

function renderIcon(size, tokens, purpose) {
  const layers = iconLayers(tokens, purpose === 'maskable' ? 0.78 : 1);
  const top = hex(tokens['sky-top']), low = hex(tokens['sky-low']);
  const SS = 4, pixels = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
          let color = mix(top, low, y);
          for (const layer of layers) if (layer.shape(x, y)) color = layer.color;
          acc[0] += color[0]; acc[1] += color[1]; acc[2] += color[2];
        }
      }
      const o = (py * size + px) * 3;
      for (let i = 0; i < 3; i++) pixels[o + i] = Math.round(acc[i] / (SS * SS));
    }
  }
  return encodePng(size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- The page, manifest and service worker ---------- */

function homeScreenPage({ style, body }, tokens) {
  return `<!doctype html>
<html lang="en" class="home-screen">
<head>
<meta charset="utf-8">
<title>${APP_NAME}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${APP_NAME}">
<meta name="application-name" content="${APP_NAME}">
<meta name="theme-color" content="${tokens.bg}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<link rel="preload" href="fonts/${FONT_FILE}" as="font" type="font/woff2" crossorigin>
<script>
// Launched from the home screen: lets the CSS show the turn-sideways card in portrait.
if (navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches) {
  document.documentElement.classList.add('standalone');
}
</script>
<style>
/* Baloo 2, bundled for offline play (SIL Open Font License, see fonts/OFL.txt). One variable file covers weights 500 to 800. */
@font-face {
  font-family: "Baloo 2";
  font-style: normal;
  font-weight: 400 800;
  font-display: swap;
  src: url("fonts/${FONT_FILE}") format("woff2");
  unicode-range: ${FONT_LATIN_RANGE};
}
</style>
${style}
<style>
/* Home screen build only. Outside the artifact host nothing pads for the notch and home indicator, so do it here. */
html.home-screen { background: var(--bg); }
html.home-screen body { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
.rotateCard {
  display: none; position: fixed; inset: 0; z-index: 50;
  flex-direction: column; align-items: center; justify-content: center; gap: 28px;
  padding: 24px; text-align: center; background: var(--bg); color: var(--text); font-family: var(--font);
}
.rotateCard h1 { margin: 0; font-size: 2.6rem; line-height: 1.1; color: var(--accent); }
.rotateCard p { margin: 0; font-size: 1.4rem; color: var(--muted); }
.rotateCard svg { width: 180px; height: 180px; animation: tilt 2.4s ease-in-out infinite; }
@keyframes tilt { 0%, 30% { transform: rotate(0deg); } 60%, 100% { transform: rotate(-90deg); } }
@media (prefers-reduced-motion: reduce) { .rotateCard svg { animation: none; transform: rotate(-90deg); } }
@media (orientation: portrait) {
  html.home-screen.standalone .rotateCard { display: flex; }
  html.home-screen.standalone #rotateHint { display: none; }
}
</style>
</head>
<body>
${body}
<div class="rotateCard" id="rotateCard" role="alert">
  <svg viewBox="0 0 120 120" aria-hidden="true">
    <rect x="34" y="14" width="52" height="92" rx="10" fill="none" stroke="var(--text)" stroke-width="6"/>
    <circle cx="60" cy="96" r="4" fill="var(--text)"/>
  </svg>
  <h1>Turn the iPad sideways</h1>
  <p>${APP_NAME} plays with the iPad lying long side down.</p>
</div>
<script>
// Offline play: the service worker keeps every file of the game on the iPad after the first visit.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline play is not set up yet; the game still works online.', err));
  });
}
</script>
</body>
</html>
`;
}

function manifest(tokens) {
  return JSON.stringify({
    name: APP_NAME,
    short_name: APP_NAME,
    description: 'A bedtime escape game by Baba and Noah',
    start_url: './',
    scope: './',
    display: 'standalone',
    display_override: ['fullscreen', 'standalone'],
    orientation: 'landscape',
    background_color: tokens.bg,
    theme_color: tokens.bg,
    icons: ICONS.filter((i) => i.purpose).map((i) => ({ src: i.file, sizes: `${i.size}x${i.size}`, type: 'image/png', purpose: i.purpose })),
  }, null, 2) + '\n';
}

function serviceWorker(files, version) {
  return `// Generated by build-home-screen.mjs. Cache-first, so the game starts with the network off after one visit.
const CACHE = 'gel-lan-buraya-${version}';
const FILES = ${JSON.stringify(['./', ...files], null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('gel-lan-buraya-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request)));
});
`;
}

/* ---------- Build ---------- */

function listFiles(dir, prefix = '') {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = path.join(dir, name), rel = prefix + name;
    return statSync(full).isDirectory() ? listFiles(full, rel + '/') : [rel];
  });
}

function write(rel, data) {
  const full = path.join(SITE, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, data);
}

function build() {
  const source = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const parts = splitArtifact(source), tokens = readTokens(parts.style);
  rmSync(SITE, { recursive: true, force: true });
  write('index.html', homeScreenPage(parts, tokens));
  write('manifest.webmanifest', manifest(tokens));
  write(`fonts/${FONT_FILE}`, readFileSync(path.join(ROOT, 'vendor/baloo2', FONT_FILE)));
  write('fonts/OFL.txt', readFileSync(path.join(ROOT, 'vendor/baloo2/OFL.txt')));
  for (const icon of ICONS) write(icon.file, renderIcon(icon.size, tokens, icon.purpose));
  const files = listFiles(SITE);
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update(readFileSync(path.join(SITE, f)));
  const version = hash.digest('hex').slice(0, 12);
  write('sw.js', serviceWorker([...files, 'sw.js'].sort(), version));
  console.log(`Built ${path.relative(ROOT, SITE)}/ (${files.length + 1} files, cache gel-lan-buraya-${version}).`);
}

build();
