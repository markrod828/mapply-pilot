import { defineConfig } from 'vite';

// MV3 content scripts cannot be ES modules, so they are bundled separately as a
// single IIFE that dispatches on hostname at runtime.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: 'src/content/index.ts',
      name: 'ApplyPilotContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
