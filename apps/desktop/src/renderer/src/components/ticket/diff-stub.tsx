import { baseNameOf } from "@volli/shared";
import { FindFileIcon } from "@renderer/components/ui/icon";

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
      <FindFileIcon aria-hidden className="size-8 text-muted-foreground" />
      <h2 className="text-heading font-semibold text-foreground wrap-anywhere">{stubReason}</h2>
      <p className="max-w-full font-mono text-ui text-muted-foreground wrap-anywhere" title={path}>
        {baseNameOf(path)}
      </p>
      {previousPath !== null ? (
        <p className="max-w-full font-mono text-ui text-muted-foreground wrap-anywhere">
          ← {previousPath}
        </p>
      ) : null}
    </div>
  );
}
