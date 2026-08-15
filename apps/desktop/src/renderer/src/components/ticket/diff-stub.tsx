import { baseNameOf } from "@volli/shared";

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
      <p className="text-ui font-medium text-foreground">{stubReason}</p>
      <p className="text-ui text-muted-foreground">{baseNameOf(path)}</p>
      {previousPath !== null ? (
        <p className="text-ui text-muted-foreground/70">← {previousPath}</p>
      ) : null}
    </div>
  );
}
