// Runs the real migration export worker entry under plain Node in a test: the
// resolve hooks let extensionless imports find host-core's `.ts` sources the
// way the bundler does, and the worker's `--experimental-transform-types`
// strips the types. Test support only.
await import("../../secrets/test-support/ts-hooks.mjs");
await import("../worker-entry.ts");
