// oxlint-disable no-underscore-dangle -- Vite `define` constants use the
// double-underscore convention so plain identifiers are never rewritten.
/**
 * The release this host was built from: the root manifest's version, injected
 * by `define` in vite.config.ts for both the bundle and the tests. It is the
 * `appVersion` the agent socket reports, as desktop reports its own.
 */
declare const __VOLLI_HOSTD_VERSION__: string;

export const HOSTD_VERSION: string = __VOLLI_HOSTD_VERSION__;
