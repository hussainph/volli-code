/**
 * The line a form already open says while its project is read-only (VC-576):
 * the Island's words, so the reason a submit is off sits beside the submit.
 * Nothing while the project can be written to, and nothing with the flag off.
 */
import { cn } from "@renderer/lib/utils";

import { useReadOnlyReason } from "./use-hosts";

export function ReadOnlyNote({
  projectId,
  className,
}: {
  projectId: string | null;
  className?: string;
}) {
  const reason = useReadOnlyReason(projectId);
  if (reason === null) return null;
  return (
    <p
      role="status"
      data-slot="host-read-only-note"
      className={cn("text-ui text-muted-foreground", className)}
    >
      {reason}
    </p>
  );
}
