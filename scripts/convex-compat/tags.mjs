/**
 * Which shipped build the older-app live lane runs (VC-1019).
 *
 * The lane takes the newest `v*` tag that parses as a semver version —
 * prereleases included — because that is the build people are running: the
 * latest stable release when no canary is newer than it, the newest canary
 * otherwise (today `v0.3.0-canary.1`). Semver order, not tag date: a canary
 * cut from an older commit can still be the newer build, and
 * `git tag --sort=-creatordate` would answer with whatever was tagged last.
 *
 * Deliberately not `packages/host-core/scripts/n1/prepare.mjs`'s helpers, which
 * answer "newest stable" and "newest canary" as two separate questions because
 * the N-1 lanes prove two different downgrade promises. Here one answer is
 * wanted — the one build that shipped most recently — so every tag is compared
 * against every other, prerelease suffixes and all.
 *
 * No dependencies: this runs before anything is installed.
 */

const VERSION = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC = /^\d+$/;

/**
 * `v1.2.3-canary.4` → `{ major: 1, minor: 2, patch: 3, prerelease: ["canary", "4"] }`;
 * a release has an empty `prerelease`. `null` for anything that is not a
 * version tag (`v0.2.0-beta` parses; `nightly`, `v1`, a commit sha do not).
 */
export function parseVersion(tag) {
  const match = VERSION.exec(tag ?? "");
  if (match === null) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

/** One prerelease identifier: numeric ones compare as numbers and sort below text. */
function compareIdentifier(left, right) {
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semver precedence (build metadata ignored): negative when `left` sorts below `right`. */
export function compareVersions(left, right) {
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] - right[part];
  }
  // A release outranks every prerelease of the same version, and having any
  // prerelease puts a version below it.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (order !== 0) return order;
  }
  // A longer set of identifiers is the greater one: `alpha.1` above `alpha`.
  return left.prerelease.length - right.prerelease.length;
}

/**
 * The newest `v*` tag by semver, prereleases included — or `null` when the
 * list holds no version tag at all. Equal-precedence tags (for example,
 * differing only in build metadata) keep the first one seen.
 */
export function latestTag(tags) {
  let newest = null;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (version === null) continue;
    if (newest === null || compareVersions(version, newest.version) > 0) {
      newest = { tag, version };
    }
  }
  return newest?.tag ?? null;
}
