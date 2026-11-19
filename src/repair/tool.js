// The repair bay: drop zone, live log, before/after readout, download and 3D view.
import { preloadViewer, createViewer, problemPly, problemCounts, PROBLEM_COLOURS } from './viewer.js';

const MAX_BYTES = 150 * 1024 * 1024;
const TIMEOUT_MS = 4 * 60 * 1000;

// Rows of the readout: analysis key, label, explanation.
const CHECKS = [
  ['NakedEdges', 'Open edges', 'Edges used by only one triangle: the surface has a hole there.'],
  ['NonManifoldEdges', 'Non-manifold edges', 'Edges shared by three or more triangles, usually an inside wall or touching parts.'],
  ['InvertedNormals', 'Flipped faces', 'Triangles facing the wrong way, so inside and outside get mixed up.'],
  ['OrientationConflicts', 'Winding conflicts', 'Edges where the surface twists so that no way of turning the faces makes both sides agree.'],
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
  const picker = $('#picker');
  const pickList = $('#picker-list');
  const pickGo = $('#picker-go');
  // The 3D view sits beside the bay (in the hero's left column), not inside it.
  const viewerBox = document.getElementById('viewer');
  const canvas = document.getElementById('f3d-canvas');
  const viewerStatus = document.getElementById('viewer-status');
  const modelButtons = [...viewerBox.querySelectorAll('[data-model]')];
  let worker = null;
  let timer = null;
  let downloadUrl = null;
  let progress = 0;

  // The 3D view: created once, then fed the original or repaired file on demand.
  let viewer = null;
  let models = { before: null, after: null }; // () => Promise<ArrayBuffer>
  let shown = null;
  // The original mesh with a problem flag per face, from the worker: the "before"
  // view is drawn from this so problem faces can be coloured.
  let problems = null;
  let seeInside = false;
  const seeButton = document.getElementById('see-inside');
  const legend = document.getElementById('viewer-legend');

  const rgb = (c) => `rgb(${c.join(',')})`;
  function updateLegend(which) {
    if (which !== 'before' || !problems) { legend.hidden = true; return; }
    const { open, wall, flipped } = problems.counts;
    const items = [
      [open, PROBLEM_COLOURS.open, 'at an open edge'],
      [wall, PROBLEM_COLOURS.wall, 'at a non-manifold edge or duplicate'],
      [flipped, PROBLEM_COLOURS.flipped, 'flipped'],
    ].filter(([n]) => n > 0);
    legend.innerHTML = items.length
      ? items.map(([n, c, label]) => `<li><i style="--c:${rgb(c)}"></i>${label} <span class="dim">${fmt(n)} triangles</span></li>`).join('')
      : `<li><i style="--c:${rgb(PROBLEM_COLOURS.ok)}"></i>no problem triangles</li>`;
    legend.hidden = false;
  }

  function useFallbackPictures(reason) {
    viewerBox.hidden = true;
    views.hidden = false;
    if (reason) console.warn('3D view unavailable, showing pictures instead:', reason);
  }

  async function showModel(which, keepCamera = false) {
    if (!models[which]) return;
    modelButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.model === which)));
    shown = which;
    viewerStatus.hidden = false;
    viewerStatus.textContent = viewer ? 'loading model…' : 'loading 3D viewer…';
    try {
      viewer = viewer || await createViewer(canvas);
      // "Before" with problems coloured, when the worker sent them; else the file as it is.
      const coloured = which === 'before' && problems;
      const bytes = coloured ? problemPly(problems, seeInside) : await models[which]();
      if (shown !== which) return; // the other button was pressed meanwhile
      viewer.show(bytes, { format: coloured ? 'ply' : 'stl', seeThrough: seeInside, keepCamera });
      updateLegend(which);
      viewerStatus.hidden = true;
    } catch (err) {
      useFallbackPictures(err);
    }
  }

  modelButtons.forEach((b) => b.addEventListener('click', () => showModel(b.dataset.model)));
  // Camera buttons over the 3D view.
  viewerBox.querySelector('.view-controls').addEventListener('click', (e) => {
    const action = e.target.closest('[data-cam]')?.dataset.cam;
    if (!action || !viewer) return;
    if (action === 'zoom-in') viewer.zoom(1.25);
    else if (action === 'zoom-out') viewer.zoom(0.8);
    else if (action === 'fit') viewer.fitView();
    else viewer.look(action);
  });
  seeButton.addEventListener('click', () => {
    seeInside = !seeInside;
    seeButton.setAttribute('aria-pressed', String(seeInside));
    if (shown) showModel(shown, true);
  });

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
    meter.hidden = readout.hidden = done.hidden = views.hidden = viewerBox.hidden = true;
    models = { before: null, after: null };
    problems = null;
    hidePicker();
    bar.style.width = '0';
    progress = 0;
  }

  function stop() {
    if (worker) worker.terminate();
    worker = null;
    clearTimeout(timer);
    hidePicker();
  }

  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail('it took longer than 4 minutes, so it was stopped'), TIMEOUT_MS);
  };

  // Object picker for 3MF files with several objects.
  function hidePicker() {
    picker.hidden = true;
    pickList.innerHTML = '';
  }
  const pickKeys = () => [...pickList.querySelectorAll('input:checked')].map((i) => i.value);
  const syncPick = () => { pickGo.disabled = !pickKeys().length; };
  function showPicker(objects) {
    clearTimeout(timer); // the user may take a while: no timeout while we wait
    pickList.innerHTML = objects.map((o, i) =>
      `<li><input type="checkbox" id="pick-${i}" value="${esc(o.key)}"${o.problems > 0 ? ' checked' : ''}>` +
      `<label for="pick-${i}"><span class="pname">${esc(o.name)}</span>` +
      `<span class="pmeta">${fmt(o.triangles)} triangles · ${o.problems > 0 ? `<span class="bad">${fmt(o.problems)} problem${o.problems === 1 ? '' : 's'}</span>` : '<span class="ok">no problems</span>'}</span></label></li>`).join('');
    syncPick();
    picker.hidden = false;
    pickList.querySelector('input')?.focus();
  }
  pickList.addEventListener('change', syncPick);
  picker.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
    pickList.querySelectorAll('input').forEach((i) => { i.checked = b.dataset.pick === 'all'; });
    syncPick();
  }));
  pickGo.addEventListener('click', () => {
    const keys = pickKeys();
    if (!keys.length || !worker) return;
    const names = [...pickList.querySelectorAll('input:checked + label .pname')].map((n) => esc(n.textContent));
    const total = pickList.children.length;
    hidePicker();
    line(`repairing ${keys.length} of ${total} objects${keys.length <= 3 ? ` <span class="dim">· ${names.join(', ')}</span>` : ''}`);
    armTimer();
    worker.postMessage({ type: 'choose', keys });
  });

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
    if (!/\.(stl|3mf)$/i.test(file.name)) return void line('<span class="bad">that isn\'t an .stl or .3mf file</span>');
    if (file.size > MAX_BYTES) return void line('<span class="bad">files up to 150 MB only:</span> reduce the mesh first');
    line(`<span class="n">${esc(file.name)}</span> <span class="dim">· ${(file.size / 1048576).toFixed(1)} MB</span>`);
    // For 3MF the 3D views come from STL bytes the worker sends with `done`.
    models.before = () => file.arrayBuffer();
    // Fetch the 3D viewer while the repair runs, so it's ready when the result is.
    preloadViewer(canvas).catch(() => {});

    file.arrayBuffer().then((buffer) => {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      armTimer();
      worker.onerror = () => fail('the repair stopped unexpectedly');
      worker.onmessage = (e) => onMessage(e.data, file.name);
      worker.postMessage({ buffer, name: file.name }, [buffer]);
    }, () => fail('the file could not be read'));
  }

  let repairLine = null;
  function onMessage(d, name) {
    if (d.type === 'error') return fail(d.message);

    if (d.type === 'objects') {
      line(`${d.objects.length} objects in this file · pick the ones to repair`);
      showPicker(d.objects);
    }
    if (d.type === 'stage' && d.stage === 'scan') line('scanning…');
    if (d.type === 'analysis') {
      const a = d.analysis;
      const total = CHECKS.reduce((s, [k]) => s + a[k], 0);
      line(`scan: ${fmt(a.FaceCount)} triangles · ${total ? `<span class="bad">${fmt(total)}</span> problems` : '<span class="ok">no problems found</span>'}`);
      if (d.format === '3mf' && d.unit && d.unit !== 'millimeter') line(`units: ${esc(d.unit)}`, 'dim');
      showReadout(a, null);
      drawPreview($('#preview'), d.before, d.holes);
      if (d.problems) problems = { ...d.problems, counts: problemCounts(d.problems.flags) };
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
      const clean = a.NakedEdges === 0 && a.NonManifoldEdges === 0 && a.InvertedNormals === 0 && !a.OrientationConflicts;
      const dv = d.volumeBefore > 0 ? Math.abs(d.volumeAfter - d.volumeBefore) / d.volumeBefore : 0;
      line(clean
        ? `<span class="ok">watertight</span> · ${fmt(a.FaceCount)} triangles · ${(d.timeFix / 1000).toFixed(1)} s`
        : `<span class="bad">partly repaired</span> · some problems could not be fixed safely`);
      showReadout(d.before, a);

      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      const is3mf = d.format === '3mf';
      const fixedBlob = new Blob([d.stl], { type: is3mf ? 'model/3mf' : 'model/stl' });
      downloadUrl = URL.createObjectURL(fixedBlob);
      if (is3mf) {
        // The download is a 3MF; the viewer wants STL bytes of the assembled model.
        models.before = () => Promise.resolve(d.beforeStl);
        models.after = () => Promise.resolve(d.afterStl);
      } else models.after = () => fixedBlob.arrayBuffer();
      const outName = name.replace(/\.(stl|3mf)$/i, '') + (is3mf ? '_fixed.3mf' : '_fixed.stl');
      download.href = downloadUrl;
      download.download = outName;
      download.textContent = 'Download ' + outName;
      $('#done-note').textContent = (dv < 1e-4 ? 'volume unchanged' : `volume changed ${(dv * 100).toFixed(2)}%`) +
        (d.paintLost > 0 ? ` · paint removed from ${fmt(d.paintLost)} repaired triangles` : '');
      done.hidden = false;
      drawPreview($('#preview2'), d.afterTris, null);
      if (typeof WebAssembly === 'object' && document.createElement('canvas').getContext('webgl2')) {
        viewerBox.hidden = false;
        showModel('after');
      } else {
        useFallbackPictures('no WebAssembly or WebGL 2');
      }
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

  // For files that arrive another way (opened from the desktop or shared to the app).
  return { open: start };
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
