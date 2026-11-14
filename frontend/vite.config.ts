import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two pages: the viewer (index.html) and the 3D map (explore.html, served at /explore).
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  plugins: [
    {
      name: 'explore-rewrite',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url && /^\/explore\/?(\?.*)?$/.test(req.url)) {
            req.url = req.url.replace(/^\/explore\/?/, '/explore.html');
          }
          next();
        });
      },
    },
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        explore: resolve(__dirname, 'explore.html'),
      },
    },
  },
});
