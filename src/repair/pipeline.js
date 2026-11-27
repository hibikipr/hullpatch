// The repair pipeline without any DOM or worker plumbing. The browser worker and the HTTP
// server both call it, so the two can never drift apart. Hooks are optional: the browser uses
// them for stage labels and the 3D views, the server leaves them out and pays for none of that.
import { parseStl, weld, analyze, repair, writeStl, meshVolume, orientedVolume, StlError } from './mesh.js';
import { parse3mf, transformVerts, ThreeMfError, write3mf } from './threemf.js';

export { StlError, ThreeMfError };

/**
 * A file too big for the memory this process may use. Only thrown when the caller passes
 * limits (the HTTP API does; the page doesn't, a browser tab has its own memory).
 * Peak memory is about 1.5 to 2 KB per triangle, so the triangle count is what to cap.
 */
export class TooLargeError extends Error {}

// Triangles in a binary STL, from its header, before anything is parsed (null for ASCII:
// those are about 250 bytes a triangle, so the upload size cap already keeps them small).
function binaryStlTriangles(buffer) {
  if (buffer.byteLength < 84) return null;
  const n = new DataView(buffer, 80, 4).getUint32(0, true);
  return 84 + n * 50 === buffer.byteLength ? n : null;
}

const fmt = (n) => n.toLocaleString('en-US');

// Triangles that get repaired cost the most memory (about 1.5-2 KB each at the peak).
function checkTriangles(n, limits) {
  if (limits && limits.maxTriangles && n > limits.maxTriangles) {
    throw new TooLargeError(`model too large for this server: ${fmt(n)} triangles to repair (limit ${fmt(limits.maxTriangles)})`);
  }
}

// Triangles that are only scanned and copied (3MF parts left as they are) cost about a
// quarter as much, so a project with many parts can be bigger as long as few need repair.
const scanLimit = (limits) => limits && (limits.maxScanTriangles || (limits.maxTriangles && limits.maxTriangles * 4));
function checkScanned(n, limits) {
  const max = scanLimit(limits);
  if (max && n > max) throw new TooLargeError(`model too large for this server: ${fmt(n)} triangles in all (limit ${fmt(max)})`);
}

/** True when the file is a 3MF: by name, or by the zip signature PK\x03\x04. */
export const is3mf = (buffer, name) => {
  if (/\.3mf$/i.test(name || '')) return true;
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return b.length === 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
};

/** The rule the page uses for "watertight": no open or shared-by-3+ edges, no flipped faces, no twisted edges. */
export const isWatertight = (a) => a.NakedEdges === 0 && a.NonManifoldEdges === 0 && a.InvertedNormals === 0 && !a.OrientationConflicts;

export const problemCount = (a) => a.NakedEdges + a.NonManifoldEdges + a.InvertedNormals + a.OrientationConflicts + a.DuplicateFaces + a.DegenerateFaces;

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

// Every normal object at every place it is printed, in file units, as one welded mesh (display and volume only).
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

// Readout counts for a 3MF: each object's own analysis, once per place it is printed.
// Not the assembled mesh: welding everything by position would rejoin edges the repair
// split on purpose (a 3MF keeps them apart by index) and merge parts that only touch.
function sumAnalyses(objs, analyses) {
  const total = {};
  let shells = 0;
  for (const o of objs) {
    const a = analyses.get(o.key);
    const n = o.placements.length;
    for (const k in a) if (typeof a[k] === 'number' && k !== 'DisjointShells') total[k] = (total[k] || 0) + a[k] * n;
    shells += (a.DisjointShells || 1) * n;
  }
  total.DisjointShells = shells > 1 ? shells : 0;
  return total;
}

// Volume of a 3MF: each part's own volume, once per place it is printed, scaled by that
// placement (Bambu can scale a part). Like sumAnalyses, not the assembled mesh: welding
// touching parts together by position changes what counts as inside.
function summedVolume(objs, volumeOf) {
  let total = 0;
  for (const o of objs) {
    const v = volumeOf(o);
    for (const m of o.placements) {
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      total += v * Math.abs(det);
    }
  }
  return total;
}

const noop = () => {};

/**
 * Hooks (all optional): onStage(name) with 'read' | 'scan' | 'repair' | 'verify',
 * onScan({ mesh, analysis, ...info }) once the "before" mesh is scanned, onProgress(0..1).
 */

/** Count problems in an STL without repairing it. */
export function analyzeStl(buffer, { limits } = {}) {
  checkTriangles(binaryStlTriangles(buffer) || 0, limits);
  const mesh = weld(parseStl(buffer));
  const analysis = analyze(mesh);
  return { analysis, volume: orientedVolume(mesh), watertight: isWatertight(analysis) };
}

