import * as React from "react";

import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@renderer/components/ui/dialog";

type CopyState = "idle" | "copying" | "copied" | "failed";

/**
 * The preview gate for sharing About's local diagnostic facts.
 *
 * State gallery: closed shows only the trigger; open and scrolled keep the
 * complete payload in view; Copying blocks a second write; Copied confirms a
 * fulfilled write; Copy failed stays open with a direct retry path. Closing
 * invalidates an in-flight result, so reopening never claims a cancelled view
 * copied successfully.
 */
export function CopyReportDialog({ report }: { report: string }) {
  const [open, setOpen] = React.useState(false);
  const [copyState, setCopyState] = React.useState<CopyState>("idle");
  const copyAttempt = React.useRef(0);

  React.useEffect(
    () => () => {
      copyAttempt.current += 1;
    },
    [],
  );

  const onOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    setCopyState("idle");
    if (!next) copyAttempt.current += 1;
  }, []);

  const copy = React.useCallback(async () => {
    const attempt = copyAttempt.current + 1;
    copyAttempt.current = attempt;
    setCopyState("copying");

    try {
      // This is the only clipboard boundary. Opening the dialog only renders
      // `report`; it cannot write anything until this explicit press.
      await navigator.clipboard.writeText(report);
      if (copyAttempt.current === attempt) setCopyState("copied");
    } catch {
      if (copyAttempt.current === attempt) setCopyState("failed");
    }
  }, [report]);

  const copyLabel =
    copyState === "copying"
      ? "Copying…"
      : copyState === "copied"
        ? "Copied"
        : copyState === "failed"
          ? "Copy failed"
          : "Copy";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Copy report…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Copy report</DialogTitle>
          <DialogDescription>
            This is everything that goes on your clipboard. It includes your home folder path.
          </DialogDescription>
        </DialogHeader>

        <pre
          aria-label="Report preview"
          tabIndex={0}
          className="max-h-64 overflow-auto rounded-lg border border-border/50 bg-muted/30 p-4 font-mono text-ui whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
        >
          {report}
        </pre>

        {copyState === "failed" ? (
          <p role="alert" className="text-ui text-destructive">
            Couldn&rsquo;t copy the report. Try again.
          </p>
        ) : null}

        {copyState === "copied" ? (
          <span role="status" className="sr-only">
            Report copied.
          </span>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" disabled={copyState === "copying"} onClick={() => void copy()}>
            {copyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
