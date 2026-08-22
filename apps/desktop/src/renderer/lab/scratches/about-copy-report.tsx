import type { ReactNode } from "react";

import {
  CopyReportCopyButton,
  CopyReportDialog,
  CopyReportPreview,
  type CopyReportAvailability,
  type CopyReportCopyState,
} from "@renderer/components/settings/panes/copy-report-dialog";
import { Button } from "@renderer/components/ui/button";

export const title = "About support report";
export const note = "The preview gate — closed, open, scrolled, copied, and refused";

const REPORT = `Volli report

CLI status
Command: Linked
  /Users/ada/.local/bin/volli
Volli on login PATH: Reachable
App socket: Live
  /Users/ada/Library/Application Support/Volli Code/volli.sock
Wrappers: claude, codex
Shell chain: zsh

Doctor
[ok] Volli's bin is first on PATH
  position 1 of 18
[ok] App socket
  Live

Harnesses
Claude Code: claude (built-in)
Codex: codex (built-in)`;

const LONG_REPORT = `${REPORT}\n\n${Array.from(
  { length: 32 },
  (_, index) =>
    `[ok] Checked support fact ${index + 1}\n  /Users/ada/.cache/volli/check-${index + 1}`,
).join("\n")}`;

function StateFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-raised">
      <h2 className="font-mono text-label uppercase text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

function PreviewState({
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
      <CopyReportPreview report={report} copyState={copyState} availability={availability} />
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost">
          Cancel
        </Button>
        <CopyReportCopyButton
          copyState={copyState}
          availability={availability}
          onCopy={() => undefined}
        />
      </div>
    </>
  );
}

/** A visual state gallery for the support-report dialog; the app uses these same preview/action pieces. */
export default function AboutCopyReportScratch() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <StateFrame label="Closed">
        <CopyReportDialog report={REPORT} />
      </StateFrame>
      <StateFrame label="Open">
        <PreviewState report={REPORT} copyState="idle" />
      </StateFrame>
      <StateFrame label="Scrolled">
        <PreviewState report={LONG_REPORT} copyState="idle" />
      </StateFrame>
      <StateFrame label="Copied">
        <PreviewState report={REPORT} copyState="copied" />
      </StateFrame>
      <StateFrame label="Clipboard refused">
        <PreviewState report={REPORT} copyState="failed" />
      </StateFrame>
      <StateFrame label="Preparing">
        <PreviewState report={REPORT} copyState="idle" availability="loading" />
      </StateFrame>
    </div>
  );
}
