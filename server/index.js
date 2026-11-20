// Hullpatch HTTP API: send an STL or 3MF, get the repaired file back. Node built-ins only.
// Files stay in memory; nothing is written to disk and no file content is ever logged.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool, PoolFullError, JobTimeoutError } from './pool.js';
import { boundaryOf, findFilePart } from './multipart.js';

const MiB = 1024 * 1024;
const int = (v, d, min = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= min ? n : d; };

/** Settings from the environment (see the README); `over` wins, which the tests use. */
export function configFromEnv(env = process.env, over = {}) {
  const keys = new Set();
  for (const k of (env.HULLPATCH_API_KEYS || '').split(',')) if (k.trim()) keys.add(k.trim());
  if (env.HULLPATCH_API_KEYS_FILE) {
    for (const line of fs.readFileSync(env.HULLPATCH_API_KEYS_FILE, 'utf8').split(/\r?\n/)) {
      const k = line.trim();
      if (k && !k.startsWith('#')) keys.add(k);
    }
  }
  return {
    port: int(env.PORT, 8081),
    host: '0.0.0.0',
    keys: [...keys],
    concurrency: int(env.HULLPATCH_API_CONCURRENCY, 2, 1),
    queue: int(env.HULLPATCH_API_QUEUE, 4, 0),
    version: env.HULLPATCH_VERSION || 'dev',
    maxBytes: int(env.HULLPATCH_API_MAX_BYTES, 150 * MiB, 1),
    timeoutMs: int(env.HULLPATCH_API_TIMEOUT_MS, 240000, 1),
    // Memory guards: a repair peaks at about 1.5-2 KB per triangle (the 1.9M-triangle Deku
    // Mask 3MF needed 3 GB), and unpacking a 3MF costs memory before triangles can be counted.
    // Triangles to repair; triangles only scanned and copied may be 4x as many (they cost
    // about a quarter of the memory), unless HULLPATCH_API_MAX_SCAN_TRIANGLES says otherwise.
    maxTriangles: int(env.HULLPATCH_API_MAX_TRIANGLES, 2500000, 1),
    maxScanTriangles: int(env.HULLPATCH_API_MAX_SCAN_TRIANGLES, 0, 1),
    maxUncompressed: int(env.HULLPATCH_API_MAX_UNCOMPRESSED_MB, 512, 1) * MiB,
    jobDelayMs: 0,
    ...over,
  };
}

class HttpError extends Error {
  constructor(status, message, headers) { super(message); this.status = status; this.headers = headers; }
}

const STL_TYPES = new Set(['model/stl', 'application/sla', 'application/vnd.ms-pki.stl', 'application/x-stl']);
const MF_TYPES = new Set(['model/3mf', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml']);

// An ArrayBuffer covering exactly this Buffer, ready to transfer to a worker (copied only if it is a slice of something bigger).
const exact = (b) => (b.byteOffset === 0 && b.buffer.byteLength === b.length ? b.buffer : Uint8Array.prototype.slice.call(b).buffer);
const sniff = (b) => (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 ? '3mf' : 'stl');

/** File name for a download: no path, no control characters; ASCII fallback plus RFC 5987 form. */
function disposition(name, ext) {
  let stem = String(name || '').replace(/\\/g, '/').split('/').pop();
  stem = stem.replace(/\.(stl|3mf)$/i, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80);
  if (!stem) stem = 'model';
  const full = `${stem}_fixed.${ext}`;
  const ascii = full.replace(/[^A-Za-z0-9._ -]/g, '_');
  const star = encodeURIComponent(full).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return { filename: full, header: `attachment; filename="${ascii}"; filename*=UTF-8''${star}` };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const cl = /^\d+$/.test(req.headers['content-length'] || '') ? Number(req.headers['content-length']) : -1;
    if (cl > max) return reject(new HttpError(413, `file too large (limit ${max} bytes)`));
    let prealloc = cl > 0 ? Buffer.allocUnsafe(cl) : null;
    const chunks = [];
    let n = 0;
    req.on('data', (chunk) => {
      if (n + chunk.length > max || (prealloc && n + chunk.length > cl)) {
        req.removeAllListeners('data');
        return reject(new HttpError(413, `file too large (limit ${max} bytes)`));
      }
      if (prealloc) chunk.copy(prealloc, n); else chunks.push(chunk);
      n += chunk.length;
    });
    req.on('end', () => resolve(prealloc ? (n === cl ? prealloc : prealloc.subarray(0, n)) : Buffer.concat(chunks, n)));
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(0, 'client aborted')));
  });
}

