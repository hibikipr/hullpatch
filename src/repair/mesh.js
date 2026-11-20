// In-browser STL analysis and repair.
// Pure functions (no DOM) so they run in a Web Worker and in Node tests.

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export class StlError extends Error {}

/** Parse a binary or ASCII STL into a flat Float32Array of triangle corners (9 floats per triangle). */
export function parseStl(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 15) throw new StlError('the file is empty or too small to be an stl file');
  const view = new DataView(buffer);

  if (bytes.length >= 84) {
    const n = view.getUint32(80, true);
    if (84 + n * 50 === bytes.length && n > 0) return readBinary(view, n);
  }
  const start = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))).trimStart().toLowerCase();
  if (start.startsWith('solid') && /facet|endsolid/.test(start)) {
    return readAscii(new TextDecoder().decode(bytes));
  }
  if (bytes.length >= 84) {
    // Binary with a wrong count in the header: read as many whole triangles as fit.
    const n = Math.floor((bytes.length - 84) / 50);
    if (n > 0) return readBinary(view, n);
  }
  throw new StlError('the file is not a valid binary or ascii stl file');
}

function readBinary(view, n) {
  const pos = new Float32Array(n * 9);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12; // stored normal (recomputed on output)
    for (let k = 0; k < 9; k++) {
      pos[t * 9 + k] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2;
  }
  return pos;
}

function readAscii(text) {
  const out = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let m;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  const tris = Math.floor(out.length / 9);
  if (tris === 0) throw new StlError('no triangles were found in the ascii stl file');
  return Float32Array.from(out.slice(0, tris * 9));
}

/* ------------------------------------------------------------------ */
/* Indexed mesh                                                        */
/* ------------------------------------------------------------------ */

/** Merge corners that sit at the same place into shared vertices. */
export function weld(pos) {
  const triCount = pos.length / 9;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new StlError('the file contains invalid coordinates');
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const inv = 1 / (diag * 1e-7); // welding tolerance

  const cornerCount = triCount * 3;
  let size = 1;
  while (size < cornerCount * 2) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const qx = new Int32Array(cornerCount), qy = new Int32Array(cornerCount), qz = new Int32Array(cornerCount);
  const verts = new Float64Array(cornerCount * 3);
  const faces = new Uint32Array(cornerCount);
  let vCount = 0;

  for (let c = 0; c < cornerCount; c++) {
    const x = pos[c * 3], y = pos[c * 3 + 1], z = pos[c * 3 + 2];
    const ix = Math.round((x - minX) * inv), iy = Math.round((y - minY) * inv), iz = Math.round((z - minZ) * inv);
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
    let found = -1;
    for (;;) {
      const v = table[h];
      if (v === -1) break;
      if (qx[v] === ix && qy[v] === iy && qz[v] === iz) { found = v; break; }
      h = (h + 1) & mask;
    }
    if (found === -1) {
      found = vCount++;
      table[h] = found;
      qx[found] = ix; qy[found] = iy; qz[found] = iz;
      verts[found * 3] = x; verts[found * 3 + 1] = y; verts[found * 3 + 2] = z;
    }
    faces[c] = found;
  }
  return { verts: verts.slice(0, vCount * 3), faces, vCount, diag };
}

function edgeKey(a, b, V) {
  return a < b ? a * V + b : b * V + a;
}

/** Undirected edge table: key -> chain of half-edges (face*3 + corner). */
function buildEdges(faces, V) {
  const F = faces.length / 3;
  const head = new Map();
  const next = new Int32Array(F * 3).fill(-1);
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f * 3 + k], b = faces[f * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const key = edgeKey(a, b, V);
      const he = f * 3 + k;
      const h = head.get(key);
      if (h !== undefined) next[he] = h;
      head.set(key, he);
    }
  }
  return { head, next };
}

function triArea2(verts, a, b, c) {
  const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
  const ux = verts[b * 3] - ax, uy = verts[b * 3 + 1] - ay, uz = verts[b * 3 + 2] - az;
  const vx = verts[c * 3] - ax, vy = verts[c * 3 + 1] - ay, vz = verts[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz);
}

function isDegenerate(verts, faces, f, areaEps) {
  const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
  if (a === b || b === c || a === c) return true;
  return triArea2(verts, a, b, c) <= areaEps;
}

function sortedTriKey(a, b, c) {
  let t;
  if (a > b) { t = a; a = b; b = t; }
  if (b > c) { t = b; b = c; c = t; }
  if (a > b) { t = a; a = b; b = t; }
  return a + ',' + b + ',' + c;
}

/**
 * Drop degenerate faces and resolve faces that share the same three vertices.
 * Copies wound the same way are one face stored twice: keep one. A pair wound
 * opposite ways is a zero-thickness internal wall (left behind where two shells
 * were joined): drop both, otherwise the survivor dangles inside the solid and
 * leaves non-manifold and open edges. In general the net winding decides.
 */
function dedupe(verts, src, areaEps) {
  const F = src.length / 3;
  const groups = new Map(); // sorted key -> net winding count, first face
  const order = [];
  for (let f = 0; f < F; f++) {
    if (isDegenerate(verts, src, f, areaEps)) continue;
    const a = src[f * 3], b = src[f * 3 + 1], c = src[f * 3 + 2];
    const k = sortedTriKey(a, b, c);
    let g = groups.get(k);
    if (!g) {
      groups.set(k, (g = { first: f, net: 0 }));
      order.push(g);
    }
    const r = src[g.first * 3], s = src[g.first * 3 + 1];
    const i = a === r ? 0 : b === r ? 1 : 2;
    const same = [a, b, c][(i + 1) % 3] === s;
    g.net += same ? 1 : -1;
  }
  // Also say which input face each output face is and whether it was turned over.
  const out = [], from = [], rev = [];
  for (const g of order) {
    if (g.net === 0) continue;
    const f = g.first;
    if (g.net > 0) out.push(src[f * 3], src[f * 3 + 1], src[f * 3 + 2]);
    else out.push(src[f * 3], src[f * 3 + 2], src[f * 3 + 1]);
    from.push(f); rev.push(g.net < 0 ? 1 : 0);
  }
  return { faces: Uint32Array.from(out), from: Int32Array.from(from), rev: Uint8Array.from(rev) };
}

/* ------------------------------------------------------------------ */
/* Shells                                                              */
/* ------------------------------------------------------------------ */

function shellCount(faces, V) {
  const F = faces.length / 3;
  const p = new Int32Array(V);
  for (let i = 0; i < V; i++) p[i] = i;
  const find = (x) => {
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) p[a] = b; };
  for (let f = 0; f < F; f++) {
    union(faces[f * 3], faces[f * 3 + 1]);
    union(faces[f * 3], faces[f * 3 + 2]);
  }
  const roots = new Set();
  for (let f = 0; f < F; f++) roots.add(find(faces[f * 3]));
  return roots.size;
}

/**
 * Remove specks: shells far too small to print (under 1/1000 of the model's size)
 * or with no volume. Slicers count each one as a separate part, and a flat speck
 * has no inside, so it often reads as reversed. The largest shell is always kept.
 * Returns the indices of the faces to keep, or null when nothing is dropped.
 */
