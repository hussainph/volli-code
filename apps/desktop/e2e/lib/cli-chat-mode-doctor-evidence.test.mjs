import assert from "node:assert/strict";
import { test } from "node:test";

import { inspectDoctorPathEvidence } from "./cli-chat-mode-doctor-evidence.mjs";

const EXPECTED_SHIM = "/private/tmp/clichat/Volli Code/bin/volli";

function reply(pathCheck, cliCheck) {
  return [pathCheck, cliCheck].join("\n");
}

test("requires successful PATH position and this scratch profile's CLI shim", () => {
  const success = reply(
    "✓ Volli's bin is first on PATH\n    position 1 of 8",
    `✓ \`volli\` is this app's CLI\n    ${EXPECTED_SHIM}`,
  );
  assert.deepEqual(inspectDoctorPathEvidence(success, EXPECTED_SHIM), {
    pathPositionOk: true,
    cliShimOk: true,
  });
  assert.deepEqual(inspectDoctorPathEvidence(success.replace("`volli`", "volli"), EXPECTED_SHIM), {
    pathPositionOk: true,
    cliShimOk: true,
  });

  const warningAndWrongProfile = reply(
    "✓ Volli's bin is first on PATH\n    position 1 of 8",
    "! `volli` is this app's CLI\n    resolves to /usr/local/bin/volli, which is not this app's shim",
  );
  assert.deepEqual(inspectDoctorPathEvidence(warningAndWrongProfile, EXPECTED_SHIM), {
    pathPositionOk: true,
    cliShimOk: false,
  });

  const failedPathPosition = reply(
    "✗ Volli's bin is first on PATH\n    position 2 of 8",
    `✓ \`volli\` is this app's CLI\n    ${EXPECTED_SHIM}`,
  );
  assert.deepEqual(inspectDoctorPathEvidence(failedPathPosition, EXPECTED_SHIM), {
    pathPositionOk: false,
    cliShimOk: true,
  });

  const wrongShimBehindSuccessMark = reply(
    "✓ Volli's bin is first on PATH\n    position 1 of 8",
    "✓ `volli` is this app's CLI\n    /Users/developer/Library/Application Support/Volli Code/bin/volli",
  );
  assert.deepEqual(inspectDoctorPathEvidence(wrongShimBehindSuccessMark, EXPECTED_SHIM), {
    pathPositionOk: true,
    cliShimOk: false,
  });
});
