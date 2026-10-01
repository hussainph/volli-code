/** Every filesystem probe used to build an attachment policy shares this error boundary. */
export type PolicyFilesystemOperation =
  | "lstat"
  | "stat"
  | "readlink"
  | "realpath"
  | "read file"
  | "list directory"
  | "open directory"
  | "read directory"
  | "close directory";

/**
 * Absence is safe; an incomplete view of an existing tree is not. ENOTDIR
 * denotes an absent path only for a path lookup, never a directory operation.
 * Callers consume absence, but may not catch a failed probe and keep building.
 */
export function policyFilesystem<T>(
  path: string,
  operation: PolicyFilesystemOperation,
  probe: () => T,
): T | undefined {
  try {
    return probe();
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    if (code === "ENOENT" || (code === "ENOTDIR" && !operation.endsWith("directory")))
      return undefined;
    const reason =
      code === "EACCES" || code === "EPERM"
        ? "permission was denied"
        : `the filesystem reported ${code ?? "an unknown error"}`;
    const action =
      operation === "lstat" || operation === "stat"
        ? "inspect path"
        : operation === "readlink" || operation === "realpath"
          ? "resolve path"
          : operation;
    throw new Error(`Cannot ${action} "${path}" because ${reason}; refusing Scoped attachment.`, {
      cause: error,
    });
  }
}
