import { Button } from "@renderer/components/ui/button";

type LiveReconciliationAffordanceProps =
  | {
      kind: "conflict";
      onUseDisk(): void;
      onOverwriteDisk(): void;
    }
  | {
      kind: "error";
      message: string;
    };

export function LiveReconciliationAffordance(props: LiveReconciliationAffordanceProps) {
  if (props.kind === "error") {
    return (
      <div
        data-testid="live-reconciliation-error"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="mx-2 mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      >
        {props.message}
      </div>
    );
  }

  return (
    <div
      data-testid="live-reconciliation-conflict"
      data-kind={props.kind}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="mx-2 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>Your draft and the newer disk version were both preserved.</span>
      <span className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={props.onUseDisk}>
          Use disk and discard draft
        </Button>
        <Button size="sm" variant="secondary" onClick={props.onOverwriteDisk}>
          Overwrite disk with draft
        </Button>
      </span>
    </div>
  );
}
