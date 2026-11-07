// Builds deliberately broken meshes and checks the repair engine fixes them.
import { parseStl, weld, analyze, repair, writeStl } from '../src/repair/mesh.js';

const CUBE = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
const corners = (x0, y0, z0, s) => [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]
  .map(([x, y, z]) => [x0 + x * s, y0 + y * s, z0 + z * s]);

function toStl(tris) { // tris: [[p,p,p], ...]
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf); dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) { o += 12; for (const p of t) for (const c of p) { dv.setFloat32(o, c, true); o += 4; } o += 2; }
  return buf;
}

function volume(m) {
  let vol = 0; const v = m.verts, f = m.faces;
  for (let i = 0; i < f.length; i += 3) { const [A,B,C] = [f[i]*3,f[i+1]*3,f[i+2]*3];
    vol += (v[A]*(v[B+1]*v[C+2]-v[B+2]*v[C+1]) - v[A+1]*(v[B]*v[C+2]-v[B+2]*v[C]) + v[A+2]*(v[B]*v[C+1]-v[B+1]*v[C]))/6; }
  return vol;
}

/** What a slicer sees: vertices matched by exact float32 position, every edge used by exactly two faces, run opposite ways. */
function slicerClean(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf), n = dv.getUint32(80, true);
  const ids = new Map(), faces = [];
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const o = 84 + t * 50 + 12 + k * 12, key = b.subarray(o, o + 12).join(',');
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

let ok = true;
const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); ok = ok && cond; };

// 1. Cube with a hole, a flipped face, a duplicate face and a degenerate face.
{
  const P = corners(0, 0, 0, 1);
  const t = CUBE.slice();
  t.splice(10, 2);    // remove the -x side: a planar square hole
  t[0] = [0,1,2];     // flip one face
  t.push([4,5,6]);    // duplicate face
  t.push([4,4,6]);    // degenerate face
  const mesh = weld(parseStl(toStl(t.map((tri) => tri.map((i) => P[i])))));
  const a = analyze(mesh);
  const fixed = repair(mesh);
  const out = writeStl(fixed);
  const b = analyze(weld(parseStl(out)));
  check('broken cube: problems found', a.NakedEdges === 4 && a.PlanarHoles === 1 && a.DuplicateFaces === 1 && a.DegenerateFaces === 1 && a.InvertedNormals >= 1);
  check('broken cube: repaired', b.NakedEdges === 0 && b.InvertedNormals === 0 && b.DuplicateFaces === 0 && b.DegenerateFaces === 0 && fixed.faces.length / 3 === 12);
  check('broken cube: volume 1', Math.abs(volume(fixed) - 1) < 1e-6);
  check('broken cube: slicer sees a clean solid', slicerClean(out));
}

// 2. Two cubes glued face to face (an internal double wall: the same triangles wound
//    both ways, as CAD exports of joined bodies leave them) plus a speck.
{
  const A = corners(0, 0, 0, 1), B = corners(1, 0, 0, 1), S = corners(5, 5, 5, 1e-4);
  const cubeB = CUBE.slice(0, 10).concat([[0,7,3],[0,4,7]]); // -x side split like A's +x side
  const tris = [...CUBE.map((t) => t.map((i) => A[i])), ...cubeB.map((t) => t.map((i) => B[i])), ...CUBE.map((t) => t.map((i) => S[i]))];
  const mesh = weld(parseStl(toStl(tris)));
  const a = analyze(mesh);
  const fixed = repair(mesh);
  const out = writeStl(fixed);
  const b = analyze(weld(parseStl(out)));
  check('glued cubes: problems found', a.NonManifoldEdges === 5 && a.DuplicateFaces === 2);
  check('glued cubes: internal wall removed, manifold', b.NonManifoldEdges === 0 && b.NakedEdges === 0 && b.InvertedNormals === 0);
  check('glued cubes: speck dropped, one shell', b.DisjointShells === 0);
  check('glued cubes: volume 2', Math.abs(volume(fixed) - 2) < 1e-6);
  check('glued cubes: slicer sees a clean solid', slicerClean(out));
}

// 3. Same, but the shared side is split along the other diagonal on each cube, so the
//    wall faces do not match. The repair must not change the shape trying to fix it.
{
  const A = corners(0, 0, 0, 1), B = corners(1, 0, 0, 1);
  const tris = [...CUBE.map((t) => t.map((i) => A[i])), ...CUBE.map((t) => t.map((i) => B[i]))];
  const fixed = repair(weld(parseStl(toStl(tris))));
  check('mismatched wall: volume kept at 2', Math.abs(volume(fixed) - 2) < 1e-6);
}

console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
