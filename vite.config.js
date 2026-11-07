import { defineConfig } from 'vite';

// Hullpatch is a single static page; the repair runs in a module worker.
export default defineConfig({
  base: '/',
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true },
});