/** Parse, scan, repair and re-scan an STL. Returns the fixed mesh and the bytes of the repaired STL. */
export function repairStl(buffer, { name = 'model.stl', limits, onStage = noop, onScan = noop, onProgress = noop } = {}) {
  onStage('read');
  checkTriangles(binaryStlTriangles(buffer) || 0, limits);
  const mesh = weld(parseStl(buffer));

  onStage('scan');
  const volumeBefore = orientedVolume(mesh);
  const before = analyze(mesh);
  onScan({ mesh, analysis: before, format: 'stl' });

  onStage('repair');
  const t0 = performance.now();
  const fixed = repair(mesh, onProgress);
  const timeFix = Math.round(performance.now() - t0);

  onStage('verify');
  const after = analyze(fixed);
  const volumeAfter = Math.abs(meshVolume(fixed));
  const stl = writeStl(fixed, 'hullpatch: ' + name);
  return { format: 'stl', timeFix, before, after, volumeBefore, volumeAfter, stl, fixed, watertight: isWatertight(after) };
}

/**
 * Read a 3MF and scan each normal part on its own. Cheap enough to run before asking which parts to repair.
 * `objects` is the list a picker shows; `problems` counts what is wrong in each part.
 */
export function open3mf(buffer, { limits } = {}) {
  let parsed;
  try {
    parsed = parse3mf(buffer, limits && limits.maxUncompressed ? { maxUncompressed: limits.maxUncompressed } : {});
  } catch (err) {
    if (limits && err instanceof ThreeMfError && /expands to more than/.test(err.message)) throw new TooLargeError(err.message);
    throw err;
  }
  const objs = parsed.objects.filter((o) => o.kind === 'normal');
  if (!objs.length) throw new ThreeMfError('this 3mf file has no printable mesh objects');
  // Before welding: every part is welded and scanned, and placed once per copy in the
  // assembled model. The parts to repair are checked again in repair3mf, once they are known.
  checkScanned(objs.reduce((s, o) => s + (o.faces.length / 3) * Math.max(1, o.placements.length), 0), limits);

  // Each object on its own, in its own coordinates (triangle order = file order).
  const meshes = new Map();
  const scans = new Map();
  for (const o of objs) {
    const mesh = weld(soupOf(o.verts, o.faces, null));
    meshes.set(o.key, mesh);
    scans.set(o.key, analyze(mesh));
  }
  const objects = objs.map((o) => ({ key: o.key, name: o.name, group: o.group, plate: o.plate, triangles: o.faces.length / 3, problems: problemCount(scans.get(o.key)) }));
  const groups = new Set(objs.map((o) => o.group)).size;
  return { parsed, objs, meshes, scans, objects, groups, limits };
}

/** Counts, volume and per-part list for an opened 3MF, no repair. */
export function analyze3mf(opened) {
  const analysis = sumAnalyses(opened.objs, opened.scans);
  const volume = summedVolume(opened.objs, (o) => orientedVolume(opened.meshes.get(o.key)));
  return { analysis, volume, watertight: isWatertight(analysis), parts: opened.objects.map(({ name, group, plate, triangles, problems }) => ({ name, group, plate, triangles, problems })) };
}

/**
 * Repair the parts named in `keys` of an opened 3MF. Returns the new 3MF bytes and the numbers.
 * `afterMesh` (all normal parts placed, welded) is there for an STL download or a 3D view.
 */
export function repair3mf(opened, keys, { onStage = noop, onScan = noop, onProgress = noop } = {}) {
  const { parsed, objs, meshes, scans } = opened;
  const known = new Set(objs.map((o) => o.key));
  const chosen = keys.filter((k) => known.has(k));
  const byKey = new Map(objs.map((o) => [o.key, o]));
  checkTriangles(chosen.reduce((s, k) => s + byKey.get(k).faces.length / 3, 0), opened.limits);

  onStage('scan');
  const beforeMesh = assemble(objs, meshes);
  const before = sumAnalyses(objs, scans);
  onScan({ mesh: beforeMesh, analysis: before, format: '3mf', unit: parsed.unit, objectCount: objs.length, chosen: chosen.length });
  const volumeBefore = summedVolume(objs, (o) => orientedVolume(meshes.get(o.key)));

  onStage('repair');
  const t0 = performance.now();
  const total = chosen.reduce((s, k) => s + byKey.get(k).faces.length, 0) || 1;
  const results = new Map();
  const fixedMeshes = new Map(meshes);
  let done = 0, last = 0;
  for (const key of chosen) {
    const w = byKey.get(key).faces.length;
    const res = repair(meshes.get(key), (p) => {
      last = Math.max(last, (done + w * p) / total); // keep it monotonic across objects
      onProgress(last);
    });
    done += w;
    results.set(key, res);
    fixedMeshes.set(key, res);
  }
  const timeFix = Math.round(performance.now() - t0);

  onStage('verify');
  const afterMesh = assemble(objs, fixedMeshes);
  const afterScans = new Map(scans);
  for (const [key, res] of results) afterScans.set(key, analyze(res));
  const after = sumAnalyses(objs, afterScans);
  const volumeAfter = summedVolume(objs, (o) => (results.has(o.key) ? Math.abs(meshVolume(results.get(o.key))) : orientedVolume(meshes.get(o.key))));
  const { bytes, paintLost } = write3mf(parsed, results);
  return { format: '3mf', timeFix, before, after, volumeBefore, volumeAfter, bytes, paintLost, afterMesh, watertight: isWatertight(after) };
}
