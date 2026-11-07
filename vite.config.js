import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';

// Files from public/ the installed app needs offline (they are not in the bundle).
const PUBLIC_FILES = [
  '/', '/site.webmanifest', '/favicon.ico', '/favicon-32.png',
  '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/mark-72.png',
];

/**
 * Writes /sw.js from src/sw.js with the list of files to cache on install: everything
 * in the build except the 3D viewer (cached on first use instead, it is ~12 MB) and
 * the fonts' .woff fallbacks and non-Latin subsets, which the page never asks for.
 */
function serviceWorker() {
  return {
    name: 'hullpatch-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const built = Object.keys(bundle)
        .filter((f) => f !== 'index.html')
        .filter((f) => !/(^|\/)f3d-/.test(f))
        .filter((f) => /\.(js|css)$/.test(f) || /-latin(-ext)?-\d+-normal-[^/]+\.woff2$/.test(f))
        .map((f) => '/' + f)
        .sort();
      const precache = [...PUBLIC_FILES, ...built];

      const hash = createHash('sha256');
      for (const f of Object.keys(bundle).sort()) {
        const item = bundle[f];
        hash.update(f).update(item.type === 'chunk' ? item.code : item.source);
      }
      const version = hash.digest('hex').slice(0, 12);

      const source = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// Hullpatch is a single static page; the repair runs in a module worker.
export default defineConfig({
  base: '/',
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [serviceWorker()],
});
