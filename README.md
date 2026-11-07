# Hullpatch

STL repair that runs in the browser, part of [townsville.cc](https://townsville.cc).
Drop in an STL and Hullpatch closes holes, removes inside walls, turns flipped faces
outward and clears unprintable specks, so the file loads as a clean, manifold solid
in Bambu Studio. Nothing is uploaded: the repair runs in a Web Worker in the tab.

The result opens in an interactive 3D view powered by [F3D](https://f3d.app)'s
WebAssembly build (the same viewer Manyfold uses), with a Before/After toggle.

## Run with Docker

```bash
docker run -d --name hullpatch -p 8080:8080 ghcr.io/hibikipr/hullpatch:latest
```

or use the included `docker-compose.yml`, then open http://localhost:8080.
The container is nginx serving static files as a non-root user. It needs no
settings or volumes and runs fine read-only, because repairs happen in the
visitor's browser.

Images are multi-arch (amd64 + arm64) on GHCR:

| Tag | Built from |
|---|---|
| `latest`, `main` | every push to `main` |
| `1.2.3`, `1.2` | a `v1.2.3` release tag |
| `sha-abc1234` | every build |

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
- `src/repair/viewer.js`: the F3D 3D view. F3D is ~12 MB gzipped, so it is only
  fetched once a repair starts. Without WebGL 2 the page shows flat pictures instead.
  The coloured Before model is a binary PLY with a colour and alpha per face, built in
  the page from the flags `problemFaces()` in `mesh.js` returns, and shown with F3D's
  `model.coloring=direct` on cell data.
- `Dockerfile`, `docker/`: Node build stage, then non-root nginx with gzip,
  long-lived caching for hashed assets, security headers and `/healthz`.
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

## Releasing

Push a version tag (or publish a GitHub release with one) and the
`Build and publish image` workflow pushes `ghcr.io/hibikipr/hullpatch:<version>`:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

CI also lints the Dockerfile, runs the built container read-only and checks that it
serves the page, the CSP header and the viewer's WASM (as gzipped `application/wasm`),
then scans the image with Trivy.

The Content-Security-Policy allows `'unsafe-eval'` for scripts because F3D's
Emscripten bindings create functions with `new Function`. Without it the 3D view
can't start and the page falls back to the pictures.

## Licence

AGPL-3.0, like the other townsville.cc tools. F3D is BSD-3-Clause.
