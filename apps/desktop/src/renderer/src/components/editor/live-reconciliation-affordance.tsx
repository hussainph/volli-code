import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";

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
      <Notice
        announce
        tone="error"
        title={props.message}
        data-testid="live-reconciliation-error"
        className="mx-2 mt-2"
      />
    );
  }

  return (
    // `announce` puts the live region on the message and never on the block:
    // buttons inside one get re-announced with the status text on every polite
    // update, and some screen readers surface live-region content as flat text
    // rather than as the focusable controls they are. That rule is the notice
    // primitive's now — this is the site that discovered it.
    <Notice
      announce
      data-testid="live-reconciliation-conflict"
      data-kind={props.kind}
      className="mx-2 mt-2"
      title="Your draft and the newer disk version were both preserved."
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={props.onUseDisk}>
            Use disk and discard draft
          </Button>
          <Button size="sm" variant="secondary" onClick={props.onOverwriteDisk}>
            Overwrite disk with draft
          </Button>
        </>
      }
    />
  );
}
