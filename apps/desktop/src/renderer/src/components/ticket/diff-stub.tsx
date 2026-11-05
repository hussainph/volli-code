import { baseNameOf } from "@volli/shared";
import { EmptyState } from "@renderer/components/ui/empty-state";

import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { cn } from "@renderer/lib/utils";

/** Binary / conflicted stub — never mounts Monaco. */
export function DiffStub({
  path,
  previousPath,
  stubReason,
}: {
  path: string;
  previousPath: string | null;
  stubReason: string;
}) {
  return (
    <div data-testid="ticket-diff-stub" className={cn("min-h-0 flex-1", EMPTY_PAGE)}>
      <EmptyState tier="page" illustration="file" status="unavailable" title={stubReason} />
      <span className="sr-only">
        {baseNameOf(path)}
        {previousPath === null ? "" : ` ← ${previousPath}`}
      </span>
    </div>
  );
}
