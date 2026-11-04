import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import { Notice } from "@renderer/components/ui/notice";
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

export type CopyReportCopyState = "idle" | "copying" | "copied" | "failed";
export type CopyReportAvailability = "loading" | "ready" | "unavailable";

type ClipboardWriter = Pick<Clipboard, "writeText">;

/** The only browser boundary for this report: it reports a refusal instead of guessing success. */
export async function copyReportToClipboard(
  report: string,
  clipboard?: ClipboardWriter,
): Promise<"copied" | "failed"> {
  try {
    const writer =
      clipboard ?? (typeof navigator === "undefined" ? undefined : navigator.clipboard);
    if (writer === undefined) return "failed";
    await writer.writeText(report);
    return "copied";
  } catch {
    return "failed";
  }
}

/** The report payload and its clipboard verdict. */
export function CopyReportPreview({
  report,
  copyState,
  availability = "ready",
}: {
  report: string;
  copyState: CopyReportCopyState;
  availability?: CopyReportAvailability;
}) {
  return (
    <>
      <div className="space-y-4">
        <ul aria-label="Report includes" className="space-y-2 text-ui">
          {[
            "Build and release channel",
            "Connection and environment checks",
            "Local paths and runtime details",
          ].map((label) => (
            <li key={label} className="flex items-center gap-2">
              <CheckCircleIcon aria-hidden className="size-4 text-muted-foreground" />
              {label}
            </li>
          ))}
        </ul>
        <details>
          <summary className="cursor-default text-ui text-muted-foreground">Preview report</summary>
          <pre
            aria-label="Report preview"
            tabIndex={0}
            className="mt-2 max-h-64 overflow-auto rounded-input border border-border bg-muted p-4 font-mono text-ui whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {report}
          </pre>
        </details>
      </div>

      {availability === "loading" ? (
        <p role="status" className="text-ui text-muted-foreground">
          <LoadingLabel>Preparing the complete report</LoadingLabel>
        </p>
      ) : null}

      {availability === "unavailable" ? (
        <Notice
          tone="error"
          announce
          title="Couldn’t prepare the complete report. Re-check and try again."
        />
      ) : null}

      {availability === "ready" && copyState === "failed" ? (
        <Notice tone="error" announce copyText="" title="Couldn’t copy the report. Try again." />
      ) : null}

      {availability === "ready" && copyState === "copied" ? (
        <span role="status" className="sr-only">
          Report copied.
        </span>
      ) : null}
    </>
  );
}

/** The Copy action's state belongs beside the payload, not in a toast elsewhere. */
export function CopyReportCopyButton({
  copyState,
  availability,
  onCopy,
}: {
  copyState: CopyReportCopyState;
  availability: CopyReportAvailability;
  onCopy(): void;
}) {
  const label =
    availability === "loading"
      ? "Preparing report"
      : availability === "unavailable"
        ? "Report unavailable"
        : copyState === "copying"
          ? "Copying"
          : copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy failed"
              : "Copy";

  return (
    <Button
      size="sm"
      disabled={availability !== "ready" || copyState === "copying"}
      onClick={onCopy}
    >
      {availability === "loading" || copyState === "copying" ? (
        <LoadingLabel>{label}</LoadingLabel>
      ) : (
        label
      )}
    </Button>
  );
}

/**
 * The preview gate for sharing About's local diagnostic facts.
 *
 * The state gallery at `lab/scratches/about-copy-report.tsx` keeps closed,
 * open, scrolled, copied, and refused-clipboard states visible together.
 */
export function CopyReportDialog({
  report,
  availability = "ready",
}: {
  report: string;
  availability?: CopyReportAvailability;
}) {
  const [open, setOpen] = React.useState(false);
  const [copyState, setCopyState] = React.useState<CopyReportCopyState>("idle");
  const copyAttempt = React.useRef(0);
  const availabilityRef = React.useRef(availability);
  availabilityRef.current = availability;

  React.useEffect(
    () => () => {
      copyAttempt.current += 1;
    },
    [],
  );

  React.useEffect(() => {
    if (availability === "ready") return;
    copyAttempt.current += 1;
    setCopyState("idle");
  }, [availability]);

  const onOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    setCopyState("idle");
    if (!next) copyAttempt.current += 1;
  }, []);

  const copy = React.useCallback(async () => {
    const attempt = copyAttempt.current + 1;
    copyAttempt.current = attempt;
    setCopyState("copying");

    // Opening only renders `report`; this explicit press is the only clipboard boundary.
    const outcome = await copyReportToClipboard(report);
    if (copyAttempt.current === attempt && availabilityRef.current === "ready") {
      setCopyState(outcome);
    }
  }, [report]);

  const triggerLabel =
    availability === "loading"
      ? "Preparing report"
      : availability === "unavailable"
        ? "Report unavailable"
        : "Copy report…";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={availability !== "ready"}>
          {availability === "loading" ? <LoadingLabel>{triggerLabel}</LoadingLabel> : triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Copy report</DialogTitle>
          <DialogDescription>Includes your home folder path.</DialogDescription>
        </DialogHeader>

        <CopyReportPreview report={report} copyState={copyState} availability={availability} />

        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <CopyReportCopyButton
            copyState={copyState}
            availability={availability}
            onCopy={() => void copy()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
