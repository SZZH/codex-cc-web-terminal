import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { brotliCompress, constants, gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const webRoot = path.dirname(fileURLToPath(import.meta.url));

export function precompressedAssets() {
  return {
    name: 'precompressed-assets',
    apply: 'build',
    async writeBundle(options, bundle) {
      if (!options.dir) return;
      await Promise.all(Object.values(bundle).map(async ({ fileName }) => {
        if (!/^assets\/.+\.(?:js|css)$/.test(fileName)) return;
        const filePath = path.join(options.dir, fileName);
        const source = await readFile(filePath);
        if (source.length < 1024) return;
        const encodings = await Promise.all([
          gzipAsync(source, { level: 9 }),
          brotliAsync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
        ]);
        await Promise.all(encodings.map(async (encoded, index) => {
          if (encoded.length >= source.length) return;
          const sidePath = `${filePath}${index === 0 ? '.gz' : '.br'}`;
          const temporaryPath = `${sidePath}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporaryPath, encoded);
            await rename(temporaryPath, sidePath);
          } finally {
            await rm(temporaryPath, { force: true });
          }
        }));
      }));
    }
  };
}

export default defineConfig({
  plugins: [vue(), precompressedAssets()],
  root: webRoot,
  build: {
    outDir: path.join(webRoot, 'dist'),
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3210",
        changeOrigin: true
      },
      "/ws": {
        target: "ws://127.0.0.1:3210",
        ws: true
      }
    }
  }
});
