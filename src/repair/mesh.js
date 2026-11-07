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
  const out = [];
  for (const g of order) {
    if (g.net === 0) continue;
    const f = g.first;
    if (g.net > 0) out.push(src[f * 3], src[f * 3 + 1], src[f * 3 + 2]);
    else out.push(src[f * 3], src[f * 3 + 2], src[f * 3 + 1]);
  }
  return Uint32Array.from(out);
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
  if (shells.size < 2) return faces;
  let largest = null;
  for (const [r, s] of shells) if (!largest || Math.abs(s.vol) > Math.abs(shells.get(largest).vol)) largest = r;
  const drop = new Set();
  for (const [r, s] of shells) {
    if (r === largest) continue;
    const size = Math.hypot(s.box[3] - s.box[0], s.box[4] - s.box[1], s.box[5] - s.box[2]);
    if (size < diag * 1e-3 || Math.abs(s.vol) < diag * diag * diag * 1e-12) drop.add(r);
  }
  if (!drop.size) return faces;
  const keep = [];
  for (let f = 0; f < F; f++) if (!drop.has(find(faces[f * 3]))) keep.push(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
  return Uint32Array.from(keep);
}

/* ------------------------------------------------------------------ */
/* Orientation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Make neighbouring faces agree on their winding (walking across edges shared by
 * exactly two faces), then turn each closed patch outward (cavities inward).
 * Returns the new faces and how many faces ended up flipped.
 */
function orient(verts, faces, V) {
  const F = faces.length / 3;
  const out = faces.slice();
  const { head, next } = buildEdges(out, V);
  const flip = new Uint8Array(F);
  const seen = new Uint8Array(F);
  const comp = new Int32Array(F).fill(-1);
  let comps = 0;
  const stack = [];
  const open = []; // per patch: has an edge not shared by exactly two faces

  for (let s = 0; s < F; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    comp[s] = comps;
    open.push(0);
    stack.push(s);
    while (stack.length) {
      const f = stack.pop();
      for (let k = 0; k < 3; k++) {
        let a = out[f * 3 + k], b = out[f * 3 + ((k + 1) % 3)];
        if (a === b) continue;
        if (flip[f]) { const t = a; a = b; b = t; }
        let cnt = 0, other = -1;
        for (let he = head.get(edgeKey(a, b, V)); he !== undefined && he !== -1; he = next[he]) {
          cnt++;
          if (((he / 3) | 0) !== f) other = he;
        }
        if (cnt !== 2 || other === -1) { open[comps] = 1; continue; }
        const g = (other / 3) | 0;
        if (seen[g]) continue;
        const gk = other % 3;
        const ga = out[g * 3 + gk], gb = out[g * 3 + ((gk + 1) % 3)];
        // neighbours that agree run the shared edge in opposite directions
        flip[g] = ga === a && gb === b ? 1 : 0;
        seen[g] = 1;
        comp[g] = comps;
        stack.push(g);
      }
    }
    comps++;
  }

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
  return { faces: out, flipped, flip };
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
    const p = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) p[d] += verts[faces[f0 * 3 + k] * 3 + d] / 3;
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

  const { flipped } = orient(verts, faces, vCount);
  const shells = shellCount(faces, vCount);

  return {
    NakedEdges: nakedEdges,
    PlanarHoles: planar,
    NonPlanarHoles: nonPlanar,
    NonManifoldEdges: nonManifold,
    InvertedNormals: flipped,
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
 * face outward, close holes, then orient again with the new patches.
 * onProgress(fraction 0..1) is called along the way.
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

  onProgress(0.05);
  let faces = dedupe(mesh.verts, mesh.faces, areaEps);
  onProgress(0.2);

  faces = orient(mesh.verts, faces, V).faces;
  onProgress(0.4);

  for (let pass = 0; pass < 3; pass++) {
    const loops = boundaryLoops(faces, V);
    if (!loops.length) break;
    const vNow = allVerts();
    const addVertex = (x, y, z) => { extra.push(x, y, z); return V++; };
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
      if (i % 50 === 0) onProgress(0.4 + 0.4 * ((pass + i / loops.length) / 3));
    });
    const merged = [];
    for (let f = 0; f < faces.length / 3; f++) if (!removed[f]) merged.push(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
    for (const v of added) merged.push(v);
    faces = Uint32Array.from(merged);
  }

  // Edges still shared by more than two faces (touching shells, stray internal faces):
  // remove the faces on them and close the resulting holes, a few rounds at most.
  // Kept only if the solid keeps its volume: a manifold mesh of the wrong shape is worse.
  const beforeCleanup = faces;
  const volumeOf = (fs) => {
    const vs = allVerts();
    let s = 0;
    for (let f = 0; f < fs.length / 3; f++) s += signedVolume(vs, fs[f * 3], fs[f * 3 + 1], fs[f * 3 + 2]);
    return s;
  };
  let cleaned = false;
  for (let round = 0; round < 3; round++) {
    const bad = nonManifoldFaces(faces, V);
    if (!bad.size) break;
    cleaned = true;
    const keep = [];
    for (let f = 0; f < faces.length / 3; f++) if (!bad.has(f)) keep.push(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
    faces = Uint32Array.from(keep);
    const vNow = allVerts();
    const addVertex = (x, y, z) => { extra.push(x, y, z); return V++; };
    const added = [];
    for (const loop of boundaryLoops(faces, V)) {
      for (const t of triangulateLoop(vNow, loop, addVertex)) added.push(t[0], t[1], t[2]);
    }
    const merged = new Uint32Array(faces.length + added.length);
    merged.set(faces);
    merged.set(added, faces.length);
    faces = merged;
  }
  if (cleaned) {
    const v0 = Math.abs(volumeOf(orient(allVerts(), beforeCleanup, V).faces));
    const v1 = Math.abs(volumeOf(orient(allVerts(), faces, V).faces));
    if (Math.abs(v1 - v0) > Math.max(v0, 1e-30) * 1e-3) faces = beforeCleanup;
  }
  onProgress(0.85);

  const verts = allVerts();
  faces = dropDebrisShells(verts, faces, V, diag);
  faces = orient(verts, faces, V).faces;
  const keep = [];
  for (let f = 0; f < faces.length / 3; f++) {
    if (!isDegenerate(verts, faces, f, areaEps)) keep.push(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
  }
  faces = Uint32Array.from(keep);

  const used = new Uint8Array(V);
  for (const v of faces) used[v] = 1;
  let usedCount = 0;
  for (let i = 0; i < V; i++) usedCount += used[i];
  onProgress(1);
  return { verts, faces, vCount: V, usedVertices: usedCount, diag };
}

/** Enclosed volume (signed: positive when faces point outward). */
export function meshVolume(mesh) {
  const { verts, faces } = mesh;
  let v = 0;
  for (let f = 0; f < faces.length / 3; f++) v += signedVolume(verts, faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
  return v;
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
