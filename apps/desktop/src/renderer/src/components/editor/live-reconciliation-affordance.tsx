import { Button } from "@renderer/components/ui/button";

export function LiveReconciliationAffordance({
  kind,
  onUseDisk,
  onOverwriteDisk,
}: {
  kind: "conflict";
  onUseDisk(): void;
  onOverwriteDisk(): void;
}) {
  return (
    <div
      data-testid="live-reconciliation-conflict"
      data-kind={kind}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="mx-2 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>Your draft and the newer disk version were both preserved.</span>
      <span className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onUseDisk}>
          Use disk and discard draft
        </Button>
        <Button size="sm" variant="secondary" onClick={onOverwriteDisk}>
          Overwrite disk with draft
        </Button>
      </span>
    </div>
  );
}
