// In-browser 3MF reading.
// Pure functions (no DOM) so they run in a Web Worker and in Node tests.
// The XML is scanned with regexes instead of a DOM parser: workers have no DOMParser,
// and a big model file would cost far too much memory as an element tree.

import { unzipSync, zipSync } from 'fflate';

export class ThreeMfError extends Error {}

export const MAX_UNCOMPRESSED = 1024 * 1024 * 1024; // 1 GiB total uncompressed
const MAX_DEPTH = 16; // component nesting limit
const UNITS = ['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'];
const BAMBU_KINDS = {
  normal_part: 'normal',
  negative_part: 'negative',
  modifier_part: 'modifier',
  support_blocker: 'support_blocker',
  support_enforcer: 'support_enforcer',
};
// 3MF object types that are not plain printable models.
const TYPE_KINDS = { other: 'modifier', support: 'support_blocker', solidsupport: 'support_enforcer' };

/* ------------------------------------------------------------------ */
/* Transforms                                                          */
/* ------------------------------------------------------------------ */

export const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

/** Combine two 3MF transforms: result applies `inner` first, then `outer`. */
export function composeTransforms(outer, inner) {
  const r = new Float64Array(12);
  for (let row = 0; row < 4; row++) {
    for (let c = 0; c < 3; c++) {
      // Row-vector convention: point' = point * M, with the last row as translation.
      let v = row === 3 ? outer[9 + c] : 0;
      for (let k = 0; k < 3; k++) v += inner[row * 3 + k] * outer[k * 3 + c];
      r[row * 3 + c] = v;
    }
  }
  return r;
}

/** Apply a 12-number 3MF transform to verts (returns new Float64Array). */
export function transformVerts(verts, m) {
  const out = new Float64Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    out[i] = x * m[0] + y * m[3] + z * m[6] + m[9];
    out[i + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
    out[i + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
  }
  return out;
}

function parseTransform(s) {
  if (s == null) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some((v) => !Number.isFinite(v))) throw new ThreeMfError('the 3mf file has an invalid transform');
  return new Float64Array(n);
}

/* ------------------------------------------------------------------ */
/* XML scanning                                                        */
/* ------------------------------------------------------------------ */

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrs(s) {
  const a = {};
  ATTR_RE.lastIndex = 0;
  for (let m; (m = ATTR_RE.exec(s)); ) a[m[1]] = decode(m[2] ?? m[3]);
  return a;
}

function decode(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]);
}

// The production extension's path attribute; the namespace prefix can be anything.
function pathAttr(a) {
  for (const k in a) if (k === 'path' || k.endsWith(':path')) return a[k].replace(/^\/+/, '');
  return null;
}

