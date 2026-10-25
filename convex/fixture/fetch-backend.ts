#!/usr/bin/env node
/** Download and verify the pinned backend for this platform into the cache; print its path. */

import { assertConvexNpmPinned, ensureBackendBinary } from "./backend.ts";

assertConvexNpmPinned();
const binary = await ensureBackendBinary({
  log: (line) => console.error(`[convex-fixture] ${line}`),
});
console.log(binary);
