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

/**
 * Create the viewer on `canvas`. Returns { show(bytes), dispose() }.
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
  options.setAsString('model.color.rgb', '#7fd6ff');
  options.setAsString('scene.up_direction', '+Z'); // STL files are Z-up

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
  return {
    /** Replace the model with an STL (or any F3D-readable file) given as bytes. */
    show(bytes) {
      const scene = engine.getScene();
      scene.clear();
      scene.addBuffer(new Uint8Array(bytes));
      // Same three-quarter view as the preview pictures.
      const camera = win.getCamera();
      const f = camera.focalPoint;
      camera.position = [f[0] + 1, f[1] - 1, f[2] + 0.6];
      camera.viewUp = [0, 0, 1];
      camera.resetToBounds(0.9);
      fit();
      if (!started) {
        engine.getInteractor().start();
        started = true;
      }
    },
    dispose() {
      observer.disconnect();
    },
  };
}
