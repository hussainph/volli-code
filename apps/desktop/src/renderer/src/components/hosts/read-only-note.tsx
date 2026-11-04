/**
 * The line a form already open says while its project is read-only (VC-576):
 * the Island's words, so the reason a submit is off sits beside the submit.
 * Nothing while the project can be written to, and nothing with the flag off.
 */
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
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
      className={cn("flex items-start gap-2 px-4 py-2 text-ui text-muted-foreground", className)}
    >
      <LockSimpleIcon aria-hidden className="mt-1 size-3 shrink-0" weight="bold" />
      <span className="min-w-0 break-words">{reason}</span>
    </p>
  );
}