export function createApi(config) {
  const keyDigests = config.keys.map((k) => crypto.createHash('sha256').update(k).digest());
  const pool = new Pool({
    size: config.concurrency,
    queue: config.queue,
    timeoutMs: config.timeoutMs,
    workerUrl: new URL('./job.js', import.meta.url),
    workerData: { jobDelayMs: config.jobDelayMs, limits: { maxTriangles: config.maxTriangles, maxScanTriangles: config.maxScanTriangles, maxUncompressed: config.maxUncompressed } },
  });

  const authorized = (req) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
    if (!m) return false;
    const d = crypto.createHash('sha256').update(m[1]).digest();
    let ok = false;
    for (const k of keyDigests) ok = crypto.timingSafeEqual(d, k) || ok; // no early exit
    return ok;
  };

  let active = 0;
  let idleWaiters = [];

  async function handle(req, res, log) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    log.path = url.pathname.slice(0, 80);

    if (route === '/api/v1/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed', { Allow: 'GET, HEAD' });
      return send(res, 200, { status: 'ok', version: config.version, keys: keyDigests.length > 0 });
    }
    if (route !== '/api/v1/repair' && route !== '/api/v1/analyze') throw new HttpError(404, 'not found');
    if (!keyDigests.length) throw new HttpError(503, 'API disabled: set HULLPATCH_API_KEYS');
    if (!authorized(req)) throw new HttpError(401, 'missing or invalid API key', { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed', { Allow: 'POST' });
    const analyzeOnly = route === '/api/v1/analyze';

    const q = url.searchParams;
    const outFormat = (q.get('format') || '').toLowerCase();
    if (outFormat && outFormat !== 'stl' && outFormat !== '3mf') throw new HttpError(400, 'format must be stl or 3mf');
    if (q.get('parts') && q.get('parts') !== 'all') throw new HttpError(400, 'parts must be "all" or omitted');
    if (pool.full) throw new HttpError(429, 'busy, try again shortly', { 'Retry-After': '10' });

    const body = await readBody(req, config.maxBytes);
    log.bytesIn = body.length;
    if (!body.length) throw new HttpError(400, 'empty body');

    // The file: a raw body, or the "file" part of a multipart form.
    let data = body;
    let name = (q.get('name') || '').trim();
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let format;
    if (type === 'multipart/form-data') {
      const boundary = boundaryOf(req.headers['content-type']);
      if (!boundary) throw new HttpError(400, 'multipart body has no boundary');
      let part;
      try { part = findFilePart(body, boundary, 'file'); } catch (e) { throw new HttpError(400, e.message); }
      if (!part) throw new HttpError(400, 'multipart body has no "file" field');
      data = part.data;
      name = part.filename || name;
      if (!data.length) throw new HttpError(400, 'empty file');
      format = sniff(data);
    } else if (sniff(data) === '3mf') format = '3mf'; // a zip is a 3MF, whatever the declared type
    else if (STL_TYPES.has(type)) format = 'stl';
    else if (MF_TYPES.has(type)) format = '3mf';
    else format = 'stl';
    if (!name) name = 'model.' + format;
    log.name = name.slice(0, 80);
    log.format = format;

    if (!analyzeOnly && outFormat === '3mf' && format === 'stl') throw new HttpError(422, 'STL input can only be returned as STL');

    const ab = data === body ? exact(body) : exact(Buffer.from(data)); // multipart: one copy of the file part
    let r;
    try {
      r = await pool.run({ op: analyzeOnly ? 'analyze' : 'repair', format, buffer: ab, name, parts: q.get('parts'), outFormat }, [ab]);
    } catch (e) {
      if (e instanceof PoolFullError) throw new HttpError(429, 'busy, try again shortly', { 'Retry-After': '10' });
      if (e instanceof JobTimeoutError) throw new HttpError(503, 'repair took too long');
      throw e;
    }
    if (!r.ok) {
      if (r.user) throw new HttpError(r.status || 422, r.message);
      throw new Error(r.message);
    }

    if (analyzeOnly) {
      log.counts = r.analysis;
      const out = { format: r.format, analysis: r.analysis, volume: r.volume, watertight: r.watertight };
      if (r.parts) out.parts = r.parts;
      return send(res, 200, out);
    }

    log.counts = r.after;
    const a = r.after;
    const report = `open=${a.NakedEdges}; nonmanifold=${a.NonManifoldEdges}; flipped=${a.InvertedNormals}; conflicts=${a.OrientationConflicts}; watertight=${r.watertight ? 1 : 0}`;
    const d = disposition(name, r.outFormat);
    const file = Buffer.from(r.file);
    if (q.get('report') === 'json') {
      const out = { before: r.before, after: r.after, volumeBefore: r.volumeBefore, volumeAfter: r.volumeAfter, watertight: r.watertight };
      if (r.paintLost !== undefined) out.paintLost = r.paintLost;
      out.filename = d.filename;
      out.format = r.outFormat;
      out.file = file.toString('base64');
      return send(res, 200, out, { 'Hullpatch-Report': report });
    }
    res.writeHead(200, {
      'Content-Type': r.outFormat === 'stl' ? 'model/stl' : 'model/3mf',
      'Content-Length': file.length,
      'Content-Disposition': d.header,
      'Hullpatch-Report': report,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    log.bytesOut = file.length;
    res.end(file);
  }

  function send(res, status, obj, headers = {}) {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.res_bytes = buf.length;
    res.end(req_head(res) ? undefined : buf);
  }
  const req_head = (res) => res.req && res.req.method === 'HEAD';

  const server = http.createServer((req, res) => {
    const t0 = performance.now();
    const log = { path: '-', bytesIn: 0, bytesOut: 0, format: '-', name: null, counts: null };
    active++;
    let bodyUnread = true;
    req.on('end', () => { bodyUnread = false; });
    res.on('close', () => {
      active--;
      if (!log.bytesOut && res.res_bytes) log.bytesOut = res.res_bytes;
      const c = log.counts;
      const counts = c ? ` open=${c.NakedEdges} nonmanifold=${c.NonManifoldEdges} flipped=${c.InvertedNormals} conflicts=${c.OrientationConflicts}` : '';
      const name = log.name ? ` name=${JSON.stringify(log.name)}` : '';
      console.log(`${new Date().toISOString()} ${req.method} ${log.path} ${res.statusCode} in=${log.bytesIn} out=${log.bytesOut} ${Math.round(performance.now() - t0)}ms format=${log.format}${counts}${name}`);
      if (!active) { for (const f of idleWaiters) f(); idleWaiters = []; }
    });
    handle(req, res, log).catch((err) => {
      if (res.headersSent || res.destroyed) return;
      if (err instanceof HttpError) {
        if (err.status === 0) return; // the client went away
        const hdrs = { ...err.headers };
        // The rest of the upload is not wanted: close the connection once the answer is out.
        if (bodyUnread) { hdrs.Connection = 'close'; res.once('finish', () => req.destroy()); }
        return send(res, err.status, { error: err.message }, hdrs);
      }
      console.error(new Date().toISOString(), 'internal error', err && err.stack ? err.stack : err);
      send(res, 500, { error: 'internal error' });
    });
  });
  server.requestTimeout = 0; // big uploads on slow links; the job timeout bounds the CPU work
  server.headersTimeout = 60000;

  return {
    server,
    pool,
    listen: (port = config.port, host = config.host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    /** Stop accepting, let in-flight requests finish for up to `graceMs`, then drop what is left. */
    async close(graceMs = 10000) {
      server.close();
      server.closeIdleConnections();
      if (active) await Promise.race([new Promise((r) => idleWaiters.push(r)), new Promise((r) => setTimeout(r, graceMs).unref())]);
      server.closeAllConnections();
      await pool.close();
    },
  };
}

// Run directly: node server/index.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  const api = createApi(config);
  const port = await api.listen();
  console.log(`hullpatch-api ${config.version} listening on ${config.host}:${port} (keys: ${config.keys.length ? 'configured' : 'none, API disabled'}, concurrency ${config.concurrency}, queue ${config.queue}, max ${config.maxBytes} bytes, ${config.maxTriangles} triangles, ${config.maxUncompressed / MiB} MB unpacked 3MF)`);
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig} received, shutting down`);
    await api.close(10000);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
