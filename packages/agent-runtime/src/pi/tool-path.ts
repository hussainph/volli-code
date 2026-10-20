/**
 * Pi's file-tool path normalization, replicated because it is module-private.
 *
 * Used only to recognize a read of saved tool output and preserve its untrusted
 * data warning. The normalizer is not an authority rule or an execution guard.
 *
 * Source: @earendil-works/pi-agent-core, dist/harness/tools/path-utils.js,
 * normalizeToolPath. The replica is pinned against the real file tools by
 * tool-path.test.ts; recheck it whenever Pi is bumped.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** What Pi will actually open, given what the model asked for. */
export function normalizeToolPath(path: string): string {
  const normalized = path.replace(UNICODE_SPACES, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}