// Each <vertex>/<triangle> tag is matched first and its attributes are read by name, so
// any attribute order parses; skipping a tag would silently shift every later index.
const VERTEX_TAG = /<vertex\b([^>]*)>/g;
const TRIANGLE_TAG = /<triangle\b([^>]*)>/g;
const ATTR_RES = {};
function attrNum(tag, name) {
  const re = ATTR_RES[name] || (ATTR_RES[name] = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`));
  const m = re.exec(tag);
  return m ? +m[1] : NaN;
}

// Fill typed arrays straight from the text; no per-vertex objects (files can have 100k+ triangles).
function parseMesh(xml, where) {
  let verts = new Float64Array(3 * 4096);
  let nv = 0;
  VERTEX_TAG.lastIndex = 0;
  for (let m; (m = VERTEX_TAG.exec(xml)); ) {
    if (nv * 3 + 3 > verts.length) {
      const bigger = new Float64Array(verts.length * 2);
      bigger.set(verts);
      verts = bigger;
    }
    const x = attrNum(m[1], 'x'), y = attrNum(m[1], 'y'), z = attrNum(m[1], 'z');
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) throw new ThreeMfError(`${where} has a vertex with a missing or invalid coordinate`);
    verts[nv * 3] = x;
    verts[nv * 3 + 1] = y;
    verts[nv * 3 + 2] = z;
    nv++;
  }
  let faces = new Uint32Array(3 * 4096);
  let nt = 0;
  let max = -1;
  TRIANGLE_TAG.lastIndex = 0;
  for (let m; (m = TRIANGLE_TAG.exec(xml)); ) {
    if (nt * 3 + 3 > faces.length) {
      const bigger = new Uint32Array(faces.length * 2);
      bigger.set(faces);
      faces = bigger;
    }
    const a = attrNum(m[1], 'v1'), b = attrNum(m[1], 'v2'), c = attrNum(m[1], 'v3');
    if (!(Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c) && a >= 0 && b >= 0 && c >= 0)) throw new ThreeMfError(`${where} has a triangle with an invalid vertex index`);
    faces[nt * 3] = a;
    faces[nt * 3 + 1] = b;
    faces[nt * 3 + 2] = c;
    if (a > max) max = a;
    if (b > max) max = b;
    if (c > max) max = c;
    nt++;
  }
  if (max >= nv) throw new ThreeMfError(`${where} has a triangle that points at a missing vertex`);
  return { verts: verts.slice(0, nv * 3), faces: faces.slice(0, nt * 3) };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

// Index one model file: object records (meshes stay unparsed until reached), build items, unit.
function indexModel(xml) {
  const modelTag = /<model\b[^>]*>/.exec(xml);
  const unit = modelTag ? attrs(modelTag[0]).unit : undefined;
  const objects = new Map();
  const re = /<object\b([^>]*?)(\/?)>/g;
  for (let m; (m = re.exec(xml)); ) {
    const a = attrs(m[1]);
    let body = '';
    if (!m[2]) {
      const end = xml.indexOf('</object>', re.lastIndex);
      if (end < 0) break;
      body = xml.slice(re.lastIndex, end);
      re.lastIndex = end;
    }
    const o = { id: a.id, name: a.name, type: a.type, mesh: null, meshXml: null, components: [] };
    if (body.includes('<mesh')) o.meshXml = body;
    else {
      for (const c of body.matchAll(/<component\b([^>]*?)\/?>/g)) {
        const ca = attrs(c[1]);
        o.components.push({ id: ca.objectid, path: pathAttr(ca), transform: parseTransform(ca.transform) });
      }
    }
    objects.set(a.id, o);
  }
  const items = [];
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
  if (build) {
    for (const m of build[1].matchAll(/<item\b([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      items.push({ id: a.objectid, path: pathAttr(a), transform: parseTransform(a.transform) });
    }
  }
  return { unit, objects, items };
}

// Bambu Studio part types: objectId -> Map(partId -> { subtype, name }).
function parseBambuParts(xml) {
  const byObject = new Map();
  for (const o of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const parts = new Map();
    for (const p of o[2].matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)) {
      const pa = attrs(p[1]);
      const nm = /<metadata\b[^>]*\bkey\s*=\s*["']name["'][^>]*\bvalue\s*=\s*["']([^"']*)["']/.exec(p[2]);
      parts.set(pa.id, { subtype: pa.subtype, name: nm ? decode(nm[1]) : null });
    }
    byObject.set(attrs(o[1]).id, parts);
  }
  return byObject;
}

// Bambu root-object display names (objectId -> name) and plate numbers (objectId -> plater_id).
function parseBambuMeta(xml) {
  const names = new Map();
  const plates = new Map();
  const meta = (s, key) => {
    const m = new RegExp(`<metadata\\b[^>]*\\bkey\\s*=\\s*["']${key}["'][^>]*\\bvalue\\s*=\\s*["']([^"']*)["']`).exec(s);
    return m ? decode(m[1]) : null;
  };
  for (const o of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const head = o[2].split(/<part\b/)[0];
    const nm = meta(head, 'name');
    if (nm) names.set(attrs(o[1]).id, nm);
  }
  for (const p of xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const num = meta(p[1], 'plater_id');
    if (num == null || !Number.isFinite(+num)) continue;
    for (const mi of p[1].matchAll(/<model_instance\b[^>]*>([\s\S]*?)<\/model_instance>/g)) {
      const oid = meta(mi[1], 'object_id');
      if (oid != null && !plates.has(oid)) plates.set(oid, +num);
    }
  }
  return { names, plates };
}

/**
 * Read a 3MF (zip) into mesh resources with every place each one is printed.
 * Throws ThreeMfError with a user-facing message when the file is unusable.
 */
export function parse3mf(buffer, { maxUncompressed = MAX_UNCOMPRESSED } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // First pass reads sizes from the central directory only, so a zip bomb is refused before inflating.
  let entries;
  try {
    let total = 0;
    unzipSync(bytes, { filter: (f) => ((total += f.originalSize), false) });
    if (total > maxUncompressed) throw new ThreeMfError(`this 3MF expands to more than ${Math.round(maxUncompressed / 1048576)} MB`);
    entries = unzipSync(bytes);
  } catch (e) {
    if (e instanceof ThreeMfError) throw e;
    throw new ThreeMfError('the file is not a valid 3mf (zip) archive');
  }

  const text = (path) => new TextDecoder().decode(entries[path]);

  let rootPath = '3D/3dmodel.model';
  if (entries['_rels/.rels']) {
    for (const m of text('_rels/.rels').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      if (a.Type && a.Type.endsWith('/3dmodel') && a.Target) {
        rootPath = a.Target.replace(/^\/+/, '');
        break;
      }
    }
  }
  if (!entries[rootPath]) {
    rootPath = Object.keys(entries).find((p) => /^3D\/.*\.model$/i.test(p));
    if (!rootPath) throw new ThreeMfError('no 3d model was found in this 3mf file');
  }

  const models = new Map(); // path -> indexed model
  const getModel = (path) => {
    let mod = models.get(path);
    if (!mod) {
      if (!entries[path]) throw new ThreeMfError(`the 3mf file points at a missing model file (${path})`);
      mod = indexModel(text(path));
      models.set(path, mod);
    }
    return mod;
  };

  const root = getModel(rootPath);
  const unit = UNITS.includes(root.unit) ? root.unit : 'millimeter';
  const settings = entries['Metadata/model_settings.config'] ? text('Metadata/model_settings.config') : null;
  const bambu = settings ? parseBambuParts(settings) : new Map();
  const meta = settings ? parseBambuMeta(settings) : { names: new Map(), plates: new Map() };
  let rootId = null; // the build object being walked

  const found = new Map(); // key -> resource
  const walk = (path, id, matrix, depth, stack, parts) => {
    if (depth > MAX_DEPTH) throw new ThreeMfError('the 3mf file nests its parts too deeply');
    const key = `${path}#${id}`;
    if (stack.has(key)) throw new ThreeMfError('the 3mf file has parts that contain themselves');
    const o = getModel(path).objects.get(id);
    if (!o) throw new ThreeMfError(`the 3mf file points at a missing object (${key})`);
    if (o.meshXml) {
      let r = found.get(key);
      if (!r) {
        const part = parts && parts.get(id);
        const { verts, faces } = parseMesh(o.meshXml, `object ${id}`);
        if (!faces.length) return;
        r = {
          key, path, id, verts, faces, placements: [],
          group: meta.names.get(rootId) || getModel(rootPath).objects.get(rootId)?.name || `Object ${rootId}`,
          plate: meta.plates.has(rootId) ? meta.plates.get(rootId) : null,
          name: o.name || (part && part.name) || `Object ${id}`,
          kind: (part && BAMBU_KINDS[part.subtype]) || TYPE_KINDS[o.type] || 'normal',
        };
        found.set(key, r);
      }
      r.placements.push(matrix);
      return;
    }
    // Bambu part ids refer to the component object ids under a root-model object.
    const childParts = path === rootPath ? bambu.get(id) : parts;
    stack.add(key);
    for (const c of o.components) {
      walk(c.path || path, c.id, composeTransforms(matrix, c.transform), depth + 1, stack, childParts);
    }
    stack.delete(key);
  };
  for (const item of root.items) {
    rootId = item.id;
    walk(item.path || rootPath, item.id, item.transform, 0, new Set(), null);
  }

  if (!found.size) throw new ThreeMfError('this 3mf file has no printable mesh objects');
  return { unit, entries, rootPath, objects: [...found.values()] };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

// ignoreBOM keeps a leading BOM in the string so it survives the round trip.
const XML_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });
const XML_ENCODER = new TextEncoder();
const TAG_ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// 6 decimals, trailing zeros trimmed; falls back to 9 when 6 would move a value by more than 1e-9.
function fmtNum(v) {
  let s = v.toFixed(6);
  if (Math.abs(+s - v) > 1e-9) s = v.toFixed(9);
  if (s.indexOf('.') >= 0) {
    let e = s.length;
    while (s.charCodeAt(e - 1) === 48) e--;
    if (s.charCodeAt(e - 1) === 46) e--;
    s = s.slice(0, e);
  }
  return s === '-0' ? '0' : s;
}

// Span of <object id=...>'s body in the model text.
function findObjectBody(xml, id) {
  const re = /<object\b([^>]*?)(\/?)>/g;
  for (let m; (m = re.exec(xml)); ) {
    if (m[2] || attrs(m[1]).id !== id) continue;
    const end = xml.indexOf('</object>', re.lastIndex);
    if (end >= 0) return { start: re.lastIndex, end };
  }
  throw new ThreeMfError(`the 3mf file lost object ${id} while saving`);
}

// Span of the content of <tag>…</tag> within [from, to).
function findInner(xml, tag, from, to) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'g');
  re.lastIndex = from;
  const m = re.exec(xml);
  const end = m ? xml.indexOf(`</${tag}>`, re.lastIndex) : -1;
  if (!m || m.index >= to || end < 0 || end > to) throw new ThreeMfError(`the 3mf file has an object without <${tag}>`);
  return { start: re.lastIndex, end };
}

