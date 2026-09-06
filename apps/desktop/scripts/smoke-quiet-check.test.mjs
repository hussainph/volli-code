import assert from "node:assert/strict";
import test from "node:test";

import { quietSmokeVerdict } from "./smoke-quiet-check-logic.mjs";

function quietReport(overrides = {}) {
  return {
    samples: 20,
    smokeAppSamples: 18,
    smokeAppCount: 2,
    frontmostSamples: 0,
    activeSamples: 0,
    regularPolicySamples: 0,
    hostKeyInputSamples: 0,
    hostClickInputSamples: 0,
    firstFrontmost: null,
    firstActive: null,
    firstRegular: null,
    cursor: { start: [100, 200], end: [100, 200], maxDistanceFromStart: 0 },
    ...overrides,
  };
}

test("quietSmokeVerdict accepts observed smoke apps that stay quiet", () => {
  assert.deepEqual(quietSmokeVerdict(quietReport()), { ok: true, failures: [] });
});

test("quietSmokeVerdict refuses polling samples that never matched a smoke app", () => {
  assert.deepEqual(quietSmokeVerdict(quietReport({ smokeAppSamples: 0, smokeAppCount: 0 })), {
    ok: false,
    failures: ["native sampler did not observe a smoke app"],
  });
});

test("quietSmokeVerdict refuses to pass without a native polling sample", () => {
  assert.deepEqual(
    quietSmokeVerdict(quietReport({ samples: 0, smokeAppSamples: 0, smokeAppCount: 0 })),
    {
      ok: false,
      failures: [
        "native sampler produced no polling samples",
        "native sampler did not observe a smoke app",
      ],
    },
  );
});

test("quietSmokeVerdict names every native-window invariant a run violated", () => {
  assert.deepEqual(
    quietSmokeVerdict(
      quietReport({
        frontmostSamples: 2,
        activeSamples: 3,
        regularPolicySamples: 4,
        firstFrontmost: "Electron (4242)",
        firstActive: "Electron (4242)",
        firstRegular: "Electron (4242) — /Applications/Electron.app/Contents/MacOS/Electron",
        cursor: {
          start: [100, 200],
          end: [108, 209],
          maxDistanceFromStart: 12,
        },
      }),
      { assertStationaryCursor: true },
    ),
    {
      ok: false,
      failures: [
        "smoke app was frontmost in 2/20 samples (first: Electron (4242))",
        "smoke app was active in 3/20 samples (first: Electron (4242))",
        "smoke app had regular/Dock activation policy in 4/20 samples " +
          "(first: Electron (4242) — /Applications/Electron.app/Contents/MacOS/Electron)",
        "host cursor moved 12.0px from its starting position",
      ],
    },
  );
});

test("quietSmokeVerdict requires both keyboard and click evidence in an attended run", () => {
  assert.deepEqual(quietSmokeVerdict(quietReport(), { requireHostInput: true }), {
    ok: false,
    failures: [
      "no host keyboard input was observed while a smoke app was running",
      "no host click input was observed while a smoke app was running",
    ],
  });

  assert.deepEqual(
    quietSmokeVerdict(quietReport({ hostKeyInputSamples: 2, hostClickInputSamples: 1 }), {
      requireHostInput: true,
    }),
    { ok: true, failures: [] },
  );
});

test("quietSmokeVerdict reports but does not reject deliberate host cursor use", () => {
  assert.deepEqual(
    quietSmokeVerdict(
      quietReport({
        cursor: { start: [100, 200], end: [108, 209], maxDistanceFromStart: 12 },
      }),
    ),
    { ok: true, failures: [] },
  );
});
