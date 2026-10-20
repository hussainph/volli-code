/** Bounded host project catalog. All output vocabularies are closed. */
export const HOST_WORKSPACE_BOUNDS = Object.freeze({
  rows: 500,
  name: 512,
  path: 4096,
  gitUrl: 2048,
  message: 512,
});

export interface HostWorkspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** A sanitized locator, never a credential. */
  readonly gitRemoteUrl: string | null;
}

export interface HostWorkspaceList {
  readonly workspaces: readonly HostWorkspace[];
  readonly omitted: number;
}

export interface HostWorkspaceCreateInput {
  readonly commandId: string;
  readonly source: { readonly path: string } | { readonly gitUrl: string };
  readonly name?: string;
}

/** Closed: a new outcome needs a new feature or an explicit protocol change. */
export const HOST_WORKSPACE_FAILURE_CODES = [
  "invalid-source",
  "path-unreadable",
  "target-exists",
  "clone-failed",
  "clone-timeout",
  "registration-failed",
  "still-running",
  "interrupted",
  "capacity",
] as const;

export type HostWorkspaceCreateResult =
  | { readonly ok: true; readonly workspace: HostWorkspace }
  | {
      readonly ok: false;
      readonly failure: {
        readonly code: (typeof HOST_WORKSPACE_FAILURE_CODES)[number];
        readonly message: string;
      };
    };