function dropDebrisShells(verts, faces, V, diag) {
  const F = faces.length / 3;
  const p = new Int32Array(V);
  for (let i = 0; i < V; i++) p[i] = i;
  const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  for (let f = 0; f < F; f++) {
    const a = find(faces[f * 3]);
    p[a] = find(faces[f * 3 + 1]);
    p[find(faces[f * 3 + 1])] = find(faces[f * 3 + 2]);
  }
  const shells = new Map(); // root -> {vol, box}
  for (let f = 0; f < F; f++) {
    const r = find(faces[f * 3]);
    let s = shells.get(r);
    if (!s) shells.set(r, (s = { vol: 0, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] }));
    s.vol += signedVolume(verts, faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k] * 3;
      for (let d = 0; d < 3; d++) {
        if (verts[v + d] < s.box[d]) s.box[d] = verts[v + d];
        if (verts[v + d] > s.box[d + 3]) s.box[d + 3] = verts[v + d];
      }
    }
  }
  if (shells.size < 2) return null;
  let largest = null;
  for (const [r, s] of shells) if (!largest || Math.abs(s.vol) > Math.abs(shells.get(largest).vol)) largest = r;
  const drop = new Set();
  for (const [r, s] of shells) {
    if (r === largest) continue;
    const size = Math.hypot(s.box[3] - s.box[0], s.box[4] - s.box[1], s.box[5] - s.box[2]);
    if (size < diag * 1e-3 || Math.abs(s.vol) < diag * diag * diag * 1e-12) drop.add(r);
  }
  if (!drop.size) return null;
  const keep = [];
  for (let f = 0; f < F; f++) if (!drop.has(find(faces[f * 3]))) keep.push(f);
  return keep;
}

/* ------------------------------------------------------------------ */
/* Orientation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Make neighbouring faces agree on their winding (across edges shared by exactly
 * two faces), then turn each closed patch outward (cavities inward).
 * Welding can glue patches into a surface with no consistent winding at all (an
 * inside-out patch stitched to the rest along one seam but joined the right way
 * somewhere else). Then some edges must stay in conflict: they are returned as
 * vertex pairs so repair() can cut them out, and are chosen where the faces' own
 * inside/outside (ray parity) says the joint is wrong, not wherever a walk ends.
 * Returns the new faces, how many faces ended up flipped, the per-face flips and
 * the conflict edges.
 */
function orient(verts, faces, V) {
  const F = faces.length / 3;
  const out = faces.slice();
  const { head, next } = buildEdges(out, V);
  // Each two-face edge ties its faces: need 1 when both run it the same way (one must flip).
  const ef = [], eg = [], en = [], eh = [];
  const openFace = new Uint8Array(F); // touches an edge not shared by exactly two faces
  for (const he0 of head.values()) {
    const he1 = next[he0];
    const f = (he0 / 3) | 0, g = he1 === -1 ? -1 : (he1 / 3) | 0;
    if (he1 === -1 || next[he1] !== -1 || f === g) {
      for (let he = he0; he !== -1; he = next[he]) openFace[(he / 3) | 0] = 1;
      continue;
    }
    ef.push(f); eg.push(g); en.push(out[he0] === out[he1] ? 1 : 0); eh.push(he0);
  }
  const E = ef.length;

  // Union-find that also keeps each face's flip relative to its root.
  const solve = (order) => {
    const par = new Int32Array(F), rel = new Uint8Array(F);
    for (let f = 0; f < F; f++) par[f] = f;
    let pp = 0;
    const find = (x) => {
      let r = x, p = 0;
      while (par[r] !== r) { p ^= rel[r]; r = par[r]; }
      pp = p;
      while (par[x] !== r) { const n = par[x], q = rel[x]; par[x] = r; rel[x] = p; p ^= q; x = n; }
      return r;
    };
    const bad = [];
    for (const e of order) {
      const ra = find(ef[e]), pa = pp, rb = find(eg[e]), pb = pp;
      if (ra !== rb) { par[ra] = rb; rel[ra] = pa ^ pb ^ en[e]; }
      else if ((pa ^ pb) !== en[e]) bad.push(e);
    }
    const flip = new Uint8Array(F), root = new Int32Array(F);
    for (let f = 0; f < F; f++) { root[f] = find(f); flip[f] = pp; }
    return { flip, root, bad };
  };
  let sol = solve(Array.from({ length: E }, (_, e) => e));
  if (sol.bad.length) {
    // No consistent winding: join first the edges where both faces' own inside/outside
    // agree, so the leftover conflicts sit where the geometry says the joint is wrong.
    const inward = facesPointingIn(verts, out);
    const order = [];
    for (let e = 0; e < E; e++) if ((inward[ef[e]] ^ inward[eg[e]]) === en[e]) order.push(e);
    for (let e = 0; e < E; e++) if ((inward[ef[e]] ^ inward[eg[e]]) !== en[e]) order.push(e);
    const alt = solve(order);
    if (alt.bad.length < sol.bad.length) sol = alt;
  }
  const { flip } = sol;
  const comp = new Int32Array(F).fill(-1), ids = new Int32Array(F).fill(-1);
  let comps = 0;
  for (let f = 0; f < F; f++) {
    const r = sol.root[f];
    if (ids[r] === -1) ids[r] = comps++;
    comp[f] = ids[r];
  }
  const open = new Uint8Array(comps);
  for (let f = 0; f < F; f++) if (openFace[f]) open[comp[f]] = 1;

  for (let f = 0; f < F; f++) {
    if (flip[f]) { const t = out[f * 3 + 1]; out[f * 3 + 1] = out[f * 3 + 2]; out[f * 3 + 2] = t; }
  }

  const vol = new Float64Array(comps);
  for (let f = 0; f < F; f++) vol[comp[f]] += signedVolume(verts, out[f * 3], out[f * 3 + 1], out[f * 3 + 2]);
  const inner = nestedPatches(verts, out, comp, comps, vol);

  // A closed patch faces outward (inward for a cavity). An open patch has no
  // inside, so its volume sign means nothing: keep the winding most of its faces had.
  const flippedIn = new Float64Array(comps), sizeOf = new Float64Array(comps);
  for (let f = 0; f < F; f++) { sizeOf[comp[f]]++; flippedIn[comp[f]] += flip[f]; }
  const reverse = new Uint8Array(comps);
  for (let c = 0; c < comps; c++) {
    if (open[c]) { reverse[c] = flippedIn[c] * 2 > sizeOf[c] ? 1 : 0; continue; }
    const wantPositive = !inner[c];
    if ((vol[c] < 0 && wantPositive) || (vol[c] > 0 && !wantPositive)) reverse[c] = 1;
  }
  let flipped = 0;
  for (let f = 0; f < F; f++) {
    if (reverse[comp[f]]) {
      const t = out[f * 3 + 1]; out[f * 3 + 1] = out[f * 3 + 2]; out[f * 3 + 2] = t;
      flip[f] ^= 1;
    }
    if (flip[f]) flipped++;
  }
  const conflicts = new Uint32Array(sol.bad.length * 2);
  sol.bad.forEach((e, i) => {
    const he = eh[e], f = (he / 3) | 0;
    conflicts[i * 2] = faces[he];
    conflicts[i * 2 + 1] = faces[f * 3 + ((he % 3) + 1) % 3];
  });
  return { faces: out, flipped, flip, conflicts };
}

/**
 * 1 for each face whose front points into the solid: a point just in front of it is
 * inside by ray parity (a +x ray, triangles binned on a y-z grid). Only a hint for
 * orient() on surfaces with no consistent winding, so one ray per face is enough.
 */
