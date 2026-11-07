// Interactive 3D view powered by F3D's WebAssembly build (the same viewer Manyfold uses).
// F3D is about 10 MB compressed, so it is only fetched once a repair starts, and the
// page falls back to the flat preview pictures if it can't run (no WebGL 2, old browser).

let modulePromise = null;

/** Start downloading and compiling F3D for this canvas. Safe to call more than once. */
export function preloadViewer(canvas) {
  if (!modulePromise) {
    modulePromise = import('f3d')
      .then(({ default: f3d }) => f3d({ canvas, print: () => {}, printErr: () => {} }))
      .catch((err) => {
        modulePromise = null; // let a later attempt try again
        throw err;
      });
  }
  return modulePromise;
}

// Problem flags per face, as set by problemFaces() in mesh.js (repeated here so the
// page doesn't pull the whole repair engine into its main script).
const OPEN = 1, WALL = 2, FLIPPED = 4;

// Colours for the "before" model (the site's palette). A face with several
// problems takes the first that applies: open edge, then inside wall, then flipped.
export const PROBLEM_COLOURS = {
  ok: [127, 214, 255], // same blue as the repaired model
  open: [255, 77, 94],
  wall: [255, 179, 71],
  flipped: [180, 140, 255],
};
const MODEL_RGB = '#7fd6ff';
// Opacity of healthy faces with "See inside" on. Low, because a detailed model stacks
// many layers of surface in front of anything hidden inside it.
const SEE_THROUGH = 0.06;
// The repaired model has no problem markers to show, so it stays more visible.
const SEE_THROUGH_REPAIRED = 0.25;

/** How many faces have each kind of problem (a face can count under several). */
export function problemCounts(flags) {
  let open = 0, wall = 0, flipped = 0;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f & OPEN) open++;
    if (f & WALL) wall++;
    if (f & FLIPPED) flipped++;
  }
  return { open, wall, flipped };
}

// Problem faces are often slivers far too small to see at full-model zoom, so each
// one smaller than this share of the model's size also gets a marker of that size.
const MARKER_SIZE = 0.008;
const MAX_MARKERS = 20000;

/**
 * The mesh plus a small octahedron (in the problem's colour) at every problem face
 * too small to see. Markers are only drawn in the viewer, never written to the STL.
 */
function withMarkers({ verts, faces, flags }) {
  const F = faces.length / 3;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    for (let a = 0; a < 3; a++) { const x = verts[i + a]; if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x; }
  }
  const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * MARKER_SIZE / 2;

  const centres = [], centreFlags = [];
  for (let f = 0; f < F && centres.length < MAX_MARKERS * 3; f++) {
    if (!flags[f]) continue;
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    let size = 0;
    for (let k = 0; k < 3; k++) {
      size = Math.max(size, Math.abs(verts[a + k] - verts[b + k]), Math.abs(verts[b + k] - verts[c + k]), Math.abs(verts[a + k] - verts[c + k]));
    }
    if (size >= r * 2) continue; // big enough to see on its own
    centres.push((verts[a] + verts[b] + verts[c]) / 3, (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3, (verts[a + 2] + verts[b + 2] + verts[c + 2]) / 3);
    centreFlags.push(flags[f]);
  }
  const M = centreFlags.length;
  if (!M) return { verts, faces, flags };

  const V0 = verts.length / 3;
  const outVerts = new Float32Array(verts.length + M * 18);
  outVerts.set(verts);
  const outFaces = new Uint32Array(faces.length + M * 24);
  outFaces.set(faces);
  const outFlags = new Uint8Array(F + M * 8);
  outFlags.set(flags);
  const tips = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]];
  // Octahedron faces, wound outward: +x/-x with each of the four y/z quarters.
  const oct = [[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5]];
  for (let m = 0; m < M; m++) {
    const base = V0 + m * 6;
    for (let t = 0; t < 6; t++) {
      for (let k = 0; k < 3; k++) outVerts[base * 3 + t * 3 + k] = centres[m * 3 + k] + tips[t][k];
    }
    for (let t = 0; t < 8; t++) {
      for (let k = 0; k < 3; k++) outFaces[faces.length + m * 24 + t * 3 + k] = base + oct[t][k];
      outFlags[F + m * 8 + t] = centreFlags[m];
    }
  }
  return { verts: outVerts, faces: outFaces, flags: outFlags };
}

/**
 * A binary PLY of the mesh with one colour per face: problem faces in their colour
 * and fully opaque, healthy faces blue (see-through when seeThrough is set, so walls
 * hidden inside the model show).
 */
