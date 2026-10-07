/**
 * Local-only surfaces for a remote project (VC-711). Files, terminals,
 * worktrees and venues, automations, MCP, attachments and the like reach
 * THIS Mac's main process through `window.api`, keyed by a project id; a
 * remote project's id means nothing there. So each such surface sits behind
 * {@link LocalOnly}: for a project a remote host serves, its children never
 * mount (and never call `window.api` with that id), and the surface says
 * "Not available on <host> yet" in their place. For This Mac's projects, and
 * always with the `cloud` flag off, it renders its children and nothing else.
 */
import type * as React from "react";

import { cn } from "@renderer/lib/utils";

import { notAvailableOn, useRemoteProjectHost } from "@renderer/stores/remote-project";

/** The one line a local-only surface says for a remote project. */
export function NotAvailableOnHost({
  hostName,
  className,
}: {
  hostName: string;
  className?: string;
}) {
  return (
    <p
      role="status"
      data-slot="host-local-only"
      className={cn("text-ui text-muted-foreground", className)}
    >
      {notAvailableOn({ name: hostName })}
    </p>
  );
}

/**
 * Renders `children` for one of This Mac's projects; for a remote one, the
 * line (or `fallback`, when the surface words it itself), and never the
 * children.
 */
export function LocalOnly({
  projectId,
  children,
  fallback,
  className,
}: {
  projectId: string | null;
  children: React.ReactNode;
  /** What stands in for the surface; `null` hides it outright (a menu item, a button). */
  fallback?: React.ReactNode;
  className?: string;
}) {
  const host = useRemoteProjectHost(projectId);
  if (host === null) return children;
  if (fallback !== undefined) return fallback;
  return (
    <div className={cn("flex h-full min-h-0 items-center justify-center p-6", className)}>
      <NotAvailableOnHost hostName={host.name} />
    </div>
  );
}
