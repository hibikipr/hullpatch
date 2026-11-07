// Runs the repair off the main thread: read, scan, repair, then scan the result again.
import { parseStl, weld, analyze, repair, writeStl, toTriangles, nakedSegments, meshVolume, StlError } from './mesh.js';

// Draw every triangle up to this many; bigger meshes are sampled for the pictures.
const PREVIEW_TRIS = 1000000;

self.onmessage = (e) => {
  const { buffer, name } = e.data;
  const send = (msg, transfer) => self.postMessage(msg, transfer || []);
  try {
    send({ type: 'stage', stage: 'read' });
    const mesh = weld(parseStl(buffer));

    send({ type: 'stage', stage: 'scan' });
    const before = analyze(mesh);
    const volumeBefore = Math.abs(meshVolume(mesh));
    const beforeTris = toTriangles(mesh, PREVIEW_TRIS);
    const holes = nakedSegments(mesh);
    send({ type: 'analysis', analysis: before, before: beforeTris, holes }, [beforeTris.buffer, holes.buffer]);

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
      { type: 'done', timeFix, before, after, volumeBefore, volumeAfter, stl, afterTris },
      [stl, afterTris.buffer],
    );
  } catch (err) {
    send({
      type: 'error',
      message: err instanceof StlError ? err.message : 'an unexpected error occurred (' + (err && err.message) + ')',
    });
  }
};
