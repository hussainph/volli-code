/** Deterministic workspace containment; paths must be absolute and resolved. */
function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** Literal, case-sensitive component containment, never a string prefix. */
export function containsPath(root: string, candidate: string): boolean {
  const roots = pathSegments(root);
  const parts = pathSegments(candidate);
  return parts.length >= roots.length && roots.every((part, index) => parts[index] === part);
}
