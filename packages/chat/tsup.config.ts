import { copyFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // The judgment set reads its weights from a data file beside the
  // bundle, so the file ships with the package, not inside it.
  onSuccess: () => copyFile('src/judgment-chat-weights.json', 'dist/judgment-chat-weights.json'),
});