export function problemPly(mesh, seeThrough) {
  const { verts, faces, flags } = withMarkers(mesh);
  const V = verts.length / 3, F = faces.length / 3;
  const header = new TextEncoder().encode(
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${V}\nproperty float x\nproperty float y\nproperty float z\n` +
    `element face ${F}\nproperty list uchar int vertex_indices\n` +
    'property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nend_header\n');
  const buf = new ArrayBuffer(header.length + V * 12 + F * 17);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes.set(header, 0);
  let o = header.length;
  for (let i = 0; i < verts.length; i++, o += 4) view.setFloat32(o, verts[i], true);

  const okAlpha = seeThrough ? Math.round(255 * SEE_THROUGH) : 255;
  for (let f = 0; f < F; f++) {
    bytes[o] = 3;
    view.setInt32(o + 1, faces[f * 3], true);
    view.setInt32(o + 5, faces[f * 3 + 1], true);
    view.setInt32(o + 9, faces[f * 3 + 2], true);
    const fl = flags[f];
    const c = fl & OPEN ? PROBLEM_COLOURS.open
      : fl & WALL ? PROBLEM_COLOURS.wall
      : fl & FLIPPED ? PROBLEM_COLOURS.flipped
      : PROBLEM_COLOURS.ok;
    bytes[o + 13] = c[0]; bytes[o + 14] = c[1]; bytes[o + 15] = c[2];
    bytes[o + 16] = fl ? 255 : okAlpha;
    o += 17;
  }
  return buf;
}

/**
 * Create the viewer on `canvas`. Returns { show(bytes, opts), dispose() }.
 * Drag to orbit, scroll to zoom, right-drag to pan (F3D's own controls).
 */
export async function createViewer(canvas) {
  const F3D = await preloadViewer(canvas);
  F3D.Engine.autoloadPlugins();
  const engine = F3D.Engine.create('#' + canvas.id);

  const options = engine.getOptions();
  // Townsville look: dark navy, saber-blue grid, soft shading.
  options.setAsString('render.background.color', '#0a0f22');
  options.setAsString('render.effect.ambient_occlusion', 'true');
  options.setAsString('render.effect.antialiasing.mode', 'fxaa');
  options.setAsString('render.effect.tone_mapping', 'true');
  options.setAsString('render.grid.enable', 'true');
  options.setAsString('render.grid.color', '#4cc9ff');
  options.setAsString('render.grid.subdivisions', '0');
  options.setAsString('render.grid.unit', '10');
  options.setAsString('model.color.rgb', MODEL_RGB);
  options.setAsString('scene.up_direction', '+Z'); // STL files are Z-up
  options.setAsString('model.scivis.field', 'cells');

  const win = engine.getWindow();
  const fit = () => {
    const scale = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * scale));
    const h = Math.max(1, Math.round(canvas.clientHeight * scale));
    win.setSize(w, h);
    win.render();
  };
  const observer = new ResizeObserver(fit);
  observer.observe(canvas);

  let started = false;
  let framed = false;
  return {
    /**
     * Replace the model. bytes: an STL, or a PLY from problemPly() with format 'ply'.
     * seeThrough makes an STL translucent (a PLY carries its own transparency).
     * keepCamera leaves the view where the user put it (used by the See inside toggle).
     */
    show(bytes, { format = 'stl', seeThrough = false, keepCamera = false } = {}) {
      const saved = keepCamera && framed ? win.getCamera().state : null;

      // A PLY from problemPly() carries a colour per face; an STL uses the model colour.
      options.setAsString('model.coloring', format === 'ply' ? 'direct' : 'material');
      options.setAsString('model.color.opacity', format === 'stl' && seeThrough ? String(SEE_THROUGH_REPAIRED) : '1');

      const scene = engine.getScene();
      scene.clear();
      if (format === 'ply') {
        // Written to F3D's in-memory file system so the reader is picked by extension.
        F3D.FS.writeFile('/before.ply', new Uint8Array(bytes));
        scene.add('/before.ply');
      } else {
        scene.addBuffer(new Uint8Array(bytes));
      }

      const camera = win.getCamera();
      if (saved) {
        // F3D frames a newly loaded scene on its first render; let it, then put the
        // user's view back (position, focal point, up and zoom angle).
        win.render();
        camera.state = saved;
      } else {
        frame('3d');
        framed = true;
      }
      fit();
      if (!started) {
        engine.getInteractor().start();
        started = true;
      }
    },
    /** Move the camera closer (step > 1) or further away (step < 1). */
    zoom(step) {
      win.getCamera().dolly(step);
      win.render();
    },
    /** Frame the whole model again, keeping the current viewing direction. */
    fitView() {
      win.getCamera().resetToBounds(0.9);
      win.render();
    },
    /** Look from a preset direction: '3d', 'top', 'front' or 'side'. */
    look(view) {
      frame(view);
      win.render();
    },
    dispose() {
      observer.disconnect();
    },
  };

  /** Point the camera at the model from a preset direction and fit it in view. */
  function frame(view) {
    const [dir, up] = VIEWS[view] || VIEWS['3d'];
    const camera = win.getCamera();
    const f = camera.focalPoint;
    camera.position = [f[0] + dir[0], f[1] + dir[1], f[2] + dir[2]];
    camera.viewUp = up;
    camera.resetToBounds(0.9);
  }
}

// Preset views for a Z-up model: [direction from the model to the camera, up].
// '3d' is the same three-quarter view as the preview pictures.
const VIEWS = {
  '3d': [[1, -1, 0.6], [0, 0, 1]],
  top: [[0, 0, 1], [0, 1, 0]],
  front: [[0, -1, 0], [0, 0, 1]],
  side: [[1, 0, 0], [0, 0, 1]],
};
