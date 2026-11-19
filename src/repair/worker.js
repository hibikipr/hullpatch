// Runs the repair off the main thread: read, scan, repair, then scan the result again.
import { parseStl, weld, analyze, repair, writeStl, toTriangles, nakedSegments, meshVolume, orientedVolume, problemFaces, StlError } from './mesh.js';
import { parse3mf, transformVerts, ThreeMfError, write3mf } from './threemf.js';

// Draw every triangle up to this many; bigger meshes are sampled for the pictures.
const PREVIEW_TRIS = 1000000;

const is3mf = (buffer, name) => {
  if (/\.3mf$/i.test(name || '')) return true;
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return b.length === 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4; // PK\x03\x04
};

// Indexed mesh -> triangle soup, optionally placed; a mirror flips winding so faces still point out.
function soupOf(verts, faces, m) {
  const v = m ? transformVerts(verts, m) : verts;
  const flip = m && m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]) < 0;
  const out = new Float64Array(faces.length * 3);
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + (flip ? 2 : 1)], c = faces[i + (flip ? 1 : 2)];
    out.set(v.subarray(a * 3, a * 3 + 3), i * 3);
    out.set(v.subarray(b * 3, b * 3 + 3), i * 3 + 3);
    out.set(v.subarray(c * 3, c * 3 + 3), i * 3 + 6);
  }
  return out;
}

// Every normal object at every place it is printed, in file units, as one welded mesh (display only).
function assemble(objs, meshes) {
  const parts = [];
  let n = 0;
  for (const o of objs) {
    const mesh = meshes.get(o.key);
    for (const m of o.placements) {
      const s = soupOf(mesh.verts, mesh.faces, m);
      parts.push(s);
      n += s.length;
    }
  }
  const all = new Float64Array(n);
  let at = 0;
  for (const s of parts) { all.set(s, at); at += s.length; }
  return weld(all);
}

const problemCount = (a) => a.NakedEdges + a.NonManifoldEdges + a.InvertedNormals + a.OrientationConflicts + a.DuplicateFaces + a.DegenerateFaces;

// The next message of type `type`; anything else sent meanwhile is ignored.
function waitFor(type) {
  return new Promise((resolve) => {
    const prev = self.onmessage;
    self.onmessage = (e) => {
      if (!e.data || e.data.type !== type) return;
      self.onmessage = prev;
      resolve(e.data);
    };
  });
}

// Scan a mesh for the 3D "before" view: counts, picture, hole outlines and a problem flag per face.
function scanMessage(mesh, send, extra) {
  const before = analyze(mesh);
  const beforeTris = toTriangles(mesh, PREVIEW_TRIS);
  const holes = nakedSegments(mesh);
  // The welded mesh plus a problem flag per face, for the coloured 3D "before" view.
  const problems = {
    verts: Float32Array.from(mesh.verts),
    faces: mesh.faces.slice(),
    flags: problemFaces(mesh),
  };
  send(
    { type: 'analysis', analysis: before, before: beforeTris, holes, problems, ...extra },
    [beforeTris.buffer, holes.buffer, problems.verts.buffer, problems.faces.buffer, problems.flags.buffer],
  );
  return before;
}

async function run3mf(buffer, send) {
  send({ type: 'stage', stage: 'read' });
  const parsed = parse3mf(buffer);
  const objs = parsed.objects.filter((o) => o.kind === 'normal');
  if (!objs.length) throw new ThreeMfError('this 3mf file has no printable mesh objects');

  // Each object on its own, in its own coordinates (triangle order = file order).
  const meshes = new Map();
  const scans = new Map();
  for (const o of objs) {
    const mesh = weld(soupOf(o.verts, o.faces, null));
    meshes.set(o.key, mesh);
    scans.set(o.key, analyze(mesh));
  }

  let chosen = objs.map((o) => o.key);
  if (objs.length > 1) {
    send({
      type: 'objects',
      objects: objs.map((o) => ({ key: o.key, name: o.name, triangles: o.faces.length / 3, problems: problemCount(scans.get(o.key)) })),
    });
    const msg = await waitFor('choose');
    const known = new Set(objs.map((o) => o.key));
    chosen = (msg.keys || []).filter((k) => known.has(k));
  }

  send({ type: 'stage', stage: 'scan' });
  const beforeMesh = assemble(objs, meshes);
  const before = scanMessage(beforeMesh, send, { format: '3mf', unit: parsed.unit, objectCount: objs.length, chosen: chosen.length });
  const volumeBefore = orientedVolume(beforeMesh);
  const beforeStl = writeStl(beforeMesh, 'hullpatch before');

  send({ type: 'stage', stage: 'repair' });
  const t0 = performance.now();
  const byKey = new Map(objs.map((o) => [o.key, o]));
  const total = chosen.reduce((s, k) => s + byKey.get(k).faces.length, 0) || 1;
  const results = new Map();
  const fixedMeshes = new Map(meshes);
  let done = 0, last = 0;
  for (const key of chosen) {
    const w = byKey.get(key).faces.length;
    const res = repair(meshes.get(key), (p) => {
      last = Math.max(last, (done + w * p) / total); // keep it monotonic across objects
      send({ type: 'progress', progress: last });
    });
    done += w;
    results.set(key, res);
    fixedMeshes.set(key, res);
  }
  const timeFix = Math.round(performance.now() - t0);

  send({ type: 'stage', stage: 'verify' });
  const afterMesh = assemble(objs, fixedMeshes);
  const after = analyze(afterMesh);
  const volumeAfter = Math.abs(meshVolume(afterMesh));
  const { bytes, paintLost } = write3mf(parsed, results);
  const stl = bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer;
  const afterStl = writeStl(afterMesh, 'hullpatch after');
  const afterTris = toTriangles(afterMesh, PREVIEW_TRIS);

  send(
    { type: 'done', timeFix, before, after, volumeBefore, volumeAfter, stl, afterTris, format: '3mf', paintLost, afterStl, beforeStl },
    [stl, afterTris.buffer, afterStl, beforeStl],
  );
}

function runStl(buffer, name, send) {
  send({ type: 'stage', stage: 'read' });
  const mesh = weld(parseStl(buffer));

  send({ type: 'stage', stage: 'scan' });
  const volumeBefore = orientedVolume(mesh);
  const before = scanMessage(mesh, send, { format: 'stl' });

  send({ type: 'stage', stage: 'repair' });
  const t0 = performance.now();
  const fixed = repair(mesh, (p) => send({ type: 'progress', progress: p }));
  const timeFix = Math.round(performance.now() - t0);

  send({ type: 'stage', stage: 'verify' });
  const after = analyze(fixed);
  const volumeAfter = Math.abs(meshVolume(fixed));
  const stl = writeStl(fixed, ('hullpatch: ' + name).slice(0, 80));
  const afterTris = toTriangles(fixed, PREVIEW_TRIS);

  send(
    { type: 'done', timeFix, before, after, volumeBefore, volumeAfter, stl, afterTris, format: 'stl' },
    [stl, afterTris.buffer],
  );
}

self.onmessage = async (e) => {
  const { buffer, name } = e.data;
  const send = (msg, transfer) => self.postMessage(msg, transfer || []);
  try {
    if (is3mf(buffer, name)) await run3mf(buffer, send);
    else runStl(buffer, name, send);
  } catch (err) {
    send({
      type: 'error',
      message: err instanceof StlError || err instanceof ThreeMfError ? err.message : 'an unexpected error occurred (' + (err && err.message) + ')',
    });
  }
};
