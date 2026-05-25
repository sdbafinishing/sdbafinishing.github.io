import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    // Lock to port 3000 — Google OAuth requires every dev origin to be
    // pre-registered, and zombie Vite instances bumping the port each
    // session (3001, 3002, …) means the operator can't authorise the
    // Drive API. strictPort makes Vite FAIL when 3000 is busy so the
    // operator notices and kills the stale process instead of silently
    // landing on a port Drive doesn't know about.
    strictPort: true,
    open: true,
  },
});
