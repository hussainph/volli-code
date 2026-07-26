import { baseNameOf } from "@volli/shared";

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
    <div
      data-testid="ticket-diff-stub"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-gutter py-8 text-center"
    >
      <p className="text-ui font-medium text-foreground">{stubReason}</p>
      <p className="text-xs text-muted-foreground">{baseNameOf(path)}</p>
      {previousPath !== null ? (
        <p className="text-xs text-muted-foreground/70">← {previousPath}</p>
      ) : null}
    </div>
  );
}
