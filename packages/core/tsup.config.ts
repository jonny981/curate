import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    internal: 'src/internal.ts',
    'local-embeddings': 'src/local-embeddings.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  dts: false,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