// A raw attribute value from the file is already escaped, except a " inside a '…' value.
const rawValue = (m) => (m[3] !== undefined ? m[3].replace(/"/g, '&quot;') : m[2]);

// Everything but v1..v3 from the original tag, with p1..p3 permuted and paint_* dropped when not `keepPaint`.
function carryAttrs(raw, corner, keepPaint) {
  const list = [];
  const p = [];
  TAG_ATTR_RE.lastIndex = 0;
  for (let m; (m = TAG_ATTR_RE.exec(raw)); ) {
    const n = m[1];
    if (n === 'v1' || n === 'v2' || n === 'v3') continue;
    const v = rawValue(m);
    if (n === 'p1' || n === 'p2' || n === 'p3') p[n.charCodeAt(1) - 49] = v;
    list.push(n, v);
  }
  const perCorner = p[0] !== undefined && p[1] !== undefined && p[2] !== undefined;
  let s = '';
  let paint = false;
  for (let i = 0; i < list.length; i += 2) {
    const n = list[i];
    let v = list[i + 1];
    if (n.startsWith('paint_')) {
      paint = true;
      if (!keepPaint) continue;
    } else if (perCorner && (n === 'p1' || n === 'p2' || n === 'p3')) v = p[corner[n.charCodeAt(1) - 49]];
    s += ` ${n}="${v}"`;
  }
  return { s, lost: paint && !keepPaint };
}

// New <vertices> and <triangles> inner text for one repaired object.
function buildMesh(xml, body, r) {
  const vs = findInner(xml, 'vertices', body.start, body.end);
  const ts = findInner(xml, 'triangles', vs.end, body.end);
  const lead = (s, e) => /^\s*/.exec(xml.slice(s, Math.min(e, s + 64)))[0];
  const trail = (s, e) => /\s*$/.exec(xml.slice(Math.max(s, e - 64), e))[0];

  // Where each original <triangle> tag's attributes sit (one scan; 279k triangles is fine).
  let starts = new Int32Array(4096);
  let ends = new Int32Array(4096);
  let nt = 0;
  const tre = /<triangle\b([^>]*)>/g;
  tre.lastIndex = ts.start;
  for (let m; (m = tre.exec(xml)) && m.index < ts.end; ) {
    if (nt === starts.length) {
      const s2 = new Int32Array(nt * 2), e2 = new Int32Array(nt * 2);
      s2.set(starts);
      e2.set(ends);
      starts = s2;
      ends = e2;
    }
    starts[nt] = m.index + 9; // past "<triangle"
    ends[nt] = tre.lastIndex - 1;
    nt++;
  }

  // Only write vertices a face uses, in their original order.
  const nv = r.verts.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  for (let i = 0; i < r.faces.length; i++) remap[r.faces[i]] = 0;
  const vlines = [];
  for (let i = 0; i < nv; i++) {
    if (remap[i] < 0) continue;
    remap[i] = vlines.length;
    vlines.push(`<vertex x="${fmtNum(r.verts[3 * i])}" y="${fmtNum(r.verts[3 * i + 1])}" z="${fmtNum(r.verts[3 * i + 2])}"/>`);
  }

  const nf = r.faces.length / 3;
  const tlines = new Array(nf);
  const IDENT = [0, 1, 2];
  let lost = 0;
  for (let f = 0; f < nf; f++) {
    let s = `<triangle v1="${remap[r.faces[3 * f]]}" v2="${remap[r.faces[3 * f + 1]]}" v3="${remap[r.faces[3 * f + 2]]}"`;
    const o = r.origin ? r.origin[f] : -1;
    if (o >= 0) {
      if (o >= nt) throw new ThreeMfError('the repair points at a triangle the 3mf file does not have');
      const corner = r.corner ? [r.corner[3 * f], r.corner[3 * f + 1], r.corner[3 * f + 2]] : IDENT;
      // Paint is per facet side; it only stays valid on a triangle that kept its winding and corner order.
      const keep = !(r.reversed && r.reversed[f]) && corner[0] === 0 && corner[1] === 1 && corner[2] === 2;
      const c = carryAttrs(xml.slice(starts[o], ends[o]), corner, keep);
      s += c.s;
      if (c.lost) lost++;
    }
    tlines[f] = s + '/>';
  }

  const wrap = (sec, lines) => {
    const l = lead(sec.start, sec.end), t = trail(sec.start, sec.end);
    return lines.length ? l + lines.join(l) + t : t;
  };
  return { vs, ts, vtext: wrap(vs, vlines), ttext: wrap(ts, tlines), lost, nt };
}

/**
 * Write the parsed 3MF back out with the repaired objects' meshes swapped in.
 * `repaired` maps object key -> repair() result; every other entry is copied unchanged.
 * Returns { bytes, paintLost } (paintLost = triangles whose Bambu paint could not be kept).
 */
export function write3mf(parsed, repaired) {
  const byPath = new Map();
  for (const o of parsed.objects) {
    const r = repaired.get(o.key);
    if (!r) continue;
    if (!byPath.has(o.path)) byPath.set(o.path, []);
    byPath.get(o.path).push({ o, r });
  }

  let paintLost = 0;
  const files = {};
  for (const path in parsed.entries) {
    const data = parsed.entries[path];
    const jobs = byPath.get(path);
    let bytes = data;
    if (jobs) {
      const xml = XML_DECODER.decode(data);
      const edits = [];
      for (const { o, r } of jobs) {
        const m = buildMesh(xml, findObjectBody(xml, o.id), r);
        if (m.nt !== o.faces.length / 3) throw new ThreeMfError(`object ${o.id} changed while saving`);
        paintLost += m.lost;
        edits.push([m.vs.start, m.vs.end, m.vtext], [m.ts.start, m.ts.end, m.ttext]);
      }
      edits.sort((a, b) => a[0] - b[0]);
      const parts = [];
      let at = 0;
      for (const [s, e, text] of edits) {
        parts.push(xml.slice(at, s), text);
        at = e;
      }
      parts.push(xml.slice(at));
      bytes = XML_ENCODER.encode(parts.join(''));
    }
    // Images are already compressed; deflating them again only costs time.
    files[path] = /\.(png|jpe?g)$/i.test(path) ? [bytes, { level: 0 }] : bytes;
  }
  return { bytes: zipSync(files, { level: 6 }), paintLost };
}
