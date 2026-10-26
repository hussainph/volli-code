/** Replaced with public values (or null) by vite.config.ts, never read from runtime env. */
declare const VOLLI_PACKAGED_CLOUD_CONFIG: import("./deployment-config").PackagedCloudConfig | null;

declare namespace NodeJS {
  interface ProcessEnv {
    ELECTRON_RENDERER_URL?: string;
  }
}
