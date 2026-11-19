// Builds deliberately broken meshes and checks the repair engine fixes them.
import { parseStl, weld, analyze, repair, writeStl, problemFaces, meshVolume, PROBLEM_OPEN, PROBLEM_WALL, PROBLEM_FLIPPED } from '../src/repair/mesh.js';
import { parse3mf, write3mf, ThreeMfError } from '../src/repair/threemf.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

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
  // Per-face flags for the coloured "before" view: the four faces along the hole,
  // the flipped bottom face, and both copies of the duplicate top face.
  const flags = problemFaces(mesh);
  const openFaces = flags.reduce((n, f) => n + (f & PROBLEM_OPEN ? 1 : 0), 0);
  check('broken cube: problem faces flagged', openFaces === 4 && (flags[0] & PROBLEM_FLIPPED) && (flags[2] & PROBLEM_WALL) && (flags[10] & PROBLEM_WALL) && !(flags[5] & PROBLEM_FLIPPED));
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

/* ------------------------------------------------------------------ */
/* 3MF fixtures (generated in code)                                    */
/* ------------------------------------------------------------------ */

const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const UNIT_CUBE = corners(0, 0, 0, 1);

/** <mesh> XML. tris: [a, b, c, extraAttrs?]. */
function meshXml(P, tris) {
  return '<mesh>\n   <vertices>\n' + P.map(([x, y, z]) => `    <vertex x="${x}" y="${y}" z="${z}"/>`).join('\n')
    + '\n   </vertices>\n   <triangles>\n' + tris.map(([a, b, c, x = '']) => `    <triangle v1="${a}" v2="${b}" v3="${c}"${x}/>`).join('\n')
    + '\n   </triangles>\n  </mesh>';
}
const objectXml = (id, mesh, attrs = ' type="model"') => `  <object id="${id}"${attrs}>\n  ${mesh}\n  </object>`;
function modelXml({ unit = 'millimeter', objects, items, ns = '' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${ns}>\n <resources>\n${objects}\n </resources>\n <build>\n${items}\n </build>\n</model>\n`;
}
const CT = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
function zip3mf(files) {
  const out = {};
  for (const k in files) out[k] = typeof files[k] === 'string' ? strToU8(files[k]) : files[k];
  return zipSync(out);
}
const itemXml = (id, transform) => `  <item objectid="${id}"${transform ? ` transform="${transform}"` : ''}/>`;
const CUBE_TRIS = (skip = []) => CUBE.map((t, i) => [...t]).filter((_, i) => !skip.includes(i));
const CUBE_HOLE = [10, 11]; // the -x side

/** An object's mesh as a welded engine mesh, triangle order = file order (like the worker does). */
function meshOfObject(o) {
  const soup = new Float64Array(o.faces.length * 3);
  for (let i = 0; i < o.faces.length; i++) soup.set(o.verts.subarray(o.faces[i] * 3, o.faces[i] * 3 + 3), i * 3);
  return weld(soup);
}
const triTags = (xml) => [...xml.matchAll(/<triangle\b([^>]*)\/>/g)].map((m) => m[1]);
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
const objectInner = (xml, id) => new RegExp(`<object id="${id}"[^>]*>[\\s\\S]*?</object>`).exec(xml)[0];
const clean = (a) => a.NakedEdges === 0 && a.NonManifoldEdges === 0 && a.InvertedNormals === 0 && a.OrientationConflicts === 0;

// A Bambu-style production 3MF: root object 3 = two components living in a sub-model file.
function bambuFile({ normalTris = CUBE_TRIS(), negTris = CUBE_TRIS(), settings = true, extra = {} } = {}) {
  const sub = modelXml({
    objects: objectXml(1, meshXml(UNIT_CUBE, normalTris), ' type="model"') + '\n' + objectXml(2, meshXml(corners(0.25, 0.25, 0.25, 0.5), negTris), ' type="model"'),
    items: '',
  });
  const root = modelXml({
    ns: ` xmlns:p="${PROD_NS}"`,
    objects: `  <object id="3" type="model">\n   <components>\n    <component p:path="/3D/Objects/object_1.model" objectid="1"/>\n    <component p:path="/3D/Objects/object_1.model" objectid="2"/>\n   </components>\n  </object>`,
    items: itemXml(3),
  });
  const cfg = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="3">\n  <metadata key="name" value="Thing"/>\n  <part id="1" subtype="normal_part">\n   <metadata key="name" value="Body"/>\n  </part>\n  <part id="2" subtype="negative_part">\n   <metadata key="name" value="Hole"/>\n  </part>\n </object>\n</config>\n';
  return { '[Content_Types].xml': CT, '_rels/.rels': RELS, '3D/3dmodel.model': root, '3D/Objects/object_1.model': sub, ...(settings ? { 'Metadata/model_settings.config': cfg } : {}), ...extra };
}

// The worker, driven in Node: it needs a `self` with postMessage and registers self.onmessage at import.
let messages = [];
globalThis.self = { postMessage: (m) => messages.push(m) };
await import('../src/repair/worker.js');
async function runWorker(buffer, name, choose) {
  messages = [];
  const p = self.onmessage({ data: { buffer, name } });
  if (choose) {
    const objs = messages.find((m) => m.type === 'objects');
    if (objs) self.onmessage({ data: { type: 'choose', keys: choose(objs.objects) } });
  }
  await p;
  return messages.slice();
}

// 4. Core-spec 3MF: one cube, build item with a translation.
{
  const buf = zip3mf({ '[Content_Types].xml': CT, '_rels/.rels': RELS, '3D/3dmodel.model': modelXml({ objects: objectXml(1, meshXml(UNIT_CUBE, CUBE_TRIS()), ' type="model" name="Cube"'), items: itemXml(1, '1 0 0 0 1 0 0 0 1 10 20 30') }) });
  const p = parse3mf(buf);
  const o = p.objects[0];
  check('3mf core: one object, 8 verts, 12 faces', p.objects.length === 1 && o.verts.length === 24 && o.faces.length === 36 && o.name === 'Cube' && o.kind === 'normal');
  check('3mf core: unit millimeter, translation placement', p.unit === 'millimeter' && o.placements.length === 1 && [...o.placements[0].slice(9)].join() === '10,20,30' && o.key === '3D/3dmodel.model#1');
  const inch = parse3mf(zip3mf({ '3D/3dmodel.model': modelXml({ unit: 'inch', objects: objectXml(1, meshXml(UNIT_CUBE, CUBE_TRIS())), items: itemXml(1) }) }));
  check('3mf: unit inch', inch.unit === 'inch');
}

// 5. Bambu production 3MF: components with p:path into a sub-model, part types from model_settings.config.
{
  const p = parse3mf(zip3mf(bambuFile()));
  const [a, b] = p.objects;
  check('bambu: both sub-model objects found with keys and paths', p.objects.length === 2
    && a.key === '3D/Objects/object_1.model#1' && a.path === '3D/Objects/object_1.model' && b.key === '3D/Objects/object_1.model#2' && b.path === a.path);
  check('bambu: part kinds normal and negative, names from settings', a.kind === 'normal' && b.kind === 'negative' && a.name === 'Body' && b.name === 'Hole');
  check('bambu: no settings file means all normal', parse3mf(zip3mf(bambuFile({ settings: false }))).objects.every((o) => o.kind === 'normal'));
}

// 6. Several objects, one mirrored: the worker's chosen object is repaired, mirror handled when assembling.
{
  const mirror = '-1 0 0 0 1 0 0 0 1 30 0 0';
  const buf = zip3mf({ '[Content_Types].xml': CT, '_rels/.rels': RELS, '3D/3dmodel.model': modelXml({
    objects: objectXml(1, meshXml(UNIT_CUBE, CUBE_TRIS())) + '\n' + objectXml(2, meshXml(UNIT_CUBE, CUBE_TRIS(CUBE_HOLE))),
    items: itemXml(1) + '\n' + itemXml(2, mirror),
  }) });
  const msgs = await runWorker(buf, 'two.3mf', (objs) => [objs.find((o) => o.problems > 0).key]);
  const list = msgs.find((m) => m.type === 'objects'), analysis = msgs.find((m) => m.type === 'analysis'), done = msgs.find((m) => m.type === 'done'), err = msgs.find((m) => m.type === 'error');
  check('mirror: objects message lists both objects, only the holed one has problems', !err && list && list.objects.length === 2 && list.objects.filter((o) => o.problems > 0).length === 1);
  check('mirror: analysis sees 2 objects, 1 chosen', analysis && analysis.format === '3mf' && analysis.objectCount === 2 && analysis.chosen === 1);
  check('mirror: after repair clean, no inverted normals from the mirror', done && done.format === '3mf' && done.after.NakedEdges === 0 && done.after.InvertedNormals === 0 && done.after.NonManifoldEdges === 0 && done.after.OrientationConflicts === 0);
  check('mirror: volume 2 after (two unit cubes)', done && Math.abs(done.volumeAfter - 2) < 1e-6);
  const out = unzipSync(new Uint8Array(done.stl));
  const xml = strFromU8(out['3D/3dmodel.model']);
  check('mirror: written model keeps the mirror transform and fills the hole', xml.includes(mirror) && triTags(objectInner(xml, 2)).length > 10 && triTags(objectInner(xml, 1)).length === 12);
  // Choosing nothing repairs nothing: the file comes back with the same triangles.
  const none = (await runWorker(buf, 'two.3mf', () => [])).find((m) => m.type === 'done');
  check('mirror: choosing no objects leaves the mesh untouched', none && triTags(objectInner(strFromU8(unzipSync(new Uint8Array(none.stl))['3D/3dmodel.model']), 2)).length === 10);
}

// 7. A negative part is never repaired and its mesh XML is copied byte for byte.
{
  const src = bambuFile({ normalTris: CUBE_TRIS(CUBE_HOLE), negTris: CUBE_TRIS(CUBE_HOLE) });
  const buf = zip3mf(src);
  const p = parse3mf(buf);
  const normal = p.objects.find((o) => o.kind === 'normal');
  const results = new Map([[normal.key, repair(meshOfObject(normal))]]);
  const { bytes } = write3mf(p, results);
  const outXml = strFromU8(unzipSync(bytes)['3D/Objects/object_1.model']);
  check('negative part: mesh XML unchanged by write3mf', objectInner(outXml, 2) === objectInner(src['3D/Objects/object_1.model'], 2));
  check('negative part: the normal part did change', objectInner(outXml, 1) !== objectInner(src['3D/Objects/object_1.model'], 1) && triTags(objectInner(outXml, 1)).length > 10);
  const msgs = await runWorker(buf, 'bambu.3mf');
  const done = msgs.find((m) => m.type === 'done');
  check('negative part: worker repairs only the normal part, no choice asked', done && !msgs.some((m) => m.type === 'objects') && clean(done.after) && done.after.NakedEdges === 0);
  const wx = strFromU8(unzipSync(new Uint8Array(done.stl))['3D/Objects/object_1.model']);
  check('negative part: worker output keeps the negative mesh as it was', objectInner(wx, 2) === objectInner(src['3D/Objects/object_1.model'], 2));
}

// 8. Painted part: paint survives on triangles that keep winding, is dropped (p2/p3 swapped) on reversed ones.
{
  const FLIP = [0, 3, 7];  // flipped in the input; repair reverses them
  const UNPAINTED = 3;
  const tris = CUBE.map((t, i) => {
    const [a, b, c] = FLIP.includes(i) ? [t[0], t[2], t[1]] : t;
    return [a, b, c, `${i === UNPAINTED ? '' : ` paint_color="${i + 4}"`} p1="${i * 3}" p2="${i * 3 + 1}" p3="${i * 3 + 2}"`];
  });
  const buf = zip3mf({ '[Content_Types].xml': CT, '_rels/.rels': RELS, '3D/3dmodel.model': modelXml({ objects: objectXml(1, meshXml(UNIT_CUBE, tris)), items: itemXml(1) }) });
  const p = parse3mf(buf);
  const o = p.objects[0];
  const res = repair(meshOfObject(o));
  const { bytes, paintLost } = write3mf(p, new Map([[o.key, res]]));
  const out = triTags(strFromU8(unzipSync(bytes)['3D/3dmodel.model']));
  const inTags = triTags(strFromU8(unzipSync(buf)['3D/3dmodel.model']));
  let bad = 0, revCount = 0, paintedRev = 0, unchangedKept = 0, unchanged = 0;
  for (let f = 0; f < res.origin.length; f++) {
    const org = res.origin[f], t = out[f], ot = inTags[org];
    if (org < 0) { bad++; continue; }
    const oP = [1, 2, 3].map((k) => attr(ot, 'p' + k)), nP = [1, 2, 3].map((k) => attr(t, 'p' + k));
    if (res.reversed[f]) {
      revCount++;
      if (attr(ot, 'paint_color') !== null) paintedRev++;
      if (attr(t, 'paint_color') !== null || nP.join() !== [oP[0], oP[2], oP[1]].join()) bad++;
    } else {
      unchanged++;
      if (attr(t, 'paint_color') === attr(ot, 'paint_color') && nP.join() === oP.join()) unchangedKept++;
    }
  }
  check('paint: all faces carried over, reversed ones lose paint with p2/p3 swapped', bad === 0 && res.origin.length === 12 && revCount === 3);
  check('paint: unchanged triangles keep paint_color and p1..p3', unchanged === 9 && unchangedKept === 9 && attr(out[1], 'paint_color') === '5');
  check('paint: paintLost counts only painted reversed triangles', paintLost === paintedRev && paintLost === 2);
}

// 9. Safety limit: a zip that expands past maxUncompressed is refused before inflating.
{
  const buf = zip3mf({ ...bambuFile(), 'Metadata/filler.txt': 'x'.repeat(5000) });
  let err = null;
  try { parse3mf(buf, { maxUncompressed: 1000 }); } catch (e) { err = e; }
  check('3mf limit: over-sized archive throws ThreeMfError', err instanceof ThreeMfError && /expands/.test(err.message));
  check('3mf limit: same file parses under a larger limit', parse3mf(buf, { maxUncompressed: 1 << 20 }).objects.length === 2);
  let bad = null;
  try { parse3mf(new Uint8Array([1, 2, 3, 4, 5])); } catch (e) { bad = e; }
  check('3mf: garbage input throws ThreeMfError', bad instanceof ThreeMfError);
}

// 10. Round trip: everything but the repaired mesh is byte-identical, and the output is clean.
{
  const png = new Uint8Array(300).map((_, i) => (i * 37 + 11) & 255);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const src = zip3mf({
    '[Content_Types].xml': CT, '_rels/.rels': RELS,
    '3D/3dmodel.model': modelXml({ objects: objectXml(1, meshXml(UNIT_CUBE, [...CUBE_TRIS(CUBE_HOLE), [0, 1, 2]].map((t, i) => (i === 3 ? [t[0], t[2], t[1]] : t)))), items: itemXml(1, '1 0 0 0 1 0 0 0 1 5 5 5') }),
    'Metadata/model_settings.config': '<config><object id="1"><metadata key="name" value="x"/></object></config>\n',
    'Metadata/plate_1.png': png,
    'Metadata/thumbnail.png': png.slice().reverse(),
  });
  const p = parse3mf(src);
  const o = p.objects[0];
  const mesh = meshOfObject(o);
  check('round trip: input is broken', !clean(analyze(mesh)));
  const { bytes } = write3mf(p, new Map([[o.key, repair(mesh)]]));
  const before = unzipSync(src), after = unzipSync(bytes);
  const same = Object.keys(before).filter((k) => k !== '3D/3dmodel.model').every((k) => after[k] && Buffer.compare(Buffer.from(before[k]), Buffer.from(after[k])) === 0);
  check('round trip: every non-mesh entry byte-identical, same entry list', same && Object.keys(after).sort().join() === Object.keys(before).sort().join());
  const again = parse3mf(bytes);
  const a = analyze(meshOfObject(again.objects[0]));
  check('round trip: re-parsed output has no naked/non-manifold/inverted/conflicting edges', clean(a) && a.DuplicateFaces === 0 && a.DegenerateFaces === 0);
  check('round trip: placement kept, volume 1', [...again.objects[0].placements[0].slice(9)].join() === '5,5,5' && Math.abs(meshVolume(meshOfObject(again.objects[0])) - 1) < 1e-6);
}

// 11. Regression: a welded mesh where no single winding works (the Millennium Falcon bug).
//     A pentagonal prism with a cross-cap (5-vertex Moebius band) in place of its top: every edge has
//     two faces, but the surface is non-orientable, so the winding conflicts cannot be flipped away.
//     (Splitting a closed box into regions and reversing one cannot do it: any reversed region is
//     fixed by flipping it, so that design never reports a conflict.)
{
  const N = 5, ROWS = 4, H = 1;
  const rim = [...Array(N).keys()].map((j) => [Math.cos(2 * Math.PI * j / N), Math.sin(2 * Math.PI * j / N)]);
  const at = (j, r) => [...rim[j], H * r / ROWS];
  const tris = [];
  for (let j = 1; j < N - 1; j++) tris.push([at(0, 0), at(j + 1, 0), at(j, 0)]); // bottom, facing down
  for (let j = 0; j < N; j++) {
    const k = (j + 1) % N;
    for (let r = 0; r < ROWS; r++) tris.push([at(j, r), at(k, r), at(k, r + 1)], [at(j, r), at(k, r + 1), at(j, r + 1)]);
  }
  const closed = tris.slice();
  const place = [0, 3, 1, 4, 2]; // band vertex v sits on rim position place[v]; its boundary runs 0,2,4,1,3
  for (let i = 0; i < N; i++) tris.push([i, (i + 1) % N, (i + 2) % N].map((v) => at(place[v], ROWS)));
  const soup = (ts) => { const a = new Float64Array(ts.length * 9); ts.forEach((t, i) => t.forEach((q, k) => a.set(q, i * 9 + k * 3))); return a; };
  const area = 2.5 * Math.sin(2 * Math.PI / N), trueVolume = area * H;
  const mesh = weld(soup(tris));
  const a0 = analyze(mesh);
  check('non-orientable: fixture closed (every edge in two faces) yet has winding conflicts', a0.NakedEdges === 0 && a0.NonManifoldEdges === 0 && a0.OrientationConflicts > 0);
  check('non-orientable: without the cross-cap the prism has only the open top', analyze(weld(soup(closed))).OrientationConflicts === 0);
  const fixed = repair(mesh);
  const a1 = analyze(fixed);
  const vol = meshVolume(fixed);
  check('non-orientable: repair gives a closed, consistently wound solid', clean(a1) && a1.DuplicateFaces === 0 && a1.DegenerateFaces === 0 && a1.FaceCount > 0);
  check('non-orientable: volume positive and the shape not wrecked', vol > 0 && vol <= trueVolume * 1.001 && vol >= trueVolume * (1 - 1 / ROWS) - 1e-9);
  const again = repair(fixed);
  const a2 = analyze(again);
  check('non-orientable: repairing the output again is stable', clean(a2) && a2.FaceCount === a1.FaceCount && Math.abs(meshVolume(again) - vol) < 1e-9);

  // With one row of walls every vertex touches a conflict: cutting would remove the whole
  // model, so repair keeps it and still reports the conflicts.
  const tiny = [];
  const at1 = (j, r) => [...rim[j], H * r];
  for (let j = 1; j < N - 1; j++) tiny.push([at1(0, 0), at1(j + 1, 0), at1(j, 0)]);
  for (let j = 0; j < N; j++) { const k = (j + 1) % N; tiny.push([at1(j, 0), at1(k, 0), at1(k, 1)], [at1(j, 0), at1(k, 1), at1(j, 1)]); }
  for (let i = 0; i < N; i++) tiny.push([i, (i + 1) % N, (i + 2) % N].map((v) => at1(place[v], 1)));
  const a3 = analyze(repair(weld(soup(tiny))));
  check('non-orientable: a cut that would remove most of the model is skipped and reported', a3.FaceCount === tiny.length && a3.OrientationConflicts > 0);
}

// 12. Repair provenance on the broken cube: origin / corner / reversed describe each output face.
{
  const P = corners(0, 0, 0, 1);
  const t = CUBE.slice();
  t.splice(10, 2); t[0] = [0, 1, 2]; t.push([4, 5, 6]); t.push([4, 4, 6]);
  const mesh = weld(parseStl(toStl(t.map((tri) => tri.map((i) => P[i])))));
  const r = repair(mesh);
  const n = r.faces.length / 3;
  let cornersOk = true, orientOk = true, made = 0, madeOnHole = true;
  const nrm = (v, f, i) => { const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
    const u = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]], w = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
    return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; };
  for (let f = 0; f < n; f++) {
    const o = r.origin[f];
    if (o < 0) {
      made++;
      for (let k = 0; k < 3; k++) if (Math.abs(r.verts[r.faces[f * 3 + k] * 3]) > 1e-9) madeOnHole = false; // the hole is the x = 0 side
      continue;
    }
    for (let k = 0; k < 3; k++) if (r.faces[f * 3 + k] !== mesh.faces[o * 3 + r.corner[f * 3 + k]]) cornersOk = false;
    const a = nrm(r.verts, r.faces, f), b = nrm(mesh.verts, mesh.faces, o);
    if ((a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0) !== !!r.reversed[f]) orientOk = false;
  }
  check('provenance: array lengths match the output faces', r.origin.length === n && r.reversed.length === n && r.corner.length === n * 3);
  check('provenance: every originated face has its corners mapped by corner', cornersOk);
  check('provenance: reversed matches the actual flip, and the flipped face is reported', orientOk && r.reversed.some((x) => x === 1));
  check('provenance: origin -1 faces exist only where the hole was filled', made > 0 && madeOnHole);
  // Input faces: 0-9 the cube minus its -x side, 10 the duplicate of face 2, 11 the degenerate one.
  const used = r.origin.filter((x) => x >= 0);
  check('provenance: each input face is used once; the degenerate one and a duplicate are dropped', new Set(used).size === used.length && !used.includes(11) && !(used.includes(2) && used.includes(10)));
}

console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
