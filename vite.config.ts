import {defineConfig} from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // O SPA fala com o executor de comandos em /api (npm run api).
      '/api': 'http://127.0.0.1:5178',
    },
  },
});