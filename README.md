# Hullpatch

STL and 3MF repair that runs in the browser, part of [townsville.cc](https://townsville.cc).
Drop in an STL or 3MF and Hullpatch closes holes, removes inside walls, turns flipped faces
outward and clears unprintable specks, so the file loads as a clean, manifold solid
in Bambu Studio. Nothing is uploaded: the repair runs in a Web Worker in the tab.

A 3MF comes back as a 3MF (`<name>_fixed.3mf`) that keeps plates, filament and print
settings, transforms and colours; only the mesh of the repaired objects changes. If a
file holds several objects, you pick which ones to repair, and the rest are copied
through untouched. Negative parts, modifiers and support blockers or enforcers are never
repaired. Painted colour, seam and support paint is kept on triangles the repair didn't
change; if painted triangles had to be replaced, the result says how many lost their paint.

The result opens in an interactive 3D view powered by [F3D](https://f3d.app)'s
WebAssembly build (the same viewer Manyfold uses), with a Before/After toggle.
The Before view colours every triangle at a problem: red at an open edge, amber at a
non-manifold edge or duplicate, purple where flipped. Problems too small to see also
get a marker in their colour. **See inside** makes the healthy surface see-through,
so inside walls hidden in the model show up.

Hullpatch can be installed as an app (Install app button in Chrome and Edge, Add to
Home Screen / Dock in Safari). Installed, it works offline, opens `.stl` and `.3mf` files
from the desktop (Chrome and Edge) and takes `.stl` and `.3mf` files shared to it on Android.

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

## HTTP API (optional)

For scripts and programs there is a separate HTTP API that repairs files on your own
server. It is a second service with its own image (`ghcr.io/hibikipr/hullpatch-api`,
built from `Dockerfile.api`) and only runs if you deploy it. The page itself still never
uploads anything, and it never uses the API.

Unlike the page, the API receives your file and repairs it in memory on the server.
Nothing is written to disk, and logs hold sizes, timings and counts, never file contents
or keys.

### Run it

1. Put one API key per line in `api-keys.txt` next to `docker-compose.yml` (lines
   starting with `#` are comments). The file is gitignored.
2. Start the service: `docker compose up -d hullpatch-api` (port 8081).

With no keys configured the API answers 503 "API disabled", so it fails closed.
A repair needs about 1.5 to 2 KB of memory per triangle at its peak, per concurrent job
(the 1.9-million-triangle Deku Mask 3MF peaked at 3 GB). A 3MF can unpack to far more than
its upload size, so the upload limit alone doesn't bound memory: the API refuses a model
with more triangles to repair than `HULLPATCH_API_MAX_TRIANGLES` (or more in all than
`HULLPATCH_API_MAX_SCAN_TRIANGLES`), or a 3MF that unpacks past
`HULLPATCH_API_MAX_UNCOMPRESSED_MB` with a 413, before repairing it. Set those to fit the
memory the container has. Without them, a model too big for the host gets the container
killed and the caller only sees a dropped connection.

### Endpoints

| Endpoint | What it does |
|---|---|
| `GET /api/v1/health` | No key needed. Returns `{"status":"ok","version":…,"keys":true}`. |
| `POST /api/v1/repair` | Returns the repaired file in the same format (`<name>_fixed.stl` or `.3mf`). |
| `POST /api/v1/analyze` | Returns problem counts as JSON (and the parts of a 3MF) without repairing. |

Send the key as `Authorization: Bearer <key>`. Send the file as the raw body with
`Content-Type: model/stl` or `model/3mf` (or `application/octet-stream`, and the format is
detected), or as a multipart form with a `file` field. `?name=part.stl` names a raw upload.
The limit is 150 MB.

On `/repair`:

- `?format=stl` turns a 3MF into an STL of the whole model.
- A 3MF repairs only the parts with problems by default; `?parts=all` repairs every normal part.
- `?report=json` returns JSON (`before`, `after`, volumes, `watertight`, `filename`, `format`,
  and the file as base64).

Every `/repair` response has a `Hullpatch-Report` header, for example
`open=0; nonmanifold=0; flipped=0; conflicts=0; watertight=1`.

### Examples

Repair a raw STL and save the result:

```bash
curl -fsS -X POST https://stlrepair.townsville.cc/api/v1/repair \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -H "Content-Type: model/stl" \
  --data-binary @part.stl \
  -o part_fixed.stl
```

Same thing as a multipart form:

```bash
curl -fsS -X POST https://stlrepair.townsville.cc/api/v1/repair \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -F "file=@part.stl" \
  -o part_fixed.stl
```

Turn a whole 3MF into an STL:

```bash
curl -fsS -X POST "https://stlrepair.townsville.cc/api/v1/repair?format=stl" \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -H "Content-Type: model/3mf" \
  --data-binary @plate.3mf \
  -o plate_fixed.stl
```

Check the result in a script:

```bash
curl -fsS -D - -o /dev/null -X POST https://stlrepair.townsville.cc/api/v1/repair \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -H "Content-Type: model/stl" \
  --data-binary @part.stl | grep -i hullpatch-report
```

### Errors

| Status | Meaning |
|---|---|
| 400 | Empty body, empty file part, bad `format` or `parts` value. |
| 401 | Missing or wrong key. |
| 405 | Wrong method. |
| 413 | Larger than the upload limit, or a model over the triangle or unpacked-size limit. |
| 422 | File can't be read (`{"error": …}`), or the output can't be made, such as `?format=3mf` on an STL. |
| 429 | Queue full. Wait for `Retry-After` and try again. |
| 503 | API disabled, or the repair took too long. |

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HULLPATCH_API_KEYS` | none | Comma-separated keys. |
| `HULLPATCH_API_KEYS_FILE` | none | File with one key per line. Used with or instead of the list above. |
| `HULLPATCH_API_CONCURRENCY` | 2 | Repairs running at once. |
| `HULLPATCH_API_QUEUE` | 4 | Requests allowed to wait behind them. |
| `HULLPATCH_API_MAX_BYTES` | 150 MB | Upload limit. |
| `HULLPATCH_API_TIMEOUT_MS` | 240000 | A repair that runs longer returns 503. |
| `HULLPATCH_API_MAX_TRIANGLES` | 2500000 | Triangles to repair (an STL, or the 3MF parts being repaired). More gets 413 before repair; about 4 GB peak at the default. |
| `HULLPATCH_API_MAX_SCAN_TRIANGLES` | 4 × the above | Triangles in a whole 3MF, counted once per placed copy. Parts left as they are cost about a quarter of the memory, so a big project where only a few parts need repair still goes through. |
| `HULLPATCH_API_MAX_UNCOMPRESSED_MB` | 512 | A 3MF that unpacks to more gets 413 before it is unpacked. |
| `PORT` | 8081 | Listen port. |

### Behind Nginx Proxy Manager

`docker/npm-api-location.conf` has the settings. Add a custom location `/api/` on the
Hullpatch site that forwards to `hullpatch-api:8081`, and paste the directives in. They
raise the upload limit to 160 MB and the timeouts to 300 s. Keep the sign-in proxy
(tinyauth) off `/api/`: scripts can't sign in, so the API key is the only gate.

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
  so they run in the worker and in Node tests. `orient()` detects winding conflicts,
  and the repair cuts and caps them.
- `src/repair/threemf.js`: 3MF reader and writer (fflate + string scanning, no DOM, so it
  runs in the worker and in Node tests): resolves production-extension components,
  transforms, units and Bambu part types; the writer copies every zip entry and swaps
  only the repaired objects' vertices and triangles.
- `src/repair/pipeline.js`: the read → scan → repair → write steps shared by the page's worker and the API.
- `src/repair/worker.js`: runs read → scan → repair → re-check off the main thread. For a
  3MF it repairs each object on its own and asks the page which objects to repair when
  there are several.
- `src/repair/tool.js`: the repair bay UI (log, readout, download, previews).
- `src/repair/viewer.js`: the F3D 3D view. F3D is ~12 MB gzipped, so it is only
  fetched once a repair starts. Without WebGL 2 the page shows flat pictures instead.
  The coloured Before model is a binary PLY with a colour and alpha per face, built in
  the page from the flags `problemFaces()` in `mesh.js` returns, and shown with F3D's
  `model.coloring=direct` on cell data.
- `src/app.js`: installed-app features: registers the service worker, shows the
  Install app button, and passes files opened with or shared to the app to the bay.
- `src/sw.js`: the service worker. `vite.config.js` writes it to `/sw.js` with the
  build's file list. The page, scripts, styles and Latin fonts are cached on install;
  F3D is cached the first time it loads. Pages are network-first, hashed assets
  cache-first. Shared files arrive as a POST to `/share-target`.
- `public/site.webmanifest`: app name, icons, `.stl` file handler and share target.
- `Dockerfile`, `docker/`: Node build stage, then non-root nginx with gzip,
  long-lived caching for hashed assets, security headers and `/healthz`.
- `server/`: the optional HTTP API (node:http, worker_threads pool). See "HTTP API (optional)".
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
5. Splits pinched edges: where two surfaces touch along one edge (four faces on it,
   pairing up into two sheets), the edge gets a second copy for one sheet. Nothing moves
   and no face is removed. A 3MF keeps the split; an STL can't, since readers join
   corners by position.
6. Removes any faces still on non-manifold edges and refills the gaps, but only keeps
   that change if the model's volume stays the same.
7. Removes specks: shells under 1/1000 of the model's size or with no volume.
8. Handles winding conflicts: edges where the surface twists so that no way of turning
   the faces makes both sides agree (typical when parts were exported inside-out and
   joined). The few faces at those spots are cut out and the holes capped, so the model
   becomes a consistent, outward-facing solid.

The repaired file is checked again before download, and the page only says
"watertight" when it has no open edges, non-manifold edges, flipped faces or winding
conflicts. For a 3MF each object is checked as it is written.

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
