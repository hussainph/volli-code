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
import { useCloudEnabled, useProjectHost } from "./use-hosts";

export function RunningOnLabel({
  projectId,
  className,
}: {
  projectId: string | null;
  className?: string;
}) {
  const cloud = useCloudEnabled();
  const host = useProjectHost(projectId);
  if (!cloud || host.local) return null;
  return (
    <span
      data-slot="running-on"
      aria-label={`Running on ${host.name}`}
      title={`Running on ${host.name}`}
      className={cn(
        "flex w-fit shrink-0 items-center gap-1 rounded-full border border-border px-2 text-ui leading-5 text-muted-foreground",
        className,
      )}
    >
      <StatusDot state={hostDotState(host)} />
      {host.name}
    </span>
  );
}