function facesPointingIn(verts, faces) {
  const F = faces.length / 3;
  let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < faces.length; i++) {
    const y = verts[faces[i] * 3 + 1], z = verts[faces[i] * 3 + 2];
    if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const G = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(F))));
  const sy = (y1 - y0) / G * 1.0001 || 1, sz = (z1 - z0) / G * 1.0001 || 1;
  const cell = (v, lo, s) => Math.min(G - 1, Math.max(0, Math.floor((v - lo) / s)));
  // Bins as one flat list: count per cell, then fill.
  const box = new Int32Array(F * 4), start = new Int32Array(G * G + 1);
  for (let f = 0; f < F; f++) {
    let ya = Infinity, yb = -Infinity, za = Infinity, zb = -Infinity;
    for (let k = 0; k < 3; k++) {
      const y = verts[faces[f * 3 + k] * 3 + 1], z = verts[faces[f * 3 + k] * 3 + 2];
      if (y < ya) ya = y; if (y > yb) yb = y; if (z < za) za = z; if (z > zb) zb = z;
    }
    box[f * 4] = cell(ya, y0, sy); box[f * 4 + 1] = cell(yb, y0, sy); box[f * 4 + 2] = cell(za, z0, sz); box[f * 4 + 3] = cell(zb, z0, sz);
    for (let i = box[f * 4]; i <= box[f * 4 + 1]; i++) for (let j = box[f * 4 + 2]; j <= box[f * 4 + 3]; j++) start[i * G + j + 1]++;
  }
  for (let c = 0; c < G * G; c++) start[c + 1] += start[c];
  const list = new Int32Array(start[G * G]), fill = start.slice(0, G * G);
  for (let f = 0; f < F; f++) {
    for (let i = box[f * 4]; i <= box[f * 4 + 1]; i++) for (let j = box[f * 4 + 2]; j <= box[f * 4 + 3]; j++) list[fill[i * G + j]++] = f;
  }
  const inward = new Uint8Array(F);
  for (let f = 0; f < F; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!l) continue;
    const step = Math.sqrt(l) * 0.02 / l; // a little in front, relative to the face's size
    const ox = verts[a] + 0.31 * ux + 0.33 * vx + nx * step;
    const oy = verts[a + 1] + 0.31 * uy + 0.33 * vy + ny * step;
    const oz = verts[a + 2] + 0.31 * uz + 0.33 * vz + nz * step;
    const ci = cell(oy, y0, sy) * G + cell(oz, z0, sz);
    let hits = 0;
    for (let t = start[ci]; t < start[ci + 1]; t++) {
      const g = list[t], A = faces[g * 3] * 3, B = faces[g * 3 + 1] * 3, C = faces[g * 3 + 2] * 3;
      const ay = verts[A + 1] - oy, az = verts[A + 2] - oz, by = verts[B + 1] - oy, bz = verts[B + 2] - oz;
      const cy = verts[C + 1] - oy, cz = verts[C + 2] - oz;
      const w0 = by * cz - bz * cy, w1 = cy * az - cz * ay, w2 = ay * bz - az * by;
      if (!((w0 > 0 && w1 > 0 && w2 > 0) || (w0 < 0 && w1 < 0 && w2 < 0))) continue;
      if ((w0 * verts[A] + w1 * verts[B] + w2 * verts[C]) / (w0 + w1 + w2) > ox) hits++;
    }
    inward[f] = hits & 1;
  }
  return inward;
}

function signedVolume(verts, a, b, c) {
  const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
  const bx = verts[b * 3], by = verts[b * 3 + 1], bz = verts[b * 3 + 2];
  const cx = verts[c * 3], cy = verts[c * 3 + 1], cz = verts[c * 3 + 2];
  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}

/** For the largest patches, test whether a point of each lies inside a bigger one (ray parity). */
function nestedPatches(verts, faces, comp, comps, vol) {
  const inner = new Uint8Array(comps);
  const F = faces.length / 3;
  if (comps < 2) return inner;
  // Each tested patch costs one ray against every face: cap the total work.
  const tests = Math.max(1, Math.min(64, Math.floor(6e7 / F)));
  const order = [...Array(comps).keys()].sort((a, b) => Math.abs(vol[b]) - Math.abs(vol[a])).slice(0, tests);
  const firstFace = new Int32Array(comps).fill(-1);
  for (let f = 0; f < F; f++) if (firstFace[comp[f]] === -1) firstFace[comp[f]] = f;
  const dir = [0.5773, 0.5774, 0.5775];
  for (const c of order) {
    if (vol[c] === 0) continue;
    const f0 = firstFace[c];
    // A point inside the face, off its centre and medians: a ray from the exact centre of
    // a face on a grid can run straight through another face's edge and count it twice.
    const p = [0, 0, 0], w = [0.36, 0.31, 0.33];
    for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) p[d] += verts[faces[f0 * 3 + k] * 3 + d] * w[k];
    let crossings = 0;
    for (let f = 0; f < F; f++) {
      const cf = comp[f];
      if (cf === c || Math.abs(vol[cf]) <= Math.abs(vol[c])) continue;
      if (rayHits(verts, faces, f, p, dir)) crossings++;
    }
    if (crossings % 2 === 1) inner[c] = 1;
  }
  return inner;
}

