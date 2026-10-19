import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import compressionDictionary from 'use-as-dictionary/vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    vue(),
    compressionDictionary({
      test: /^dist\/styles\.[A-Za-z0-9_-]+\.css$/,
      dictionarySource: '.dictionary-cache/styles.dat',
      autoUpdate: { minSavings: 0.9 },
    }),
  ],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'dist/app.[hash].js',
        chunkFileNames: 'dist/app.[hash].js',
        assetFileNames: (asset) => asset.names.some((name) => name.endsWith('.css'))
          ? 'dist/styles.[hash][extname]'
          : 'dist/[name].[hash][extname]',
      },
    },
  },
});
