// Runs the repair off the main thread: read, scan, repair, then scan the result again.
// The pipeline itself lives in pipeline.js (shared with the HTTP server); this file only
// turns its hooks into messages and builds the extra data the 3D views want.
import { writeStl, toTriangles, nakedSegments, problemFaces } from './mesh.js';
import { is3mf, repairStl, open3mf, repair3mf, StlError, ThreeMfError } from './pipeline.js';

// Draw every triangle up to this many; bigger meshes are sampled for the pictures.
const PREVIEW_TRIS = 1000000;

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

// The "before" scan for the 3D view: counts, picture, hole outlines and a problem flag per face.
function scanMessage(send, { mesh, analysis, ...extra }) {
  const beforeTris = toTriangles(mesh, PREVIEW_TRIS);
  const holes = nakedSegments(mesh);
  // The welded mesh plus a problem flag per face, for the coloured 3D "before" view.
  const problems = {
    verts: Float32Array.from(mesh.verts),
    faces: mesh.faces.slice(),
    flags: problemFaces(mesh),
  };
  send(
    { type: 'analysis', analysis, before: beforeTris, holes, problems, ...extra },
    [beforeTris.buffer, holes.buffer, problems.verts.buffer, problems.faces.buffer, problems.flags.buffer],
  );
}

async function run3mf(buffer, send) {
  send({ type: 'stage', stage: 'read' });
  const opened = open3mf(buffer);

  let chosen = opened.objs.map((o) => o.key);
  if (opened.objs.length > 1) {
    send({ type: 'objects', groups: opened.groups, objects: opened.objects });
    const msg = await waitFor('choose');
    chosen = msg.keys || [];
  }

  let beforeStl;
  const r = repair3mf(opened, chosen, {
    onStage: (stage) => send({ type: 'stage', stage }),
    onProgress: (progress) => send({ type: 'progress', progress }),
    onScan: (scan) => {
      scanMessage(send, scan);
      beforeStl = writeStl(scan.mesh, 'hullpatch before');
    },
  });
  const stl = r.bytes.buffer.byteLength === r.bytes.byteLength ? r.bytes.buffer : r.bytes.slice().buffer;
  const afterStl = writeStl(r.afterMesh, 'hullpatch after');
  const afterTris = toTriangles(r.afterMesh, PREVIEW_TRIS);

  send(
    { type: 'done', timeFix: r.timeFix, before: r.before, after: r.after, volumeBefore: r.volumeBefore, volumeAfter: r.volumeAfter, stl, afterTris, format: '3mf', paintLost: r.paintLost, afterStl, beforeStl },
    [stl, afterTris.buffer, afterStl, beforeStl],
  );
}

function runStl(buffer, name, send) {
  const r = repairStl(buffer, {
    name,
    onStage: (stage) => send({ type: 'stage', stage }),
    onProgress: (progress) => send({ type: 'progress', progress }),
    onScan: (scan) => scanMessage(send, scan),
  });
  const afterTris = toTriangles(r.fixed, PREVIEW_TRIS);
  send(
    { type: 'done', timeFix: r.timeFix, before: r.before, after: r.after, volumeBefore: r.volumeBefore, volumeAfter: r.volumeAfter, stl: r.stl, afterTris, format: 'stl' },
    [r.stl, afterTris.buffer],
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
