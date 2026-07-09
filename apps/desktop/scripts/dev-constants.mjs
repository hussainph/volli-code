// Single source of truth for the renderer dev-server address (issue #4).
// Imported by BOTH vite.config.ts (`server.port`) and scripts/dev.mjs (the
// ELECTRON_RENDERER_URL handed to the pack watcher, which dev-electron.mjs
// probes before launching Electron), so the port cannot silently diverge.
// `strictPort` in the config guarantees Vite either owns this exact port or
// fails loudly.
export const RENDERER_DEV_PORT = 5173;
export const RENDERER_DEV_URL = `http://localhost:${RENDERER_DEV_PORT}`;
