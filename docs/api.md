---
title: Hullpatch HTTP API
---

# Hullpatch HTTP API
{:.no_toc}

* TOC
{:toc}

## Overview

The API repairs STL and 3MF files over HTTP, with the same engine as the
[Hullpatch page](https://stlrepair.townsville.cc). It is a separate, opt-in service with its own
image, `ghcr.io/hibikipr/hullpatch-api` (built from `Dockerfile.api`). The page itself never
uploads anything and never uses the API.

What to know before you deploy it:

- The API receives your file. It is repaired in memory on the server.
- Nothing is written to disk. The container needs no volumes and can run read-only.
- Logs hold sizes, timings, counts and the file name. They never hold file contents or
  keys.
- With no API keys configured, every endpoint except health answers 503. It fails closed.
- The base path is `/api/v1`. The service listens on port 8081 by default.

| Endpoint | What it does |
|---|---|
| `GET /api/v1/health` | Liveness and version. No key needed. |
| `POST /api/v1/repair` | Repairs a file and returns it (or a JSON report with the file inside). |
| `POST /api/v1/analyze` | Counts problems and returns JSON. Repairs nothing. |

A machine-readable description is in [`openapi.yaml`](openapi.yaml).

## Quick start

Put one API key per line in `api-keys.txt` (lines starting with `#` are comments). Generate
keys with something like `openssl rand -hex 24`. Then add the service to your compose file:

```yaml
services:
  hullpatch-api:
    image: ghcr.io/hibikipr/hullpatch-api:latest
    container_name: hullpatch-api
    restart: unless-stopped
    ports:
      - "8081:8081"
    environment:
      HULLPATCH_API_KEYS_FILE: /run/secrets/hullpatch_api_keys
    secrets:
      - hullpatch_api_keys
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

secrets:
  hullpatch_api_keys:
    file: ./api-keys.txt
```

Start it with `docker compose up -d hullpatch-api`, then check it is up:

```bash
curl -s http://localhost:8081/api/v1/health
```

```json
{"status":"ok","version":"1.0.0","keys":true}
```

`keys` is `false` when no key is configured. `version` is `dev` unless the image was built
from a release tag.

Repair a file. Keep your key in the environment, not in the command:

```bash
export HULLPATCH_KEY="paste-a-key-from-api-keys.txt"

curl -fsS -X POST http://localhost:8081/api/v1/repair \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -H "Content-Type: model/stl" \
  --data-binary @part.stl \
  -o part_fixed.stl
```

`https://stlrepair.townsville.cc` is the author's LAN host. It is used in these docs as an
example host: replace it with wherever you run the API. The same call against it:

```bash
curl -fsS -X POST https://stlrepair.townsville.cc/api/v1/repair \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -H "Content-Type: model/stl" \
  --data-binary @part.stl \
  -o part_fixed.stl
```

## Authentication

Send a key as a bearer token on every `/repair` and `/analyze` call:

```
Authorization: Bearer <key>
```

- Keys come from `HULLPATCH_API_KEYS` (comma-separated) and/or `HULLPATCH_API_KEYS_FILE`
  (one per line, `#` comments and blank lines ignored). Both are used together if both are set.
  The file is read once at startup.
- There is no key management in the API. Restart the container after changing keys.
- Any configured key works for every endpoint. Keys are not tied to users or quotas.
- Keys are compared by SHA-256 digest with a constant-time comparison, against every
  configured key (no early exit).
- No key configured: 503 `API disabled: set HULLPATCH_API_KEYS`.
- Missing, malformed or wrong key: 401 `missing or invalid API key`, with a
  `WWW-Authenticate: Bearer` header.
- `GET /api/v1/health` needs no key. It tells you only the status, version and whether
  any key is configured.
- The auth check runs before the method check, so a `GET` on `/repair` without a key is a
  401, not a 405.

## Endpoints

### Sending a file

Both `POST` endpoints take the file in one of two ways.

**Raw body.** Send the file bytes as the request body. The bytes come first: a file that
starts with a ZIP header (`PK\x03\x04`) is a 3MF, whatever `Content-Type` says. Otherwise
`Content-Type` decides:

| Content-Type | Treated as |
|---|---|
| `model/stl`, `application/sla`, `application/vnd.ms-pki.stl`, `application/x-stl` | STL |
| `model/3mf`, `application/vnd.ms-package.3dmanufacturing-3dmodel+xml` | 3MF (a non-ZIP body then gets a 422) |
| anything else, including `application/octet-stream` or none | STL (binary or ASCII) |

So `application/octet-stream`, or no type at all, always works.

`?name=part.stl` names a raw upload. The name only shapes the download file name and the
log line. Without it the name is `model.stl` or `model.3mf`.

**Multipart form.** Send `multipart/form-data` with the file in a field called `file`
(with a filename). Other fields are ignored. The format is detected from the bytes,
whatever type the part declares, and the part's filename is used as the name (it wins
over `?name=`). `curl -F file=@part.stl` does this.

