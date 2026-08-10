/**
 * Pi's own `path` normalization, replicated because it cannot be imported.
 *
 * Every Pi file tool sends its `path` through `normalizeToolPath` before opening
 * anything: it collapses several Unicode spaces to ASCII and strips one leading
 * `@`. Policy that resolves the raw argument therefore inspects a different file
 * than the tool opens — `write { path: "@.git/hooks/pre-commit" }` reads as
 * `<workspace>/@.git/…` to a rule and lands on `<workspace>/.git/hooks/…` on
 * disk. The sandbox does not catch it either: `denyWrite` wraps `exec`, and file
 * tools go straight to Node's fs.
 *
 * Source: `@earendil-works/pi-agent-core@0.84.1`,
 * `dist/harness/tools/path-utils.js`, `normalizeToolPath`. Copied rather than
 * imported because the package's `exports` map is closed to `.`, `./node`, and
 * `./session/testing`, and the function is module-private besides.
 *
 * A copy of someone else's normalization is a divergence waiting to happen, so
 * it is not trusted to stay right: `pi-tool-path.test.ts` drives Pi's real
 * `createWriteTool` against a stub environment that records the string Pi hands
 * to `absolutePath`, and asserts this function agrees with it exactly. A Pi
 * version bump that changes the normalization fails that test rather than
 * quietly reopening the hole.
 */

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** What Pi will actually open, given what the model asked for. */
export function normalizeToolPath(path: string): string {
  const normalized = path.replace(UNICODE_SPACES, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}
