// The renderer-facing `window.api` type is derived from the preload
// implementation (`export type Api = typeof api` in index.ts) rather than
// hand-mirrored here, so the bridge and its declared type can never drift.
import type { Api } from "./index";

declare global {
  interface Window {
    api: Api;
  }
}
