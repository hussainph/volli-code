// oxlint-disable no-underscore-dangle -- Vite `define` constants use the
// double-underscore convention so plain identifiers are never rewritten.
/**
 * The release this runner was built from: the root manifest's version,
 * injected by `define` in vite.config.ts for both the bundle and the tests.
 */
declare const __VOLLI_RUNNER_VERSION__: string;

export const RUNNER_VERSION: string = __VOLLI_RUNNER_VERSION__;
