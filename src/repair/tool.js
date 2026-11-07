// The repair bay: drop zone, live log, before/after readout, download and preview pictures.

const MAX_BYTES = 150 * 1024 * 1024;
const TIMEOUT_MS = 4 * 60 * 1000;

// Rows of the readout: analysis key, label, explanation.
const CHECKS = [
  ['NakedEdges', 'Open edges', 'Edges used by only one triangle: the surface has a hole there.'],
  ['NonManifoldEdges', 'Non-manifold edges', 'Edges shared by three or more triangles, usually an inside wall or touching parts.'],
  ['InvertedNormals', 'Flipped faces', 'Triangles facing the wrong way, so inside and outside get mixed up.'],
  ['DuplicateFaces', 'Duplicate faces', 'Triangles that use exactly the same corners as another one.'],
  ['DegenerateFaces', 'Degenerate faces', 'Triangles with no area.'],
];

const fmt = (n) => Number(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initRepairTool(root) {
  const $ = (sel) => root.querySelector(sel);
  const input = $('#stl-input');
  const drop = $('#drop');
  const log = $('#log');
  const meter = $('#meter');
  const bar = meter.querySelector('i');
  const readout = $('#readout');
  const done = $('#done');
  const download = $('#downloadbtn');
  const views = $('#views');
  let worker = null;
  let timer = null;
  let downloadUrl = null;
  let progress = 0;

  const line = (html, cls = '') => {
    log.querySelectorAll('.cursor').forEach((el) => el.classList.remove('cursor'));
    const p = document.createElement('p');
    p.className = (cls + ' cursor').trim();
    p.innerHTML = html;
    log.append(p);
    return p;
  };

  function reset() {
    log.innerHTML = '';
    meter.hidden = readout.hidden = done.hidden = views.hidden = true;
    bar.style.width = '0';
    progress = 0;
  }

  function stop() {
    if (worker) worker.terminate();
    worker = null;
    clearTimeout(timer);
  }

  function fail(message) {
    stop();
    meter.hidden = true;
    line('<span class="bad">could not repair this file:</span> ' + esc(message));
  }

  const count = (v) => `<span class="${v > 0 ? 'bad' : 'ok'}">${fmt(v)}</span>`;
  const parts = (a) => a.DisjointShells || 1;

  function showReadout(before, after) {
    const rows = CHECKS.map(([key, label, tip]) =>
      `<tr><td><abbr title="${esc(tip)}">${label}</abbr></td><td class="num">${count(before[key])}</td><td class="num">${after ? count(after[key]) : '…'}</td></tr>`);
    rows.push(`<tr><td><abbr title="Separate solid pieces in the file.">Parts</abbr></td><td class="num">${fmt(parts(before))}</td><td class="num">${after ? fmt(parts(after)) : '…'}</td></tr>`);
    rows.push(`<tr><td>Triangles</td><td class="num">${fmt(before.FaceCount)}</td><td class="num">${after ? fmt(after.FaceCount) : '…'}</td></tr>`);
    readout.querySelector('tbody').innerHTML = rows.join('');
    readout.hidden = false;
  }

  function start(file) {
    if (!file) return;
    stop();
    reset();
    if (!/\.stl$/i.test(file.name)) return void line('<span class="bad">that isn\'t an .stl file</span>');
    if (file.size > MAX_BYTES) return void line('<span class="bad">files up to 150 MB only:</span> reduce the mesh first');
    line(`<span class="n">${esc(file.name)}</span> <span class="dim">· ${(file.size / 1048576).toFixed(1)} MB</span>`);

    file.arrayBuffer().then((buffer) => {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      timer = setTimeout(() => fail('it took longer than 4 minutes, so it was stopped'), TIMEOUT_MS);
      worker.onerror = () => fail('the repair stopped unexpectedly');
      worker.onmessage = (e) => onMessage(e.data, file.name);
      worker.postMessage({ buffer, name: file.name }, [buffer]);
    }, () => fail('the file could not be read'));
  }

  let repairLine = null;
  function onMessage(d, name) {
    if (d.type === 'error') return fail(d.message);

    if (d.type === 'stage' && d.stage === 'scan') line('scanning…');
    if (d.type === 'analysis') {
      const a = d.analysis;
      const problems = CHECKS.reduce((s, [k]) => s + a[k], 0);
      line(`scan: ${fmt(a.FaceCount)} triangles · ${problems ? `<span class="bad">${fmt(problems)}</span> problems` : '<span class="ok">no problems found</span>'}`);
      showReadout(a, null);
      drawPreview($('#preview'), d.before, d.holes);
    }
    if (d.type === 'stage' && d.stage === 'repair') {
      repairLine = line('patching: 0%');
      meter.hidden = false;
    }
    if (d.type === 'progress' && d.progress > progress) {
      progress = d.progress;
      bar.style.width = (100 * progress).toFixed(1) + '%';
      if (repairLine) repairLine.textContent = 'patching: ' + Math.round(100 * progress) + '%';
    }
    if (d.type === 'stage' && d.stage === 'verify') line('checking the result…');

    if (d.type === 'done') {
      stop();
      bar.style.width = '100%';
      const a = d.after;
      const clean = a.NakedEdges === 0 && a.NonManifoldEdges === 0 && a.InvertedNormals === 0;
      const dv = d.volumeBefore > 0 ? Math.abs(d.volumeAfter - d.volumeBefore) / d.volumeBefore : 0;
      line(clean
        ? `<span class="ok">watertight</span> · ${fmt(a.FaceCount)} triangles · ${(d.timeFix / 1000).toFixed(1)} s`
        : `<span class="bad">partly repaired</span> · some problems could not be fixed safely`);
      showReadout(d.before, a);

      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([d.stl], { type: 'model/stl' }));
      const outName = name.replace(/\.stl$/i, '') + '_fixed.stl';
      download.href = downloadUrl;
      download.download = outName;
      download.textContent = 'Download ' + outName;
      $('#done-note').textContent = dv < 1e-4 ? 'volume unchanged' : `volume changed ${(dv * 100).toFixed(2)}%`;
      done.hidden = false;
      drawPreview($('#preview2'), d.afterTris, null);
      views.hidden = false;
    }
  }

  input.addEventListener('change', () => {
    start(input.files[0]);
    input.value = '';
  });

  // Dropping a file anywhere on the bay works too.
  root.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) drop.classList.remove('dragging'); });
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    start(e.dataTransfer.files[0]);
  });
}

