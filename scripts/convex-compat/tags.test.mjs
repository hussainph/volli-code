import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, latestTag, parseVersion } from "./tags.mjs";

const version = (tag) => {
  const parsed = parseVersion(tag);
  assert.notEqual(parsed, null, `${tag} should parse`);
  return parsed;
};

test("parses releases and prereleases, and refuses anything else", () => {
  assert.deepEqual(version("v0.3.0"), { major: 0, minor: 3, patch: 0, prerelease: [] });
  assert.deepEqual(version("v0.3.0-canary.12"), {
    major: 0,
    minor: 3,
    patch: 0,
    prerelease: ["canary", "12"],
  });
  // Build metadata is ignored, as semver says it must be.
  assert.deepEqual(version("v1.2.3+abc.4"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  for (const notAVersion of ["", "0.3.0", "v1", "v1.2", "nightly", "v1.2.3.4", "vNext"]) {
    assert.equal(parseVersion(notAVersion), null, `${notAVersion} is not a version tag`);
  }
});

test("orders by semver precedence, prerelease rules included", () => {
  const above = (left, right) =>
    assert.ok(
      compareVersions(version(left), version(right)) > 0,
      `${left} should sort above ${right}`,
    );
  // The patch/minor/major ladder.
  above("v0.2.4", "v0.2.3");
  above("v0.3.0", "v0.2.9");
  above("v1.0.0", "v0.99.99");
  // A release outranks every prerelease of its own version, and a prerelease of
  // a newer version outranks the older release — the case this lane turns on:
  // 0.3.0-canary.1 is the newest build while 0.2.3 is the newest release.
  above("v0.3.0", "v0.3.0-canary.1");
  above("v0.3.0-canary.1", "v0.2.3");
  above("v0.2.4-canary.1", "v0.2.3");
  // Numeric identifiers compare as numbers, not as strings.
  above("v0.3.0-canary.10", "v0.3.0-canary.9");
  // A longer set of identifiers is the greater one.
  above("v0.3.0-canary.1", "v0.3.0-canary");
  // Numeric identifiers sort below alphanumeric ones.
  above("v1.0.0-rc", "v1.0.0-1");
  assert.equal(compareVersions(version("v0.3.0"), version("v0.3.0")), 0);
});

test("selects the newest shipped build from a real tag list", () => {
  // The tags this repository actually had when the lane landed.
  const tags = [
    "v0.2.1",
    "v0.2.1-canary.3",
    "v0.2.2",
    "v0.2.2-canary.1",
    "v0.2.3",
    "v0.2.3-canary.5",
    "v0.3.0-canary.1",
  ];
  assert.equal(latestTag(tags), "v0.3.0-canary.1");
  // Order on the command line must not decide the answer.
  assert.equal(latestTag(tags.toReversed()), "v0.3.0-canary.1");
  // A newer release does replace an older canary.
  assert.equal(latestTag([...tags, "v0.3.0"]), "v0.3.0");
});

test("ignores what is not a version tag, and answers null when nothing is", () => {
  assert.equal(latestTag(["nightly", "release-2024", "v0.2.0-beta"]), "v0.2.0-beta");
  assert.equal(latestTag(["nightly", "", "v1"]), null);
  assert.equal(latestTag([]), null);
  // Two tags on one version: the first seen wins, so the answer never depends
  // on `git tag`'s ordering.
  assert.equal(latestTag(["v0.3.0-canary.1", "v0.3.0-canary.1"]), "v0.3.0-canary.1");
});
