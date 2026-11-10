import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Browser bundles get only the formatting helpers from the shared package (see src/lib/shared-runtime.ts).
    alias: [{ find: /^@securesend\/shared$/, replacement: fileURLToPath(new URL('./src/lib/shared-runtime.ts', import.meta.url)) }],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/healthz': 'http://localhost:3000',
      '/readyz': 'http://localhost:3000',
    },
  },
  build: {
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        // Keep React in one long-lived vendor chunk shared by the recipient page and the staff app.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});
