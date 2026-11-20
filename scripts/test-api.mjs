// Starts the HTTP API in-process on random ports and exercises it with real requests.
import http from 'node:http';
import { createApi, configFromEnv } from '../server/index.js';
import { zipSync, unzipSync, strToU8 } from 'fflate';

const KEY = 'test-key-123';
let ok = true;
const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); ok = ok && cond; };

const CUBE = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
const P = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const brokenTris = CUBE.slice(0, 10); // the -x side is missing: a square hole

function toStl(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) { o += 12; for (const i of t) for (const c of P[i]) { buf.writeFloatLE(c, o); o += 4; } o += 2; }
  return buf;
}
function slicerClean(b) {
  const n = b.readUInt32LE(80), ids = new Map(), faces = [];
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const key = b.subarray(84 + t * 50 + 12 + k * 12, 84 + t * 50 + 24 + k * 12).join(',');
    if (!ids.has(key)) ids.set(key, ids.size);
    faces.push(ids.get(key));
  }
  const edges = new Map();
  for (let f = 0; f < n; f++) for (let k = 0; k < 3; k++) {
    const a = faces[f*3+k], c = faces[f*3+(k+1)%3], key = Math.min(a,c) + ',' + Math.max(a,c);
    edges.set(key, (edges.get(key) || []).concat(a < c ? 1 : -1));
  }
  for (const e of edges.values()) if (e.length !== 2 || e[0] === e[1]) return false;
  return true;
}
const mesh3mf = () => `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="Cube"><mesh><vertices>${P.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${brokenTris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
const CT = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
const threeMf = Buffer.from(zipSync({ '[Content_Types].xml': strToU8(CT), '_rels/.rels': strToU8(RELS), '3D/3dmodel.model': strToU8(mesh3mf()) }));
const stl = toStl(brokenTris);

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(body ? { 'Content-Length': body.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: buf, json: () => JSON.parse(buf.toString()) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const auth = { Authorization: 'Bearer ' + KEY };
const post = (port, path, body, type = 'application/octet-stream', extra = {}) => request(port, 'POST', path, { headers: { ...auth, 'Content-Type': type, ...extra }, body });

function multipart(filename, data, extraField = true) {
  const b = '----hullpatch' + 'x'.repeat(8);
  const parts = [];
  if (extraField) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

// Keep the request log from drowning the test output, and check it never leaks the key.
const logged = [];
const realLog = console.log;
console.log = (...a) => logged.push(a.join(' '));
const say = (...a) => realLog(...a);
const check2 = (n, c) => { console.log = realLog; check(n, c); console.log = (...a) => logged.push(a.join(' ')); };

const base = { keys: [KEY], concurrency: 2, queue: 4, version: 'test', maxBytes: 5000, timeoutMs: 20000, jobDelayMs: 0 };
const mk = async (over) => { const api = createApi(configFromEnv({}, { ...base, ...over })); return { api, port: await api.listen(0, '127.0.0.1') }; };

const main = await mk({});
const port = main.port;
try {
  let r = await request(port, 'GET', '/api/v1/health'); let j;
  check2('api: health 200 with keys flag', r.status === 200 && r.body.toString() === '{"status":"ok","version":"test","keys":true}');
  check2('api: nosniff header', r.headers['x-content-type-options'] === 'nosniff' && !r.headers['access-control-allow-origin']);
  r = await request(port, 'POST', '/api/v1/repair', { body: stl });
  check2('api: no key -> 401 + WWW-Authenticate', r.status === 401 && r.headers['www-authenticate'] === 'Bearer');
  r = await request(port, 'POST', '/api/v1/repair', { headers: { Authorization: 'Bearer wrong' }, body: stl });
  check2('api: wrong key -> 401', r.status === 401);
  r = await request(port, 'GET', '/api/v1/repair', { headers: auth });
  check2('api: GET repair -> 405 with Allow', r.status === 405 && r.headers.allow === 'POST');
  r = await request(port, 'GET', '/api/v1/nope');
  check2('api: unknown path -> 404 JSON', r.status === 404 && !!r.json().error);

  r = await post(port, '/api/v1/repair', stl, 'model/stl');
  const rep = r.headers['hullpatch-report'] || '';
  check2('api: repair STL -> watertight STL', r.status === 200 && r.headers['content-type'] === 'model/stl' && /watertight=1/.test(rep) && /open=0; nonmanifold=0; flipped=0; conflicts=0/.test(rep) && slicerClean(r.body));
  check2('api: Content-Disposition', /filename="model_fixed\.stl"/.test(r.headers['content-disposition']) && /filename\*=UTF-8''model_fixed\.stl/.test(r.headers['content-disposition']));

  const mp = multipart('my part (é).STL', stl);
  r = await post(port, '/api/v1/repair', mp.body, mp.type);
  check2('api: multipart repair, name from the part', r.status === 200 && slicerClean(r.body) && r.headers['content-disposition'].includes('filename="my part ____fixed.stl"') && /%C3%A9/.test(r.headers['content-disposition']));
  // A file whose bytes contain CRLF and boundary-like text must survive intact.
  const tricky = Buffer.concat([stl, Buffer.from('\r\n--not-the-boundary\r\n')]);
  const mp2 = multipart('t.stl', tricky, false);
  r = await post(port, '/api/v1/repair', mp2.body, mp2.type);
  check2('api: multipart keeps binary content', r.status === 200 && slicerClean(r.body));
  r = await post(port, '/api/v1/repair?name=../../etc/pa"ss.stl', stl, 'application/octet-stream');
  check2('api: name sanitised', r.status === 200 && /filename="pa_ss_fixed\.stl"/.test(r.headers['content-disposition']));

  r = await post(port, '/api/v1/repair?report=json', stl, 'model/stl');
  j = r.json();
  check2('api: report=json shape', r.status === 200 && j.watertight === true && j.before.NakedEdges === 4 && j.after.NakedEdges === 0 && Math.abs(j.volumeAfter - 1) < 1e-6 && j.format === 'stl' && j.filename === 'model_fixed.stl' && slicerClean(Buffer.from(j.file, 'base64')) && !('paintLost' in j));

  r = await post(port, '/api/v1/analyze', stl, 'model/stl');
  j = r.json();
  check2('api: analyze STL counts, no repair', r.status === 200 && j.format === 'stl' && j.analysis.NakedEdges === 4 && j.watertight === false && Math.abs(j.volume) > 0 && !r.headers['content-disposition']);

  r = await post(port, '/api/v1/repair', threeMf);
  const files = r.status === 200 ? unzipSync(new Uint8Array(r.body)) : {};
  check2('api: 3MF in -> 3MF out (PK)', r.status === 200 && r.headers['content-type'] === 'model/3mf' && r.body[0] === 0x50 && r.body[1] === 0x4b && /watertight=1/.test(r.headers['hullpatch-report']) && !!files['3D/3dmodel.model'] && /_fixed\.3mf"/.test(r.headers['content-disposition']));
  r = await post(port, '/api/v1/repair?format=stl', threeMf);
  check2('api: 3MF ?format=stl -> STL', r.status === 200 && r.headers['content-type'] === 'model/stl' && r.body.readUInt32LE(80) === 12 && slicerClean(r.body));
  r = await post(port, '/api/v1/repair?parts=all&report=json', threeMf);
  j = r.json();
  check2('api: 3MF parts=all, json has paintLost', r.status === 200 && j.format === '3mf' && j.paintLost === 0 && j.watertight === true);
  r = await post(port, '/api/v1/analyze', threeMf);
  j = r.json();
  check2('api: analyze 3MF lists parts', r.status === 200 && j.format === '3mf' && j.parts.length === 1 && j.parts[0].name === 'Cube' && j.parts[0].triangles === 10 && j.parts[0].problems > 0);
  r = await post(port, '/api/v1/repair?format=3mf', stl, 'model/stl');
  check2('api: STL ?format=3mf -> 422', r.status === 422 && r.json().error === 'STL input can only be returned as STL');

  r = await post(port, '/api/v1/repair', Buffer.from('this is not a mesh at all, just text'), 'application/octet-stream');
  check2('api: garbage -> 422 with message', r.status === 422 && typeof r.json().error === 'string' && r.json().error.length > 0);
  r = await post(port, '/api/v1/repair', Buffer.from('PK\x03\x04 broken zip'), 'application/octet-stream');
  check2('api: broken 3MF -> 422', r.status === 422);
  r = await request(port, 'POST', '/api/v1/repair', { headers: { ...auth, 'Content-Length': '0' } });
  check2('api: empty body -> 400', r.status === 400);
  r = await post(port, '/api/v1/repair', Buffer.alloc(6000, 1), 'model/stl');
  check2('api: Content-Length over the limit -> 413', r.status === 413);
  // Chunked, no Content-Length: stopped while streaming.
  r = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/v1/repair', headers: { ...auth, 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', () => resolve({ status: 'error' }));
    req.write(Buffer.alloc(3000)); req.write(Buffer.alloc(3000)); req.end();
  });
  check2('api: chunked body over the limit -> 413', r.status === 413);
  check2('api: log has no key, one line per request', logged.length > 20 && !logged.some((l) => l.includes(KEY) || /authorization/i.test(l)) && logged.some((l) => /POST \/api\/v1\/repair 200 in=\d+ out=\d+ \d+ms format=stl open=0/.test(l)));
} finally { await main.api.close(500); }

{ // No keys configured: fail closed.
  const s = await mk({ keys: [] });
  let r = await request(s.port, 'GET', '/api/v1/health');
  const h = r.json();
  r = await post(s.port, '/api/v1/repair', stl, 'model/stl', {});
  check2('api: no keys -> 503 and health keys:false', r.status === 503 && r.json().error === 'API disabled: set HULLPATCH_API_KEYS' && h.keys === false);
  await s.api.close(500);
}

{ // Queue full: one slot, no queue, jobs held for 700 ms.
  const s = await mk({ concurrency: 1, queue: 0, jobDelayMs: 700 });
  const first = post(s.port, '/api/v1/repair', stl, 'model/stl');
  while (s.api.pool.running < 1) await new Promise((r) => setTimeout(r, 10));
  const second = await post(s.port, '/api/v1/repair', stl, 'model/stl');
  const health = await request(s.port, 'GET', '/api/v1/health');
  check2('api: queue full -> 429 + Retry-After', second.status === 429 && second.headers['retry-after'] === '10');
  check2('api: health answers while a repair runs', health.status === 200);
  check2('api: the running job still finishes', (await first).status === 200);
  await s.api.close(500);
}

{ // Timeout: the worker is terminated and replaced.
  const s = await mk({ concurrency: 1, queue: 0, timeoutMs: 150, jobDelayMs: 800 });
  const r = await post(s.port, '/api/v1/repair', stl, 'model/stl');
  check2('api: job timeout -> 503', r.status === 503 && r.json().error === 'repair took too long');
  await new Promise((res) => setTimeout(res, 100));
  check2('api: the pool is whole again after a timeout', s.api.pool.workers.length === 1 && s.api.pool.running === 0);
  await s.api.close(500);
}

{ // Memory guards: a model over the triangle or unpacked-size limit is refused with 413
  // before the expensive steps, and a file within the limits still repairs.
  const s = await mk({ maxTriangles: 9 }); // the fixture has 10 triangles
  const a = await post(s.port, '/api/v1/repair', stl, 'model/stl');
  check2('api: STL over the triangle limit -> 413', a.status === 413 && /10 triangles to repair \(limit 9\)/.test(a.json().error));
  const b = await post(s.port, '/api/v1/repair', threeMf, 'model/3mf');
  check2('api: 3MF part to repair over the limit -> 413', b.status === 413 && /to repair \(limit 9\)/.test(b.json().error));
  const c = await post(s.port, '/api/v1/analyze', stl, 'model/stl');
  check2('api: analyze is guarded too', c.status === 413);
  // A clean part over the repair limit isn't repaired, so only the (4x) scan limit applies:
  // a big project where only small parts need fixing still goes through.
  const clean = mesh3mf().replace(/<triangles>.*<\/triangles>/, `<triangles>${CUBE.map(([x, y, z]) => `<triangle v1="${x}" v2="${y}" v3="${z}"/>`).join('')}</triangles>`);
  const clean3mf = Buffer.from(zipSync({ '[Content_Types].xml': strToU8(CT), '_rels/.rels': strToU8(RELS), '3D/3dmodel.model': strToU8(clean) }));
  const f = await post(s.port, '/api/v1/repair', clean3mf, 'model/3mf');
  check2('api: 3MF with nothing to repair passes under the scan limit', f.status === 200);
  await s.api.close(500);

  const u = await mk({ maxTriangles: 2 }); // scan limit 8 < 10 triangles in the file
  const g = await post(u.port, '/api/v1/analyze', threeMf, 'model/3mf');
  check2('api: 3MF over the scan limit -> 413', g.status === 413 && /10 triangles in all \(limit 8\)/.test(g.json().error));
  await u.api.close(500);

  const t = await mk({ maxUncompressed: 200 });
  const d = await post(t.port, '/api/v1/repair', threeMf, 'model/3mf');
  check2('api: 3MF that unpacks past the limit -> 413', d.status === 413 && /expands to more than/.test(d.json().error));
  const e = await post(t.port, '/api/v1/repair', stl, 'model/stl');
  check2('api: a file within the limits still repairs', e.status === 200 && /watertight=1/.test(e.headers['hullpatch-report']));
  await t.api.close(500);

  // The bytes win over a wrong Content-Type: a zip sent as model/stl is still a 3MF.
  const v = await mk({});
  const w = await post(v.port, '/api/v1/repair', threeMf, 'model/stl');
  check2('api: a 3MF sent as model/stl is still repaired as a 3MF', w.status === 200 && w.headers['content-type'] === 'model/3mf' && w.body[0] === 0x50 && w.body[1] === 0x4b);
  await v.api.close(500);
}

console.log = realLog;
say(ok ? 'PASS (api)' : 'FAIL (api)');
process.exit(ok ? 0 : 1);
