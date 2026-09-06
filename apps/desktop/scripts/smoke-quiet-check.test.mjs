import assert from "node:assert/strict";
import test from "node:test";

import { quietSmokeVerdict } from "./smoke-quiet-check-logic.mjs";

test("quietSmokeVerdict refuses to pass without a native observation", () => {
  assert.deepEqual(
    quietSmokeVerdict({
      samples: 0,
      frontmostSamples: 0,
      regularPolicySamples: 0,
      firstFrontmost: null,
      cursor: { start: [0, 0], end: [0, 0], maxDistanceFromStart: 0 },
    }),
    { ok: false, failures: ["native sampler produced no observations"] },
  );
});

test("quietSmokeVerdict names every native-input invariant a run violated", () => {
  assert.deepEqual(
    quietSmokeVerdict(
      {
        samples: 20,
        frontmostSamples: 2,
        regularPolicySamples: 4,
        firstFrontmost: "Electron (4242)",
        firstRegular: "Electron (4242) — /Applications/Electron.app/Contents/MacOS/Electron",
        cursor: {
          start: [100, 200],
          end: [108, 209],
          maxDistanceFromStart: 12,
        },
      },
      { assertStationaryCursor: true },
    ),
    {
      ok: false,
      failures: [
        "smoke app was frontmost in 2/20 samples (first: Electron (4242))",
        "smoke app had regular/Dock activation policy in 4/20 samples " +
          "(first: Electron (4242) — /Applications/Electron.app/Contents/MacOS/Electron)",
        "host cursor moved 12.0px from its starting position",
      ],
    },
  );
});