function rayHits(verts, faces, f, o, d) {
  const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
  const e1x = verts[b] - verts[a], e1y = verts[b + 1] - verts[a + 1], e1z = verts[b + 2] - verts[a + 2];
  const e2x = verts[c] - verts[a], e2y = verts[c + 1] - verts[a + 1], e2z = verts[c + 2] - verts[a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-20) return false;
  const inv = 1 / det;
  const tx = o[0] - verts[a], ty = o[1] - verts[a + 1], tz = o[2] - verts[a + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  return (e2x * qx + e2y * qy + e2z * qz) * inv > 0;
}

/* ------------------------------------------------------------------ */
/* Holes                                                               */
/* ------------------------------------------------------------------ */

/** Trace the loops of edges that belong to only one face. Each loop runs opposite to its faces. */
function boundaryLoops(faces, V) {
  const F = faces.length / 3;
  const { head, next } = buildEdges(faces, V);
  const out = new Map(); // start vertex -> end vertices of hole edges
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f * 3 + k], b = faces[f * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const he = head.get(edgeKey(a, b, V));
      if (next[he] === -1) {
        let list = out.get(b);
        if (!list) out.set(b, (list = []));
        list.push(a); // reversed: b -> a
      }
    }
  }
  const loops = [];
  for (const [start, list] of out) {
    while (list.length) {
      const loop = [start];
      let cur = list.pop();
      let guard = 0;
      while (cur !== start && guard++ < 10000000) {
        loop.push(cur);
        const l = out.get(cur);
        if (!l || !l.length) { loop.length = 0; break; } // open chain
        cur = l.pop();
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

function newellNormal(verts, loop) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
    nx += (verts[a + 1] - verts[b + 1]) * (verts[a + 2] + verts[b + 2]);
    ny += (verts[a + 2] - verts[b + 2]) * (verts[a] + verts[b]);
    nz += (verts[a] - verts[b]) * (verts[a + 1] + verts[b + 1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

function loopIsPlanar(verts, loop, diag) {
  const n = newellNormal(verts, loop);
  let cx = 0, cy = 0, cz = 0;
  for (const v of loop) { cx += verts[v * 3]; cy += verts[v * 3 + 1]; cz += verts[v * 3 + 2]; }
  cx /= loop.length; cy /= loop.length; cz /= loop.length;
  let size = 0, dev = 0;
  for (const v of loop) {
    const dx = verts[v * 3] - cx, dy = verts[v * 3 + 1] - cy, dz = verts[v * 3 + 2] - cz;
    size = Math.max(size, Math.hypot(dx, dy, dz));
    dev = Math.max(dev, Math.abs(dx * n[0] + dy * n[1] + dz * n[2]));
  }
  return dev <= Math.max(size * 1e-3, diag * 1e-6);
}

/** Index of the loop's longest edge (loop[i] -> loop[i+1]) and its length. */
function longestLoopEdge(verts, loop) {
  let best = -1, len = -1;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
    const l = Math.hypot(verts[a] - verts[b], verts[a + 1] - verts[b + 1], verts[a + 2] - verts[b + 2]);
    if (l > len) { len = l; best = i; }
  }
  return { i: best, len };
}

/** True when every loop vertex lies on the loop's longest edge (a zero-area sliver hole). */
function loopIsCollinear(verts, loop, diag) {
  const { i, len } = longestLoopEdge(verts, loop);
  if (len <= 0) return true;
  const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
  const dx = (verts[b] - verts[a]) / len, dy = (verts[b + 1] - verts[a + 1]) / len, dz = (verts[b + 2] - verts[a + 2]) / len;
  const eps = Math.max(len * 1e-4, diag * 1e-7);
  for (const v of loop) {
    const px = verts[v * 3] - verts[a], py = verts[v * 3 + 1] - verts[a + 1], pz = verts[v * 3 + 2] - verts[a + 2];
    const t = px * dx + py * dy + pz * dz;
    if (t < -eps || t > len + eps) return false;
    if (Math.hypot(px - t * dx, py - t * dy, pz - t * dz) > eps) return false;
  }
  return true;
}

/**
 * Close a collinear hole by splitting the one face on its long edge at the loop's
 * other vertices, so every edge ends up shared by exactly two faces.
 */
function splitTJunction(verts, faces, loop, edges, V, removed, added) {
  const m = loop.length;
  const { i } = longestLoopEdge(verts, loop);
  const u = loop[i], w = loop[(i + 1) % m];
  // The face beside the long edge runs it w -> u (loops run opposite to their faces).
  let face = -1, r = -1;
  for (let he = edges.head.get(edgeKey(u, w, V)); he !== undefined && he !== -1; he = edges.next[he]) {
    const f = (he / 3) | 0, k = he % 3;
    if (faces[f * 3 + k] === w && faces[f * 3 + ((k + 1) % 3)] === u) {
      if (face !== -1) return false; // ambiguous
      face = f;
      r = faces[f * 3 + ((k + 2) % 3)];
    }
  }
  if (face === -1 || removed[face]) return false;
  // Chain from w along the loop back to u: w, x1, ..., u.
  const chain = [];
  for (let s = 1; s <= m; s++) chain.push(loop[(i + s) % m]);
  if (chain.includes(r)) return false;
  removed[face] = 1;
  for (let s = 0; s + 1 < chain.length; s++) added.push(chain[s], chain[s + 1], r);
  return true;
}

/** Edges used by one face (naked) and by more than two (non-manifold). */
function edgeProblems(faces, V) {
  const { head, next } = buildEdges(faces, V);
  let naked = 0, nonManifold = 0;
  for (const he0 of head.values()) {
    let c = 0;
    for (let he = he0; he !== -1; he = next[he]) c++;
    if (c === 1) naked++;
    else if (c >= 3) nonManifold++;
  }
  return { naked, nonManifold };
}

/** Faces that touch an edge used by more than two faces. */
function nonManifoldFaces(faces, V) {
  const { head, next } = buildEdges(faces, V);
  const bad = new Set();
  for (const he0 of head.values()) {
    let c = 0;
    for (let he = he0; he !== -1; he = next[he]) c++;
    if (c < 3) continue;
    for (let he = he0; he !== -1; he = next[he]) bad.add((he / 3) | 0);
  }
  return bad;
}

/**
 * Split "pinched" edges: an edge shared by an even number of faces (4, 6...) where
 * two or more sheets merely touch, like two cubes sharing one edge. Around the edge,
 * each face's solid lies behind it, so a face pairs with its angular neighbour on
 * that side; when every face pairs up both ways and each pair runs the edge in
 * opposite directions, the pairs are separate manifold sheets. Then the faces around
 * each end vertex fall into fans (joined across two-face edges and across those
 * pairs), and every fan but the first gets its own copy of the vertex, at the same
 * position. Nothing moves and no face is removed, so the volume is unchanged.
 * geometricOnly: only pairings the geometry agrees with (no crossing slivers).
 * Rewrites faces in place; returns how many vertex copies were made.
 * (A file format that joins vertices by position, like STL, will glue them again.)
 */
function splitPinchedEdges(verts, faces, V, addVertex, geometricOnly = false) {
  const { head, next } = buildEdges(faces, V);
  const partner = new Map(); // half-edge -> the half-edge of the face it pairs with
  const ends = new Set(), pinched = [];
  const hes = [];
  for (const he0 of head.values()) {
    hes.length = 0;
    for (let he = he0; he !== -1; he = next[he]) hes.push(he);
    const n = hes.length;
    if (n < 4 || n % 2) continue;
    const f0 = (he0 / 3) | 0, k0 = he0 % 3;
    let x = faces[f0 * 3 + k0], y = faces[f0 * 3 + ((k0 + 1) % 3)];
    if (x > y) { const t = x; x = y; y = t; }
    const ox = verts[x * 3], oy = verts[x * 3 + 1], oz = verts[x * 3 + 2];
    let ux = verts[y * 3] - ox, uy = verts[y * 3 + 1] - oy, uz = verts[y * 3 + 2] - oz;
    const ul = Math.hypot(ux, uy, uz);
    if (!ul) continue;
    ux /= ul; uy /= ul; uz /= ul;
    let rx = 0, ry = 0, rz = 0, sx = 0, sy = 0, sz = 0;
    const items = [];
    let ok = true;
    for (const he of hes) {
      const f = (he / 3) | 0, k = he % 3;
      const a = faces[f * 3 + k], b = faces[f * 3 + ((k + 1) % 3)], c = faces[f * 3 + ((k + 2) % 3)];
      // The third corner, projected onto the plane across the edge.
      let wx = verts[c * 3] - ox, wy = verts[c * 3 + 1] - oy, wz = verts[c * 3 + 2] - oz;
      const d = wx * ux + wy * uy + wz * uz;
      wx -= d * ux; wy -= d * uy; wz -= d * uz;
      const wl = Math.hypot(wx, wy, wz);
      if (!wl) { ok = false; break; }
      wx /= wl; wy /= wl; wz /= wl;
      if (!items.length) {
        rx = wx; ry = wy; rz = wz;
        sx = uy * rz - uz * ry; sy = uz * rx - ux * rz; sz = ux * ry - uy * rx;
      }
      const angle = Math.atan2(wx * sx + wy * sy + wz * sz, wx * rx + wy * ry + wz * rz);
      // Face normal against the direction of increasing angle at the face: the solid
      // is behind the face, so on the side of decreasing angle when this is positive.
      const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
      const e1x = verts[b * 3] - ax, e1y = verts[b * 3 + 1] - ay, e1z = verts[b * 3 + 2] - az;
      const e2x = verts[c * 3] - ax, e2y = verts[c * 3 + 1] - ay, e2z = verts[c * 3 + 2] - az;
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const tx = uy * wz - uz * wy, ty = uz * wx - ux * wz, tz = ux * wy - uy * wx;
      const side = nx * tx + ny * ty + nz * tz;
      if (!side) { ok = false; break; }
      items.push({ he, angle, back: side > 0 ? -1 : 1, forward: a === x });
    }
    if (!ok) continue;
    const cands = pairPinchedFaces(items, n, geometricOnly);
    if (!cands.length) continue;
    pinched.push({ x, y, cands: cands.map((c) => c.map(([i, j]) => [items[i].he, items[j].he])), choice: 0 });
    ends.add(x); ends.add(y);
  }
  if (!ends.size) return 0;

  // Faces around each end vertex, grouped into fans.
  const around = new Map();
  for (const v of ends) around.set(v, []);
  for (let f = 0; f < faces.length / 3; f++) {
    for (let k = 0; k < 3; k++) { const l = around.get(faces[f * 3 + k]); if (l) l.push(f); }
  }
  const fansAt = (v) => {
    const list = around.get(v);
    const idx = new Map(list.map((f, i) => [f, i]));
    const par = list.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const join = (f, g) => { const a = find(idx.get(f)), b = find(idx.get(g)); if (a !== b) par[a] = b; };
    for (const f of list) {
      for (let k = 0; k < 3; k++) {
        const a = faces[f * 3 + k], b = faces[f * 3 + ((k + 1) % 3)];
        if ((a !== v && b !== v) || a === b) continue;
        const he = f * 3 + k, h0 = head.get(edgeKey(a, b, V));
        const p = partner.get(he);
        if (p !== undefined) { join(f, (p / 3) | 0); continue; }
        // Any other edge: its faces stay together (two-face edges, and edges this can't resolve).
        for (let h = h0; h !== -1; h = next[h]) if (idx.has((h / 3) | 0)) join(f, (h / 3) | 0);
      }
    }
    const fanOf = new Map();
    list.forEach((f, i) => fanOf.set(f, find(i)));
    return fanOf;
  };
  // An edge comes apart when no two of its pairs share a fan at both ends. Pairs that
  // look right at the edge can still join up around an end vertex (the sheets are one
  // surface there), and edges that share an end vertex decide each other's fans. So for
  // each group of such edges joined by end vertices, when the first choices leave one
  // whole, try every combination of their ways of pairing (a bounded number) and keep
  // the one that takes the most edges apart, earlier (better) choices first.
  const setPartners = (e) => { for (const [p, q] of e.cands[e.choice]) { partner.set(p, q); partner.set(q, p); } };
  const apartCount = (group, verts) => {
    const fanAt = new Map();
    for (const v of verts) fanAt.set(v, fansAt(v));
    let n = 0;
    for (const e of group) {
      const fx = fanAt.get(e.x), fy = fanAt.get(e.y), seen = new Set();
      let apart = true;
      for (const [p] of e.cands[e.choice]) {
        const key = fx.get((p / 3) | 0) + ',' + fy.get((p / 3) | 0);
        if (seen.has(key)) apart = false;
        seen.add(key);
      }
      if (apart) n++;
    }
    return n;
  };
  for (const e of pinched) setPartners(e);
  const groupOf = new Map();
  for (const e of pinched) {
    let g = groupOf.get(e.x) || groupOf.get(e.y);
    if (!g) g = { edges: [], verts: new Set() };
    const other = groupOf.get(e.x) && groupOf.get(e.y) && groupOf.get(e.x) !== groupOf.get(e.y) ? groupOf.get(e.y) : null;
    if (other) { // merge the second group into the first
      for (const o of other.edges) g.edges.push(o);
      for (const v of other.verts) { g.verts.add(v); groupOf.set(v, g); }
    }
    g.edges.push(e); g.verts.add(e.x); g.verts.add(e.y);
    groupOf.set(e.x, g); groupOf.set(e.y, g);
  }
  for (const g of new Set(groupOf.values())) {
    const { edges } = g;
    if (apartCount(edges, g.verts) === edges.length) continue;
    let combos = 1;
    for (const e of edges) combos *= e.cands.length;
    if (combos > 256) continue;
    let best = -1, bestChoice = null;
    for (let c = 0; c < combos; c++) {
      let r = c;
      for (const e of edges) { e.choice = r % e.cands.length; r = Math.floor(r / e.cands.length); }
      for (const e of edges) for (const [p, q] of e.cands[0].concat(...e.cands.slice(1))) { partner.delete(p); partner.delete(q); }
      for (const e of edges) setPartners(e);
      const n = apartCount(edges, g.verts);
      if (n > best) { best = n; bestChoice = edges.map((e) => e.choice); }
      if (n === edges.length) break;
    }
    edges.forEach((e, i) => { e.choice = bestChoice[i]; });
    for (const e of edges) for (const [p, q] of e.cands[0].concat(...e.cands.slice(1))) { partner.delete(p); partner.delete(q); }
    for (const e of edges) setPartners(e);
  }
  const fans = new Map();
  for (const v of ends) fans.set(v, fansAt(v));
  const changes = [];
  for (const [v, fanOf] of fans) {
    const groups = new Map();
    for (const [f, r] of fanOf) { if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); }
    let firstFan = true;
    for (const fan of groups.values()) {
      if (firstFan) { firstFan = false; continue; }
      changes.push(v, fan);
    }
  }
  for (let i = 0; i < changes.length; i += 2) {
    const v = changes[i];
    const copy = addVertex(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2], v);
    for (const f of changes[i + 1]) for (let k = 0; k < 3; k++) if (faces[f * 3 + k] === v) faces[f * 3 + k] = copy;
  }
  return changes.length / 2;
}

/**
 * Pair up the faces around a pinched edge (items: {angle, back, forward}), as a list
 * of index pairs, or null. First by the geometry: each face pairs with its angular
 * neighbour on its solid side. Faces in one plane (a sheet folded flat onto itself)
 * tie on angle, so every order of the tied faces is tried. When no order works,
 * the faces cross each other at the edge (slivers far smaller than the print can
 * show): then pair angular neighbours that run the edge opposite ways, as a slicer
 * does when it matches edges by direction, taking the split that agrees best with
 * the geometry. Every pair runs the edge in opposite directions.
 */
function pairPinchedFaces(items, n, geometricOnly = false) {
  let fwd = 0;
  for (const it of items) {
    let a = it.angle < 0 ? it.angle + 2 * Math.PI : it.angle;
    if (a >= 2 * Math.PI - 1e-9) a = 0;
    it.angle = a;
    if (it.forward) fwd++;
  }
  if (fwd * 2 !== n) return [];
  items.sort((p, q) => p.angle - q.angle);
  // Groups of tied angles (the last group can wrap around to angle 0).
  const groups = [];
  for (let i = 0; i < n; i++) {
    if (i && items[i].angle - items[i - 1].angle <= 1e-9) groups[groups.length - 1].push(i);
    else groups.push([i]);
  }
  const consistent = (order) => {
    const pairs = [];
    for (let p = 0; p < n; p++) {
      const q = (p + items[order[p]].back + n) % n;
      if ((q + items[order[q]].back + n) % n !== p || items[order[p]].forward === items[order[q]].forward) return null;
      if (p < q) pairs.push([order[p], order[q]]);
    }
    return pairs;
  };
  // Every order of the tied faces, capped; each distinct pairing found is a candidate.
  const order = [], out = [], seen = new Set();
  let tries = 0;
  const permute = (g) => {
    if (tries > 720) return;
    if (g === groups.length) {
      tries++;
      const pairs = consistent(order);
      if (pairs) {
        const key = pairs.map(([i, j]) => Math.min(i, j) + '-' + Math.max(i, j)).sort().join(' ');
        if (!seen.has(key)) { seen.add(key); out.push(pairs); }
      }
      return;
    }
    const go = (left) => {
      if (!left.length) { permute(g + 1); return; }
      for (let i = 0; i < left.length; i++) {
        order.push(left[i]);
        go(left.slice(0, i).concat(left.slice(i + 1)));
        order.pop();
      }
    };
    go(groups[g]);
  };
  permute(0);
  // Last resort, after the pairings above: on a four-face edge, the other way of pairing
  // the two faces that run it one way with the two that run it the other way.
  const add = (list) => {
    const keys = new Set(list.map((pairs) => pairs.map(([i, j]) => Math.min(i, j) + '-' + Math.max(i, j)).sort().join(' ')));
    if (n !== 4) return list;
    const f = [0, 1, 2, 3].filter((i) => items[i].forward), b = [0, 1, 2, 3].filter((i) => !items[i].forward);
    for (const pairs of [[[f[0], b[0]], [f[1], b[1]]], [[f[0], b[1]], [f[1], b[0]]]]) {
      const key = pairs.map(([i, j]) => Math.min(i, j) + '-' + Math.max(i, j)).sort().join(' ');
      if (!keys.has(key)) { keys.add(key); list.push(pairs); }
    }
    return list;
  };
  if (geometricOnly) return out;
  if (out.length) return add(out);
  // Crossing slivers: the ways to pair neighbours in angle order whose pairs all run
  // opposite ways, the one more faces' solid side agrees with first.
  const fallback = [];
  for (let shift = 0; shift < 2; shift++) {
    const pairs = [];
    let score = 0;
    for (let p = shift; p < n + shift; p += 2) {
      const i = p % n, j = (p + 1) % n;
      if (items[i].forward === items[j].forward) { score = -1; break; }
      if (items[i].back === 1) score++;
      if (items[j].back === -1) score++;
      pairs.push([i, j]);
    }
    if (score >= 0) fallback.push({ pairs, score });
  }
  return add(fallback.sort((p, q) => q.score - p.score).map((c) => c.pairs));
}

/** Ear-clip a loop projected onto its own plane; falls back to a fan around a new centre point. */
function triangulateLoop(verts, loop, addVertex) {
  const m = loop.length;
  if (m === 3) return [[loop[0], loop[1], loop[2]]];
  const n = newellNormal(verts, loop);
  const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = n[1] * ax[2] - n[2] * ax[1], uy = n[2] * ax[0] - n[0] * ax[2], uz = n[0] * ax[1] - n[1] * ax[0];
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
  const px = new Float64Array(m), py = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const o = loop[i] * 3;
    px[i] = verts[o] * ux + verts[o + 1] * uy + verts[o + 2] * uz;
    py[i] = verts[o] * vx + verts[o + 1] * vy + verts[o + 2] * vz;
  }

  if (m <= 3000) {
    const tris = [];
    const idx = [...Array(m).keys()];
    const cross = (i, j, k) => (px[j] - px[i]) * (py[k] - py[i]) - (py[j] - py[i]) * (px[k] - px[i]);
    const inside = (i, j, k, p) => cross(i, j, p) >= 0 && cross(j, k, p) >= 0 && cross(k, i, p) >= 0;
    while (idx.length > 3) {
      let clipped = false;
      for (let t = 0; t < idx.length; t++) {
        const i = idx[(t + idx.length - 1) % idx.length], j = idx[t], k = idx[(t + 1) % idx.length];
        if (cross(i, j, k) <= 0) continue;
        let ok = true;
        for (const p of idx) {
          if (p === i || p === j || p === k) continue;
          if (px[p] === px[j] && py[p] === py[j]) continue;
          if (inside(i, j, k, p)) { ok = false; break; }
        }
        if (!ok) continue;
        tris.push([loop[i], loop[j], loop[k]]);
        idx.splice(t, 1);
        clipped = true;
        break;
      }
      if (!clipped) break;
    }
    if (idx.length === 3) {
      tris.push([loop[idx[0]], loop[idx[1]], loop[idx[2]]]);
      return tris;
    }
  }
  let cx = 0, cy = 0, cz = 0;
  for (const v of loop) { cx += verts[v * 3]; cy += verts[v * 3 + 1]; cz += verts[v * 3 + 2]; }
  const c = addVertex(cx / m, cy / m, cz / m);
  const fan = [];
  for (let i = 0; i < m; i++) fan.push([loop[i], loop[(i + 1) % m], c]);
  return fan;
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

export function analyze(mesh) {
  const { verts, faces, vCount, diag } = mesh;
  const F = faces.length / 3;
  const areaEps = diag * diag * 1e-14;

  let degenerate = 0, duplicate = 0;
  const keys = new Set();
  for (let f = 0; f < F; f++) {
    if (isDegenerate(verts, faces, f, areaEps)) { degenerate++; continue; }
    const k = sortedTriKey(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
    if (keys.has(k)) duplicate++; else keys.add(k);
  }

  const { head, next } = buildEdges(faces, vCount);
  let nakedEdges = 0, nonManifold = 0;
  for (const he0 of head.values()) {
    let c = 0;
    for (let he = he0; he !== -1; he = next[he]) c++;
    if (c === 1) nakedEdges++;
    else if (c >= 3) nonManifold++;
  }

  let planar = 0, nonPlanar = 0;
  for (const loop of boundaryLoops(faces, vCount)) (loopIsPlanar(verts, loop, diag) ? planar++ : nonPlanar++);

  const { flipped, conflicts } = orient(verts, faces, vCount);
  const shells = shellCount(faces, vCount);

  return {
    NakedEdges: nakedEdges,
    PlanarHoles: planar,
    NonPlanarHoles: nonPlanar,
    NonManifoldEdges: nonManifold,
    InvertedNormals: flipped,
    OrientationConflicts: conflicts.length / 2, // edges no winding can make agree
    DuplicateFaces: duplicate,
    DegenerateFaces: degenerate,
    DisjointShells: shells > 1 ? shells : 0,
    VerticesCount: vCount,
    FaceCount: F,
  };
}

/* ------------------------------------------------------------------ */
/* Repair                                                              */
/* ------------------------------------------------------------------ */

/**
 * Repair a welded mesh: drop degenerate and duplicate faces, make windings agree and
 * face outward, cut out spots where no winding can agree, close holes, then orient
 * again with the new patches. onProgress(fraction 0..1) is called along the way.
 * Besides the mesh it returns, per output face, where it came from (for keeping
 * per-triangle data): origin (input face index, -1 for faces the repair made),
 * reversed (1 if wound opposite to that face) and corner (3 per face: which corner
 * of the origin face each corner is).
 */
export function repair(mesh, onProgress = () => {}) {
  const { diag } = mesh;
  const areaEps = diag * diag * 1e-14;
  const extra = [];
  let V = mesh.vCount;
  const allVerts = () => {
    const out = new Float64Array(V * 3);
    out.set(mesh.verts);
    out.set(extra, mesh.vCount * 3);
    return out;
  };
  const addVertex = (x, y, z) => { extra.push(x, y, z); return V++; };

  onProgress(0.05);
  const d = dedupe(mesh.verts, mesh.faces, areaEps);
  let faces = d.faces, org = d.from, cor = new Uint8Array(faces.length);
  for (let f = 0; f < org.length; f++) { cor[f * 3 + 1] = d.rev[f] ? 2 : 1; cor[f * 3 + 2] = d.rev[f] ? 1 : 2; }
  // Keep the listed faces (null: all) and append new ones, carrying the provenance along.
  const rebuild = (keep, added = []) => {
    const n = (keep ? keep.length : faces.length / 3), total = n + added.length / 3;
    const nf = new Uint32Array(total * 3), no = new Int32Array(total).fill(-1), nc = new Uint8Array(total * 3);
    if (keep) {
      for (let i = 0; i < n; i++) {
        const f = keep[i];
        for (let k = 0; k < 3; k++) { nf[i * 3 + k] = faces[f * 3 + k]; nc[i * 3 + k] = cor[f * 3 + k]; }
        no[i] = org[f];
      }
    } else { nf.set(faces); nc.set(cor); no.set(org); }
    nf.set(added, n * 3);
    for (let i = n; i < total; i++) { nc[i * 3 + 1] = 1; nc[i * 3 + 2] = 2; }
    faces = nf; org = no; cor = nc;
  };
  const keepWhere = (test) => {
    const keep = [];
    for (let f = 0; f < faces.length / 3; f++) if (test(f)) keep.push(f);
    rebuild(keep);
  };
  const reorient = (vs) => {
    const o = orient(vs, faces, V);
    faces = o.faces;
    for (let f = 0; f < o.flip.length; f++) {
      if (o.flip[f]) { const t = cor[f * 3 + 1]; cor[f * 3 + 1] = cor[f * 3 + 2]; cor[f * 3 + 2] = t; }
    }
    return o;
  };
  // A surface with no consistent winding (see orient) cannot be fixed by flipping:
  // remove every face touching a conflict edge. Each side's hole then runs one way
  // and is capped on its own, which leaves an orientable closed surface.
  // On a small model the conflicts can touch most of it; cutting would then leave little
  // or nothing, so keep the conflicts and let the result say "partly repaired".
  const cutConflicts = (conflicts) => {
    const mark = new Uint8Array(V);
    for (const v of conflicts) mark[v] = 1;
    const keep = (f) => !mark[faces[f * 3]] && !mark[faces[f * 3 + 1]] && !mark[faces[f * 3 + 2]];
    const F = faces.length / 3;
    let kept = 0;
    for (let f = 0; f < F; f++) if (keep(f)) kept++;
    if (kept * 2 < F) return false;
    keepWhere(keep);
    return true;
  };
  const closeHoles = (p0, p1) => {
    for (let pass = 0; pass < 3; pass++) {
      const loops = boundaryLoops(faces, V);
      if (!loops.length) break;
      const vNow = allVerts();
      const added = [];
      const removed = new Uint8Array(faces.length / 3);
      let edges = null;
      loops.forEach((loop, i) => {
        // A hole with no area is a T-junction: split the face across its long edge instead.
        if (loopIsCollinear(vNow, loop, diag)) {
          edges = edges || buildEdges(faces, V);
          if (splitTJunction(vNow, faces, loop, edges, V, removed, added)) return;
        }
        for (const t of triangulateLoop(vNow, loop, addVertex)) added.push(t[0], t[1], t[2]);
        if (i % 50 === 0) onProgress(p0 + (p1 - p0) * ((pass + i / loops.length) / 3));
      });
      const keep = [];
      for (let f = 0; f < faces.length / 3; f++) if (!removed[f]) keep.push(f);
      rebuild(keep, added);
    }
  };
  onProgress(0.2);

  const first = reorient(mesh.verts);
  // The deduped, oriented mesh: a safe result to fall back on (see the end).
  const oriented = { faces: faces.slice(), org: org.slice(), cor: cor.slice() };
  if (first.conflicts.length) cutConflicts(first.conflicts);
  onProgress(0.4);
  closeHoles(0.4, 0.8);

  // Sheets that only touch along an edge (an even number of faces on it that pair
  // up): give each sheet its own copy of the edge's vertices instead of cutting.
  // Copies of a vertex made here are remembered, to order the output for STL readers.
  const copyOf = new Map();
  const addCopy = (x, y, z, of) => { const v = addVertex(x, y, z); copyOf.set(v, copyOf.get(of) ?? of); return v; };
  const splitPinched = (geometricOnly) => splitPinchedEdges(allVerts(), faces, V, addCopy, geometricOnly);
  // STL keeps no vertex indices, so a reader joins the copies again by position and
  // must pair the faces on such an edge itself. Slicers built on admesh (Bambu Studio,
  // PrusaSlicer) pair them in file order: first with second, third with fourth. So list
  // the faces on each of these edges sheet by sheet (the two faces that share the
  // edge's copied vertices next to each other), at the end of the list.
  const orderPinchedPairs = () => {
    const F = faces.length / 3;
    const root = (v) => copyOf.get(v) ?? v;
    const split = new Set(copyOf.values());
    const byPlace = new Map(); // edge between the original vertices -> [face, edge key, ...]
    for (let f = 0; f < F; f++) {
      for (let k = 0; k < 3; k++) {
        const a = root(faces[f * 3 + k]), b = root(faces[f * 3 + ((k + 1) % 3)]);
        if (!split.has(a) && !split.has(b)) continue;
        const key = edgeKey(a, b, V);
        let l = byPlace.get(key);
        if (!l) byPlace.set(key, (l = []));
        l.push(f, edgeKey(faces[f * 3 + k], faces[f * 3 + ((k + 1) % 3)], V));
      }
    }
    // Edges whose faces are not yet listed sheet by sheet, and every such edge sharing
    // a face with one (moving that face would upset it).
    const pinched = [], faceEdges = new Map();
    for (const l of byPlace.values()) {
      if (l.length <= 4) continue; // two faces: an ordinary edge
      const sheets = new Map();
      for (let i = 0; i < l.length; i += 2) {
        if (!sheets.has(l[i + 1])) sheets.set(l[i + 1], []);
        sheets.get(l[i + 1]).push(l[i]);
      }
      const inOrder = l.filter((_, i) => i % 2 === 0).sort((a, b) => a - b);
      const sheetOf = new Map();
      for (const [key, fs] of sheets) for (const f of fs) sheetOf.set(f, key);
      let ok = true;
      for (let i = 0; i + 1 < inOrder.length; i += 2) if (sheetOf.get(inOrder[i]) !== sheetOf.get(inOrder[i + 1])) ok = false;
      const e = { sheets, ok };
      pinched.push(e);
      for (const f of inOrder) { if (!faceEdges.has(f)) faceEdges.set(f, []); faceEdges.get(f).push(e); }
    }
    const todo = pinched.filter((e) => !e.ok);
    for (let i = 0; i < todo.length; i++) {
      for (const fs of todo[i].sheets.values()) for (const f of fs) for (const e of faceEdges.get(f)) if (e.ok) { e.ok = false; todo.push(e); }
    }
    // Each face's partners: the other face on the same copy of each such edge.
    const partners = new Map(), edgesHere = [];
    for (const { sheets } of todo) {
      for (const fs of sheets.values()) {
        if (fs.length !== 2) continue;
        for (const [f, g] of [fs, [fs[1], fs[0]]]) {
          if (!partners.has(f)) partners.set(f, []);
          partners.get(f).push(g);
        }
        edgesHere.push(fs[0]);
      }
    }
    if (!edgesHere.length) return;
    // Place a face and, right after it, its partner on every such edge it is on, so a
    // face on two of these edges keeps both of its pairs together.
    const placed = new Uint8Array(F), tail = [];
    const place = (f) => {
      const stack = [f];
      while (stack.length) {
        const g = stack.pop();
        if (placed[g]) continue;
        placed[g] = 1; tail.push(g);
        const ps = partners.get(g) || [];
        for (let i = ps.length - 1; i >= 0; i--) stack.push(ps[i]);
      }
    };
    for (const f of edgesHere) place(f);
    const keep = [];
    for (let f = 0; f < F; f++) if (!placed[f]) keep.push(f);
    rebuild(keep.concat(tail));
  };
  const volumeOf = (fs) => {
    const vs = allVerts();
    let s = 0;
    for (let f = 0; f < fs.length / 3; f++) s += signedVolume(vs, fs[f * 3], fs[f * 3 + 1], fs[f * 3 + 2]);
    return s;
  };
  // Splitting moves nothing, but sheets that cross at the edge become solids that
  // overlap, and orienting can then take one for a cavity of the other and turn it
  // inside out. So keep the split only if the oriented volume stays the same; else try
  // again with the geometry's pairings alone, and else leave those edges to the cleanup.
  const unsplit = faces;
  faces = faces.slice();
  if (splitPinched()) {
    const v0 = Math.abs(volumeOf(orient(allVerts(), unsplit, V).faces));
    const keeps = () => Math.abs(Math.abs(volumeOf(orient(allVerts(), faces, V).faces)) - v0) <= Math.max(v0, 1e-30) * 1e-3;
    if (!keeps()) {
      faces = unsplit.slice();
      if (splitPinched(true) && !keeps()) faces = unsplit.slice();
    }
  }

  // Edges still shared by more than two faces (touching shells, stray internal faces):
  // remove the faces on them and close the resulting holes, a few rounds at most.
  // Kept only if the solid keeps its volume: a manifold mesh of the wrong shape is worse.
  const beforeCleanup = { faces, org, cor };
  let cleaned = false;
  for (let round = 0; round < 3; round++) {
    // Caps from the previous round can meet along an edge too.
    if (round) splitPinched();
    const bad = nonManifoldFaces(faces, V);
    if (!bad.size) break;
    cleaned = true;
    keepWhere((f) => !bad.has(f));
    const vNow = allVerts();
    const added = [];
    for (const loop of boundaryLoops(faces, V)) {
      for (const t of triangulateLoop(vNow, loop, addVertex)) added.push(t[0], t[1], t[2]);
    }
    rebuild(null, added);
  }
  if (cleaned) {
    const vs = allVerts();
    const v0 = Math.abs(volumeOf(orient(vs, beforeCleanup.faces, V).faces));
    const v1 = Math.abs(volumeOf(orient(vs, faces, V).faces));
    // Also only if it leaves fewer bad edges, counted once faces with no area are gone
    // (as they are at the end): caps across a loop of points in a line have no area,
    // and dropping them would open the holes again.
    const sound = (fs) => {
      const keep = [];
      for (let f = 0; f < fs.length / 3; f++) if (!isDegenerate(vs, fs, f, areaEps)) keep.push(fs[f * 3], fs[f * 3 + 1], fs[f * 3 + 2]);
      const c = edgeProblems(keep, V);
      return c.naked + c.nonManifold;
    };
    if (Math.abs(v1 - v0) > Math.max(v0, 1e-30) * 1e-3 || sound(faces) >= sound(beforeCleanup.faces)) ({ faces, org, cor } = beforeCleanup);
  }
  onProgress(0.85);

  const keepShells = dropDebrisShells(allVerts(), faces, V, diag);
  if (keepShells) rebuild(keepShells);
  // Orient once more with the new patches; cut and cap again if a conflict is left.
  for (let round = 0; round < 3; round++) {
    const o = reorient(allVerts());
    if (!o.conflicts.length || round === 2 || !cutConflicts(o.conflicts)) break;
    closeHoles(0.85, 0.9);
  }
  const verts = allVerts();
  keepWhere((f) => !isDegenerate(verts, faces, f, areaEps));
  if (copyOf.size) orderPinchedPairs();

  // Do no harm: if all this left the part worse than it came in (more open, non-manifold
  // or conflicting edges, or more faces wound the wrong way), give back the deduped and
  // oriented mesh, or failing that the input with only its windings turned.
  const score = (a) => [a.NakedEdges + a.NonManifoldEdges + a.OrientationConflicts, a.InvertedNormals];
  const worse = (a, b) => a[0] > b[0] || a[1] > b[1];
  const input = score(analyze(mesh));
  if (worse(score(analyze({ verts, faces, vCount: V, diag })), input)) {
    ({ faces, org, cor } = oriented);
    if (worse(score(analyze({ verts, faces, vCount: V, diag })), input)) {
      const o = orient(mesh.verts, mesh.faces, mesh.vCount);
      faces = o.faces; org = Int32Array.from({ length: faces.length / 3 }, (_, f) => f); cor = new Uint8Array(faces.length);
      for (let f = 0; f < org.length; f++) { cor[f * 3 + 1] = o.flip[f] ? 2 : 1; cor[f * 3 + 2] = o.flip[f] ? 1 : 2; }
      if (worse(score(analyze({ verts, faces, vCount: V, diag })), input)) {
        faces = mesh.faces.slice(); cor = new Uint8Array(faces.length);
        for (let f = 0; f < org.length; f++) { cor[f * 3 + 1] = 1; cor[f * 3 + 2] = 2; }
      }
    }
  }

  const used = new Uint8Array(V);
  for (const v of faces) used[v] = 1;
  let usedCount = 0;
  for (let i = 0; i < V; i++) usedCount += used[i];
  const reversed = new Uint8Array(org.length);
  for (let f = 0; f < org.length; f++) reversed[f] = org[f] >= 0 && (cor[f * 3 + 1] + 3 - cor[f * 3]) % 3 === 2 ? 1 : 0;
  onProgress(1);
  return { verts, faces, vCount: V, usedVertices: usedCount, diag, origin: org, reversed, corner: cor };
}

/** Enclosed volume (signed: positive when faces point outward). */
export function meshVolume(mesh) {
  const { verts, faces } = mesh;
  let v = 0;
  for (let f = 0; f < faces.length / 3; f++) v += signedVolume(verts, faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
  return v;
}

/**
 * Enclosed volume with the faces turned outward first. Flipped faces make meshVolume
 * cancel itself out, so this is the fair "before" figure to compare a repair against.
 */
export function orientedVolume(mesh) {
  return Math.abs(meshVolume({ verts: mesh.verts, faces: orient(mesh.verts, mesh.faces, mesh.vCount).faces }));
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** Binary STL with freshly computed facet normals. */
export function writeStl(mesh, header = 'repaired in the browser') {
  const { verts, faces } = mesh;
  const F = faces.length / 3;
  const buf = new ArrayBuffer(84 + F * 50);
  const view = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, F, true);
  let o = 84;
  for (let f = 0; f < F; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(o, nx / l, true); view.setFloat32(o + 4, ny / l, true); view.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, verts[v], true); view.setFloat32(o + 4, verts[v + 1], true); view.setFloat32(o + 8, verts[v + 2], true);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

/** Flat triangle corners, at most maxTris (evenly sampled), for drawing previews. */
export function toTriangles(mesh, maxTris = 250000) {
  const { verts, faces } = mesh;
  const F = faces.length / 3;
  const step = Math.max(1, Math.ceil(F / maxTris));
  const n = Math.ceil(F / step);
  const out = new Float32Array(n * 9);
  let o = 0;
  for (let f = 0; f < F; f += step) {
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k] * 3;
      out[o++] = verts[v]; out[o++] = verts[v + 1]; out[o++] = verts[v + 2];
    }
  }
  return out.subarray(0, o);
}

export const PROBLEM_OPEN = 1;   // touches an edge used by only one face (a hole)
export const PROBLEM_WALL = 2;   // touches an edge shared by 3+ faces, or is a duplicate face
export const PROBLEM_FLIPPED = 4; // wound the wrong way round

/**
 * One flag byte per face saying which problems it takes part in, for colouring
 * the "before" model. The same rules as analyze(), but per face instead of a count.
 */
export function problemFaces(mesh) {
  const { verts, faces, vCount } = mesh;
  const F = faces.length / 3;
  const flags = new Uint8Array(F);

  const { head, next } = buildEdges(faces, vCount);
  for (const he0 of head.values()) {
    let c = 0;
    for (let he = he0; he !== -1; he = next[he]) c++;
    if (c === 2) continue;
    const bit = c === 1 ? PROBLEM_OPEN : PROBLEM_WALL;
    for (let he = he0; he !== -1; he = next[he]) flags[(he / 3) | 0] |= bit;
  }

  // Every face in a group that shares the same three corners (both copies of a
  // duplicate, both sides of a paper-thin wall).
  const first = new Map();
  for (let f = 0; f < F; f++) {
    const k = sortedTriKey(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
    const g = first.get(k);
    if (g === undefined) first.set(k, f);
    else { flags[f] |= PROBLEM_WALL; flags[g] |= PROBLEM_WALL; }
  }

  const { flip } = orient(verts, faces, vCount);
  for (let f = 0; f < F; f++) if (flip[f]) flags[f] |= PROBLEM_FLIPPED;
  return flags;
}

/** Segments of edges that belong to only one face (holes), for the "before" preview. */
export function nakedSegments(mesh, max = 100000) {
  const { verts, faces, vCount } = mesh;
  const { head, next } = buildEdges(faces, vCount);
  const segs = [];
  for (const he of head.values()) {
    if (next[he] !== -1) continue;
    const f = (he / 3) | 0, k = he % 3;
    const a = faces[f * 3 + k] * 3, b = faces[f * 3 + ((k + 1) % 3)] * 3;
    segs.push(verts[a], verts[a + 1], verts[a + 2], verts[b], verts[b + 1], verts[b + 2]);
    if (segs.length >= max * 6) break;
  }
  return Float32Array.from(segs);
}