The body is read whole into memory. The upload limit is 150 MB by default (see
[Limits and memory](#limits-and-memory)). Names are cleaned before use: any path is
dropped, a trailing `.stl` or `.3mf` is removed, control characters are removed, and the
stem is cut to 80 characters.

### GET /api/v1/health

No key needed. Also answers `HEAD`.

```
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
X-Content-Type-Options: nosniff

{"status":"ok","version":"1.0.0","keys":true}
```

Any other method gives 405 with `Allow: GET, HEAD`. A trailing slash is ignored on every
route.

### POST /api/v1/repair

Repairs the file and returns it.

**Query parameters**

| Parameter | Values | Meaning |
|---|---|---|
| `name` | text | Name for a raw upload (see above). |
| `format` | `stl`, `3mf` | Output format, case-insensitive. Only `stl` does anything: it turns a 3MF into an STL of the whole model. An STL can only come back as an STL, so `format=3mf` on an STL input is a 422. Any other value is a 400. |
| `parts` | `all` | 3MF only. Repair every normal part instead of only those with problems. Any other value is a 400 (even for an STL, where it is otherwise ignored). |
| `report` | `json` | Return a JSON report with the file inside as base64, instead of the file. Any other value is ignored. |

**Response: the file (default)**

```
HTTP/1.1 200 OK
Content-Type: model/stl
Content-Length: 684
Content-Disposition: attachment; filename="part_fixed.stl"; filename*=UTF-8''part_fixed.stl
Hullpatch-Report: open=0; nonmanifold=0; flipped=0; conflicts=0; watertight=1
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

The body is the repaired file: `model/stl` or `model/3mf`, the same format as the input
unless `?format=stl` was given. The download name is `<name>_fixed.stl` or
`<name>_fixed.3mf`, with an ASCII fallback in `filename` and the UTF-8 form in
`filename*`.

`Hullpatch-Report` summarizes the repaired file, so you can check the result without
reading the body:

| Field | Value |
|---|---|
| `open` | `NakedEdges` after repair: edges with only one face. |
| `nonmanifold` | `NonManifoldEdges` after repair: edges shared by three or more faces. |
| `flipped` | `InvertedNormals` after repair: faces pointing inward. |
| `conflicts` | `OrientationConflicts` after repair: edges no winding can make agree. |
| `watertight` | `1` if the [watertight rule](#what-watertight-means) holds, otherwise `0`. |

A good result is `open=0; nonmanifold=0; flipped=0; conflicts=0; watertight=1`. The
counts are all from the file you get back, not the one you sent. For a 3MF they are summed
over all normal parts, once per place each is printed.

**Response: JSON (`?report=json`)**

The `Hullpatch-Report` header is sent too. The body is `application/json`:

```json
{
  "before": {
    "NakedEdges": 3, "PlanarHoles": 1, "NonPlanarHoles": 0,
    "NonManifoldEdges": 0, "InvertedNormals": 0, "OrientationConflicts": 0,
    "DuplicateFaces": 0, "DegenerateFaces": 0, "DisjointShells": 0,
    "VerticesCount": 8, "FaceCount": 11
  },
  "after": {
    "NakedEdges": 0, "PlanarHoles": 0, "NonPlanarHoles": 0,
    "NonManifoldEdges": 0, "InvertedNormals": 0, "OrientationConflicts": 0,
    "DuplicateFaces": 0, "DegenerateFaces": 0, "DisjointShells": 0,
    "VerticesCount": 8, "FaceCount": 12
  },
  "volumeBefore": 0.9999999999999999,
  "volumeAfter": 0.9999999999999999,
  "watertight": true,
  "filename": "model_fixed.stl",
  "format": "stl",
  "file": "aHVsbHBhdGNoOiBtb2RlbC5zdGwAAAAA…"
}
```

(The example is the broken unit cube used throughout this page, formatted over several
lines and with `file` shortened. The server sends compact JSON.)

| Field | Meaning |
|---|---|
| `before`, `after` | The [analysis object](#the-analysis-fields) for the input and the result. |
| `volumeBefore`, `volumeAfter` | Volume in cubic model units (for a 3MF, the file's unit scaled by each part's placement). `volumeBefore` is measured with faces turned outward first, so flipped faces don't cancel it out; it is the fair figure to compare with `volumeAfter`. |
| `watertight` | Whether the result is watertight. |
| `paintLost` | 3MF only (missing for STL input). Number of triangles that lost Bambu paint. See [3MF behaviour](#3mf-behaviour). |
| `filename` | The download name, as in `Content-Disposition`. |
| `format` | `stl` or `3mf`: the format of `file`. |
| `file` | The repaired file, base64. |

Base64 makes the response about a third larger than the file, and the whole response is
built in memory. Prefer the plain file response for big models.

### POST /api/v1/analyze

Counts problems without repairing. Takes the same request body, `name` is accepted but not
used for anything visible. `format`, `parts` and `report` are ignored on this endpoint,
except that a bad `format` or `parts` value is still a 400.

Response `200`, `application/json`. For an STL:

```json
{
  "format": "stl",
  "analysis": {
    "NakedEdges": 3, "PlanarHoles": 1, "NonPlanarHoles": 0,
    "NonManifoldEdges": 0, "InvertedNormals": 0, "OrientationConflicts": 0,
    "DuplicateFaces": 0, "DegenerateFaces": 0, "DisjointShells": 0,
    "VerticesCount": 8, "FaceCount": 11
  },
  "volume": 0.9999999999999999,
  "watertight": false
}
```

For a 3MF there is also a `parts` array, one entry per normal part, and `analysis` is the
sum over parts (each counted once per place it is printed). This is a real call on a 3MF
with one broken cube and one good cube:

```json
{
  "format": "3mf",
  "analysis": {
    "NakedEdges": 3, "PlanarHoles": 1, "NonPlanarHoles": 0,
    "NonManifoldEdges": 0, "InvertedNormals": 0, "OrientationConflicts": 0,
    "DuplicateFaces": 0, "DegenerateFaces": 0,
    "VerticesCount": 16, "FaceCount": 23, "DisjointShells": 2
  },
  "volume": 2,
  "watertight": false,
  "parts": [
    { "name": "Broken cube", "group": "Broken cube", "plate": null, "triangles": 11, "problems": 3 },
    { "name": "Good cube", "group": "Good cube", "plate": null, "triangles": 12, "problems": 0 }
  ]
}
```

Fields of a `parts` entry:

| Field | Meaning |
|---|---|
| `name` | The part's name in the file. |
| `group` | The top-level object the part belongs to. Bambu names it in the project settings; otherwise it is the object's own name (so, in a plain 3MF, the same as `name`). |
| `plate` | The Bambu Studio plate number, or `null` when the file has no plate information. |
| `triangles` | Triangles in the part. |
| `problems` | `NakedEdges + NonManifoldEdges + InvertedNormals + OrientationConflicts + DuplicateFaces + DegenerateFaces` for that part. A part with `problems > 0` is repaired by default. |

Use `/analyze` to see which parts of a 3MF need work before choosing `?parts=all`.

Analyze checks the size limits too (see below), but for a 3MF it only checks the
whole-model limit, since nothing is repaired.

### The analysis fields

Every analysis object (`analysis`, `before`, `after`) has these integer fields. The mesh is
first welded: vertices at the same position count as one.

| Field | Meaning |
|---|---|
| `NakedEdges` | Edges used by only one face. They outline holes or gaps. |
| `PlanarHoles` | Boundary loops of naked edges that lie flat in one plane. |
| `NonPlanarHoles` | Boundary loops that do not lie flat. |
| `NonManifoldEdges` | Edges shared by three or more faces (T-shaped joins, inside walls). |
| `InvertedNormals` | Faces whose winding points them inward, after neighbours are made consistent. |
| `OrientationConflicts` | Edges where no choice of winding makes the two sides agree, such as a twisted band. |
| `DuplicateFaces` | Faces that repeat another face's three corners. |
| `DegenerateFaces` | Faces with (nearly) zero area. |
| `DisjointShells` | Number of separate connected pieces, or `0` when there is just one. |
| `VerticesCount` | Vertices after welding. For a 3MF, summed over parts. |
| `FaceCount` | Triangles. For a 3MF, summed over parts. |

### What "watertight" means

`watertight` is true when all four of these are zero:

```
NakedEdges == 0 && NonManifoldEdges == 0 && InvertedNormals == 0 && OrientationConflicts == 0
```

That is the same rule the page uses. Duplicate and degenerate faces, extra shells and
holes counts do not enter into it (holes are naked edges anyway). It means the surface is
closed, each edge has exactly two faces, and all faces point outward. It does not check
for self-intersections.

## 3MF behaviour

- **3MF in, 3MF out.** The result keeps plates, filament and print settings, transforms,
  units and colours. Every file inside the archive is copied through; only the vertices and
  triangles of the repaired objects change.
- **Which parts are repaired.** By default only parts with `problems > 0`. Parts without
  problems are copied untouched. Use `?parts=all` to repair every normal part.
- **Parts that are never repaired.** Negative parts, modifiers, support blockers and support
  enforcers are never repaired or counted in the analysis, even with `parts=all`. They are
  copied through. A 3MF with no normal part gets a 422 `this 3mf file has no printable mesh objects`.
- **Paint.** Bambu paint (colour, seam, support) is kept on triangles the repair did not
  change. If a repair had to replace painted triangles, those lose their paint, and
  `paintLost` in the JSON report says how many. It is `0` when nothing was lost.
- **`?format=stl`.** Returns one STL of the whole model: every normal part, placed where
  it is printed, welded into one mesh. Settings, plates and paint are dropped, as they have
  no place in an STL. The STL header reads `hullpatch: <name>`.
- **Pinched edges.** The repair can split an edge where two surfaces only touch (four
  faces on one edge) into separate vertices. A 3MF keeps that split because it joins
  vertices by index. An STL can't keep it: STL has no vertex indices, so a program that
  reads the file joins vertices by position again and the edge is pinched as before. This
  applies to an STL input and to `?format=stl` output. Keep 3MF in the pipeline when you can.

## Limits and memory

A repair peaks at about **1.5 to 2 KB of memory per triangle**, per concurrent job. A file
that is only scanned and copied (3MF parts left as they are) costs about a quarter of
that. A 3MF can also unpack to far more than its upload size, so the upload limit alone
doesn't bound memory. These limits are checked before the expensive steps, so a model that
is too big is refused with a 413 instead of running the container out of memory (which would
show up to the caller as a dropped connection).

| Limit | Default | Where it applies | Result |
|---|---|---|---|
| Upload size | 150 MB | The request body (`Content-Length` checked up front, then while streaming). | 413 `file too large (limit N bytes)` |
| Triangles to repair | 2,500,000 | An STL, or the 3MF parts being repaired. For an ASCII STL only the byte limit applies. | 413 `model too large for this server: N triangles to repair (limit M)` |
| Triangles in all | 4 x the above (10,000,000) | A whole 3MF, counted once per placed copy. | 413 `model too large for this server: N triangles in all (limit M)` |
| Unpacked 3MF size | 512 MB | Total uncompressed size of the 3MF's entries, before unpacking. | 413 `this 3MF expands to more than N MB` |
| Concurrency | 2 | Jobs running at once. | Extra requests wait in the queue. |
| Queue | 4 | Requests allowed to wait. | 429 `busy, try again shortly` with `Retry-After: 10` |
| Job timeout | 240 s | Time from the start of a job to its end. | 503 `repair took too long` |

Jobs run in a pool of worker threads. A job that times out has its worker thread
terminated and replaced, so one slow file can't wedge the service. The timeout does not
count the upload.

### Sizing for a container

Worst-case memory is roughly:

```
max triangles to repair  x  2 KB  x  concurrency
```

With the defaults that is 2.5M x 2 KB x 2, about 10 GB. Pick the container memory first,
then lower `HULLPATCH_API_MAX_TRIANGLES` or `HULLPATCH_API_CONCURRENCY` until the product
fits with some headroom. A few examples:

| Container memory | Concurrency | Max triangles to repair |
|---|---|---|
| 6 GB | 1 | 2,500,000 (the default) |
| 6 GB | 2 | 1,200,000 |
| 2 GB | 1 | 800,000 |
| 2 GB | 2 | 400,000 |

(The 1.9-million-triangle Deku Mask 3MF needed 3 GB for a single repair.) The raw upload
(up to `HULLPATCH_API_MAX_BYTES`) and the response also sit in memory per request, and
queued requests have already uploaded their bodies, so leave room for
`(concurrency + queue) x upload size` too, or lower `HULLPATCH_API_QUEUE` and
`HULLPATCH_API_MAX_BYTES`.

The scan limit is for big 3MF projects where only a few parts need repair: with 10M
triangles in all, but only 300k on the broken parts, the file goes through. Set
`HULLPATCH_API_MAX_SCAN_TRIANGLES` directly if you want a different ratio.

To enforce a ceiling, set a memory limit on the container. In Docker Compose that is
`mem_limit: 6g`. It only works where the kernel has memory cgroups enabled. Some Raspberry
Pi kernels ship with them off (enable them with `cgroup_enable=memory cgroup_memory=1` on
the kernel command line), and Docker then ignores the limit with a warning. Without a
working limit, the triangle limits above are the only protection.

## Configuration

All settings are environment variables, read once at startup. Invalid or out-of-range
values fall back to the default.

| Variable | Default | Meaning |
|---|---|---|
| `HULLPATCH_API_KEYS` | none | Comma-separated API keys. |
| `HULLPATCH_API_KEYS_FILE` | none | File with one key per line (`#` comments). Used with or instead of the list. The server fails to start if the file can't be read. |
| `HULLPATCH_API_CONCURRENCY` | `2` | Repairs running at once (at least 1). |
| `HULLPATCH_API_QUEUE` | `4` | Requests allowed to wait behind them (0 or more). |
| `HULLPATCH_API_MAX_BYTES` | `157286400` (150 MiB) | Upload limit, in bytes. |
| `HULLPATCH_API_TIMEOUT_MS` | `240000` | A job that runs longer returns 503. |
| `HULLPATCH_API_MAX_TRIANGLES` | `2500000` | Triangles to repair. |
| `HULLPATCH_API_MAX_SCAN_TRIANGLES` | 4 x the above | Triangles in a whole 3MF, counted once per placed copy. |
| `HULLPATCH_API_MAX_UNCOMPRESSED_MB` | `512` | Unpacked size limit for a 3MF, in MiB. |
| `HULLPATCH_VERSION` | `dev` | Version string reported by health. The image sets it from the release tag. |
| `PORT` | `8081` | Listen port. The server listens on all interfaces (`0.0.0.0`). |

## Errors

Every error is JSON, `application/json`, with the shape:

```json
{ "error": "missing or invalid API key" }
```

| Status | When | `error` message |
|---|---|---|
| 400 | Empty body. | `empty body` |
| 400 | `format` is not `stl` or `3mf`. | `format must be stl or 3mf` |
| 400 | `parts` is set to something other than `all`. | `parts must be "all" or omitted` |
| 400 | Multipart with no boundary, or malformed. | `multipart body has no boundary`, `malformed multipart body`, `multipart body is not terminated` |
| 400 | Multipart without a `file` field (with a filename). | `multipart body has no "file" field` |
| 400 | The `file` part is empty. | `empty file` |
| 401 | Missing or wrong key. Has `WWW-Authenticate: Bearer`. | `missing or invalid API key` |
| 404 | Any path other than the three above. | `not found` |
| 405 | Wrong method. `Allow: POST` on `/repair` and `/analyze`, `Allow: GET, HEAD` on health. | `method not allowed` |
| 413 | Body over the upload limit. | `file too large (limit N bytes)` |
| 413 | Too many triangles, or a 3MF that unpacks too large. | See [Limits and memory](#limits-and-memory). |
| 422 | The file can't be read, for example garbage in an STL, a broken zip, or a 3MF with a bad reference. | e.g. `the file is not a valid binary or ascii stl file`, `the file is not a valid 3mf (zip) archive`, `this 3mf file has no printable mesh objects` |
| 422 | `?format=3mf` on an STL input (on `/repair`). | `STL input can only be returned as STL` |
| 429 | The queue is full. Has `Retry-After: 10`. | `busy, try again shortly` |
| 500 | Unexpected failure inside the server. The details go to the server's log, never to the client. | `internal error` |
| 503 | No API key configured. | `API disabled: set HULLPATCH_API_KEYS` |
| 503 | The job ran past the timeout. | `repair took too long` |

Order of checks: route (404), keys configured (503), key (401), method (405), `format` and
`parts` (400), queue (429), body size (413), body and multipart (400), then the repair.
Health is answered before all of that.

When the server rejects a request before it has read the whole body (401, 405, 400 for
`format` or `parts`, 429, and 413), it closes the connection after the answer. A client
that is still uploading a very large file may then see a connection reset instead of the
status. Retry on 429 after the `Retry-After` delay (10 seconds).

## Deployment

### Docker and Compose

`docker-compose.yml` in the repository runs the API with:

- `read_only: true` and a `tmpfs` at `/tmp`. Everything is in memory, so no volumes.
- `no-new-privileges` and `cap_drop: [ALL]`.
- The image runs as uid 1000 (the `node` user), with root-owned, read-only files.
- Keys from a Docker secret mounted at `/run/secrets/hullpatch_api_keys`
  (`HULLPATCH_API_KEYS_FILE`) rather than inline in the compose file.
- A `HEALTHCHECK` on `/api/v1/health` every 30 seconds.
- An optional `mem_limit` (see [Sizing for a container](#sizing-for-a-container)).

The container shuts down on `SIGTERM` and `SIGINT`: it stops accepting connections, lets
requests in flight finish for up to 10 seconds, then drops the rest.

### Reverse proxy

The API speaks plain HTTP and has no TLS or CORS handling. Put a proxy in front for HTTPS.
It sends no `Access-Control-Allow-Origin` header, so browsers on other origins can't call it,
by design. It is meant for scripts and servers.

For Nginx Proxy Manager, add a custom location `/api/` on the site, scheme `http`,
forward host `hullpatch-api`, port `8081`, and paste this into the location's advanced
config (`docker/npm-api-location.conf` in the repository). The same directives work
inside a `location /api/` block in plain nginx with `proxy_pass http://hullpatch-api:8081;`.

```nginx
# STLs up to 150 MB (the API itself caps at HULLPATCH_API_MAX_BYTES).
client_max_body_size 160m;

# Stream the upload straight to the API instead of spooling it to disk first.
proxy_request_buffering off;

# Repairing a big mesh can take minutes.
proxy_read_timeout 300s;
proxy_send_timeout 300s;

proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

- `client_max_body_size` must be at least `HULLPATCH_API_MAX_BYTES`. Raise both together.
- `proxy_request_buffering off` streams the upload to the API, so the proxy doesn't write a
  150 MB temporary file.
- The timeouts must be longer than `HULLPATCH_API_TIMEOUT_MS` (240 s by default).
- **Keep sign-in proxies off `/api/`.** If the rest of the site sits behind forward-auth
  such as tinyauth, the API location must not include its `auth_request` or `error_page 401`
  lines. A script can't do an interactive sign-in, and the API key is the gate. If the whole
  host is protected by tinyauth, add the regex `^/api/` to its allowed paths.

## Client examples

All examples read the key from `HULLPATCH_KEY` and use `BASE` as the API root. Both
Python and Node examples use `http://localhost:8081`: change it to your host.

### curl

Raw body:

```bash
curl -fsS -X POST "$BASE/api/v1/repair" \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -H "Content-Type: model/stl" \
  --data-binary @part.stl \
  -o part_fixed.stl
```

Multipart form (the download name comes from the file name):

```bash
curl -fsS -X POST "$BASE/api/v1/repair" \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -F "file=@part.stl" \
  -o part_fixed.stl
```

A whole 3MF as an STL:

```bash
curl -fsS -X POST "$BASE/api/v1/repair?format=stl" \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -H "Content-Type: model/3mf" \
  --data-binary @plate.3mf \
  -o plate_fixed.stl
```

A 3MF repaired in place, every part (the result stays a 3MF):

```bash
curl -fsS -X POST "$BASE/api/v1/repair?parts=all" \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  --data-binary @plate.3mf \
  -o plate_fixed.3mf
```

Problem counts only:

```bash
curl -fsS -X POST "$BASE/api/v1/analyze" \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  -H "Content-Type: model/stl" \
  --data-binary @part.stl
```

Check the result in a shell script. With `set -e`, a failed request stops the script:
`-f` turns HTTP errors into a non-zero exit, and the script then checks that the repaired
file really is watertight before it keeps it:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8081}"
in="$1"
out="${in%.*}_fixed.${in##*.}"

headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT

curl -fsS -X POST "$BASE/api/v1/repair" \
  -H "Authorization: Bearer $HULLPATCH_KEY" \
  --data-binary @"$in" \
  -D "$headers" -o "$out"

report="$(grep -i '^hullpatch-report:' "$headers" | cut -d' ' -f2- | tr -d '\r')"
echo "$report"

case "$report" in
  *"watertight=1"*) echo "ok: $out" ;;
  *) echo "not watertight, removing $out" >&2; rm -f "$out"; exit 1 ;;
esac
```

On the broken cube this prints `open=0; nonmanifold=0; flipped=0; conflicts=0; watertight=1`.

### Python

With [`requests`](https://requests.readthedocs.io):

```python
import os
import sys

import requests

BASE = os.environ.get("HULLPATCH_URL", "http://localhost:8081")
KEY = os.environ["HULLPATCH_KEY"]


def repair(path, out_path):
    with open(path, "rb") as f:
        r = requests.post(
            f"{BASE}/api/v1/repair",
            headers={"Authorization": f"Bearer {KEY}"},
            files={"file": (os.path.basename(path), f)},
            timeout=300,
        )
    if r.status_code == 429:
        raise RuntimeError(f"busy, retry after {r.headers.get('Retry-After')} s")
    if not r.ok:
        raise RuntimeError(f"{r.status_code}: {r.json().get('error')}")
    report = r.headers["Hullpatch-Report"]
    with open(out_path, "wb") as out:
        out.write(r.content)
    return report


if __name__ == "__main__":
    src = sys.argv[1]
    stem, ext = os.path.splitext(src)
    print(repair(src, f"{stem}_fixed{ext}"))
```

For the problem counts only, `requests.post(f"{BASE}/api/v1/analyze", headers=..., data=open(path, "rb").read())`
and read `r.json()["analysis"]`.

### Node

Node 18 or newer, with the built-in `fetch`. Save as `repair.mjs`:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const BASE = process.env.HULLPATCH_URL ?? 'http://localhost:8081';
const KEY = process.env.HULLPATCH_KEY;
if (!KEY) throw new Error('set HULLPATCH_KEY');

const input = process.argv[2];
const data = await readFile(input);

const res = await fetch(`${BASE}/api/v1/repair?name=${encodeURIComponent(basename(input))}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/octet-stream' },
  body: data,
});

if (!res.ok) {
  const { error } = await res.json();
  throw new Error(`${res.status}: ${error}`);
}

const ext = extname(input);
const output = input.slice(0, -ext.length) + '_fixed' + ext;
await writeFile(output, Buffer.from(await res.arrayBuffer()));
console.log(res.headers.get('hullpatch-report'));
```

Run it with `node repair.mjs part.stl`. A 3MF in gives a 3MF out: add `&format=stl` to the
URL for an STL.
