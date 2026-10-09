import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.js'

// Serves the /api routes from the Vite dev server, so `npm run dev` is all you need.
const api = {
  name: 'album-finder-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
  },
  configurePreviewServer(server) {
    server.middlewares.use(apiMiddleware)
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    api,
  ],
  // UI tests (Vitest). Server tests use Node's own runner: see test/ and `npm run test:server`.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    restoreMocks: true,
  },
})
