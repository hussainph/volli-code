/** Comparisons and additions-only ordering at the runtime adoption boundary. */
import { sessionToolIds, type SessionRuntimeSpec } from "@volli/shared";
import { canonicalJson } from "../codemode/journal";

function relevant(spec: SessionRuntimeSpec) {
  return {
    tools: spec.tools,
    declarationTools: spec.declarationTools ?? spec.tools,
    wiredIds: sessionToolIds(spec),
  };
}

/** Ignore recreated port/callback identities; their wired membership still matters. */
export function sameToolSpec(before: SessionRuntimeSpec, after: SessionRuntimeSpec): boolean {
  return canonicalJson(relevant(before)) === canonicalJson(relevant(after));
}

/** Canonical rebuilt order first; retain unexpected omissions instead of revoking names. */
export function retainOmitted<T>(
  previous: readonly T[],
  rebuilt: readonly T[],
  key: (item: T) => string,
): T[] {
  const names = new Set(rebuilt.map(key));
  return [...rebuilt, ...previous.filter((item) => !names.has(key(item)))];
}
