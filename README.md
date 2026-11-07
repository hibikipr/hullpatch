# Hullpatch

STL repair that runs in the browser, part of [townsville.cc](https://townsville.cc).
Drop in an STL and Hullpatch closes holes, removes inside walls, turns flipped faces
outward and clears unprintable specks, so the file loads as a clean, manifold solid
in Bambu Studio. Nothing is uploaded: the repair runs in a Web Worker in the tab.

## Develop

```bash
npm install
npx vite            # dev server
npm run build       # static site in dist/
npm run test:repair # repair engine tests
```

## Layout

- `index.html`: the single page (hero, repair bay, what it fixes, FAQ).
- `src/theme.css`: townsville.cc tokens and page styles.
- `src/repair/mesh.js`: parse, weld, analyse, repair and write STL. Pure functions,
  so they run in the worker and in Node tests.
- `src/repair/worker.js`: runs read → scan → repair → re-check off the main thread.
- `src/repair/tool.js`: the repair bay UI (log, readout, download, previews).
- `scripts/test-repair.mjs`: builds broken meshes and checks the repair fixes them.

## What the repair does

1. Merges corners that sit in the same place.
2. Drops degenerate faces. Faces that share all three corners are resolved by
   winding: copies are merged, and opposite-wound pairs (zero-thickness inside walls
   left where parts were joined) are both removed.
3. Makes neighbouring faces agree on winding, then turns closed shells outward and
   cavities inward.
4. Fills holes. Zero-area sliver holes (T-junctions) are closed by splitting the
   neighbouring face instead of adding a flat triangle.
5. Removes any faces still on non-manifold edges and refills the gaps, but only keeps
   that change if the model's volume stays the same.
6. Removes specks: shells under 1/1000 of the model's size or with no volume.

The repaired file is checked again before download, and the page only says
"watertight" when it has no open edges, non-manifold edges or flipped faces.

## Deploy

`npm run build` produces a fully static `dist/`, which can be served from GitHub
Pages or any static host.
