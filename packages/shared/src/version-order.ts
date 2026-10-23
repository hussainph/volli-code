/**
 * Release version order: dotted numeric cores, a leading `v` and `+build`
 * metadata ignored, and a prerelease before its release with numeric
 * prerelease identifiers compared as numbers (`canary.9` < `canary.10`,
 * VC-724). Pure, so the host installer and the desktop renderer share one
 * answer to "is this build newer?". Moved here from `@volli/host-install`'s
 * probe (VC-294), which still re-exports it.
 */

function versionParts(value: string): { parts: number[]; pre: string | undefined } {
  const withoutBuild = value.replace(/^v/u, "").split("+", 1)[0]!;
  const at = withoutBuild.indexOf("-");
  const core = at < 0 ? withoutBuild : withoutBuild.slice(0, at);
  const pre = at < 0 ? undefined : withoutBuild.slice(at + 1);
  return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
}

/** Compares dotted versions numerically; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  const leftIds = left.pre.split(".");
  const rightIds = right.pre.split(".");
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index += 1) {
    const l = leftIds[index];
    const r = rightIds[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/u.test(l);
    const rn = /^\d+$/u.test(r);
    if (ln && rn) {
      const difference = BigInt(l) - BigInt(r);
      if (difference !== 0n) return difference < 0n ? -1 : 1;
    } else if (ln !== rn) return ln ? -1 : 1;
    else return l < r ? -1 : 1;
  }
  return 0;
}
