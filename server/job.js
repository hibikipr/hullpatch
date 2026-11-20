// A worker thread: runs one repair or analysis at a time through the shared pipeline.
import { parentPort, workerData } from 'node:worker_threads';
import { writeStl } from '../src/repair/mesh.js';
import { repairStl, analyzeStl, open3mf, analyze3mf, repair3mf, StlError, ThreeMfError } from '../src/repair/pipeline.js';

// Test hook only: make every job take at least this long.
const delay = Number(workerData && workerData.jobDelayMs) || 0;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A Buffer/Uint8Array view as an ArrayBuffer that can be transferred without a copy.
const exact = (u8) => (u8.byteOffset === 0 && u8.buffer.byteLength === u8.byteLength ? u8.buffer : Uint8Array.prototype.slice.call(u8).buffer);

function work({ op, format, buffer, name, parts, outFormat }) {
  if (delay) sleep(delay);
  if (op === 'analyze') {
    if (format === '3mf') return { format, ...analyze3mf(open3mf(buffer)) };
    return { format, ...analyzeStl(buffer) };
  }
  if (format === 'stl') {
    const r = repairStl(buffer, { name });
    return { format, outFormat: 'stl', before: r.before, after: r.after, volumeBefore: r.volumeBefore, volumeAfter: r.volumeAfter, watertight: r.watertight, file: r.stl };
  }
  const opened = open3mf(buffer);
  const keys = (parts === 'all' ? opened.objects : opened.objects.filter((o) => o.problems > 0)).map((o) => o.key);
  const r = repair3mf(opened, keys);
  const file = outFormat === 'stl' ? writeStl(r.afterMesh, ('hullpatch: ' + name).slice(0, 80)) : exact(r.bytes);
  return { format, outFormat: outFormat === 'stl' ? 'stl' : '3mf', before: r.before, after: r.after, volumeBefore: r.volumeBefore, volumeAfter: r.volumeAfter, watertight: r.watertight, paintLost: r.paintLost, file };
}

parentPort.on('message', (job) => {
  try {
    const out = work(job);
    parentPort.postMessage({ ok: true, ...out }, out.file ? [out.file] : []);
  } catch (err) {
    if (err instanceof StlError || err instanceof ThreeMfError) parentPort.postMessage({ ok: false, user: true, message: err.message });
    else parentPort.postMessage({ ok: false, user: false, message: String((err && err.stack) || err) });
  }
});