/* ------------------------------------------------------------------ */
/* Preview pictures: flat-shaded view from a fixed angle               */
/* ------------------------------------------------------------------ */


function drawPreview(img, tris, holes) {
  const W = 800, H = 600;
  const n = tris.length / 9;
  if (n === 0) return;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0f22';
  ctx.fillRect(0, 0, W, H);

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let d = 0; d < 3; d++) {
    if (tris[i + d] < min[d]) min[d] = tris[i + d];
    if (tris[i + d] > max[d]) max[d] = tris[i + d];
  }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  // view: turn around the vertical (z) axis, then tilt down
  const az = -0.6, el = 0.55;
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  const project = (x, y, z) => {
    x -= c[0]; y -= c[1]; z -= c[2];
    const rx = x * ca - y * sa, ry = x * sa + y * ca;
    return [rx, z * ce - ry * se, ry * ce + z * se]; // screen x, screen y (up), depth (smaller = nearer)
  };
  const sx = new Float32Array(n * 3), sy = new Float32Array(n * 3), depth = new Float32Array(n);
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (let t = 0; t < n; t++) {
    let dz = 0;
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const p = project(tris[o], tris[o + 1], tris[o + 2]);
      sx[t * 3 + k] = p[0]; sy[t * 3 + k] = p[1]; dz += p[2];
      if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0];
      if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1];
    }
    depth[t] = dz;
  }
  const scale = 0.85 * Math.min(W / (bx1 - bx0 || 1), H / (by1 - by0 || 1));
  const ox = W / 2 - ((bx0 + bx1) / 2) * scale, oy = H / 2 + ((by0 + by1) / 2) * scale;
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => depth[b] - depth[a]);

  const light = [0.3, 0.5, -0.8];
  const ll = Math.hypot(...light);
  for (const t of order) {
    const o = t * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const rx = (nx * ca - ny * sa) / nl, ry = (nx * sa + ny * ca) / nl, rz = nz / nl;
    const vnx = rx, vny = rz * ce - ry * se, vnz = ry * ce + rz * se;
    const front = vnz < 0; // facing the viewer
    // Depth-sorting by centre can paint hidden back faces over front ones, so they are
    // never drawn; real problems are marked by the red open-edge lines instead.
    if (!front) continue;
    const s = 0.35 + 0.65 * Math.abs(vnx * light[0] + vny * light[1] + vnz * light[2]) / ll;
    // faces seen from behind (inside-out or seen through a hole) are drawn red
    ctx.fillStyle = front
      ? `rgb(${Math.round(60 * s + 20)},${Math.round(170 * s + 25)},${Math.round(225 * s + 30)})`
      : `rgb(${Math.round(255 * s)},${Math.round(77 * s)},${Math.round(94 * s)})`;
    ctx.beginPath();
    ctx.moveTo(ox + sx[t * 3] * scale, oy - sy[t * 3] * scale);
    ctx.lineTo(ox + sx[t * 3 + 1] * scale, oy - sy[t * 3 + 1] * scale);
    ctx.lineTo(ox + sx[t * 3 + 2] * scale, oy - sy[t * 3 + 2] * scale);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  if (holes && holes.length) {
    ctx.strokeStyle = '#ff4d5e';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < holes.length; i += 6) {
      const a = project(holes[i], holes[i + 1], holes[i + 2]);
      const b = project(holes[i + 3], holes[i + 4], holes[i + 5]);
      ctx.moveTo(ox + a[0] * scale, oy - a[1] * scale);
      ctx.lineTo(ox + b[0] * scale, oy - b[1] * scale);
    }
    ctx.stroke();
  }
  img.src = canvas.toDataURL('image/png');
  img.style.display = '';
}
