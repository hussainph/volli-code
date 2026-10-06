/**
 * "Running on <host>" (VC-576; the lab's `VenueChip`): a quiet pill naming the
 * machine a ticket's or Session's work runs on, whose dot is the HOST's state,
 * not the Session's.
 *
 * Only for a host other than This Mac — a person with no hosts sees nothing
 * new — and never with the `cloud` flag off.
 */
import { StatusDot } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

import { hostDotState } from "./host-surface-model";
import { useCloudEnabled, useProjectHostView } from "./use-hosts";

export function RunningOnLabel({
  projectId,
  className,
}: {
  projectId: string | null;
  className?: string;
}) {
  // The flag first: off, this never reads the host store, so a host change
  // cannot re-render or commit it.
  const cloud = useCloudEnabled();
  if (!cloud) return null;
  return <EnabledRunningOnLabel projectId={projectId} className={className} />;
}

function EnabledRunningOnLabel({
  projectId,
  className,
}: {
  projectId: string | null;
  className?: string;
}) {
  const host = useProjectHostView(projectId);
  if (host.local) return null;
  return (
    <span
      data-slot="running-on"
      title={`Running on ${host.name}`}
      className={cn(
        "flex w-fit shrink-0 items-center gap-1 rounded-full border border-border px-2 text-ui leading-5 text-muted-foreground",
        className,
      )}
    >
      <StatusDot state={hostDotState(host)} />
      {/* Read as one phrase; seen as just the name, as in the lab. */}
      <span className="sr-only">Running on </span>
      {host.name}
    </span>
  );
}
