import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useState, type ReactNode } from "react";
import type { CliToolStatus } from "../../../../ipc/contract";

import {
  sessionPathComparison,
  type SessionPathComparison,
} from "@renderer/components/pages/cli-status-model";
import { Button } from "@renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import { Notice } from "@renderer/components/ui/notice";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

const COMPARISON_DOT: Record<SessionPathComparison["state"], StatusDotState> = {
  matching: "ready",
  pending: "waiting",
  diverged: "waiting",
  unknown: "idle",
};

/** The Settings → CLI proof that a Session receives what the login shell reported. */
export function SessionPathComparison({
  environment,
}: {
  environment: CliToolStatus["environment"];
}) {
  const comparison = sessionPathComparison({ environment });
  const [showAll, setShowAll] = useState(false);
  const sessionOnlyLabel =
    comparison.sessionOnly.length === 1
      ? "1 additional Session directory"
      : `${comparison.sessionOnly.length} additional Session directories`;
  const differenceTone =
    comparison.state === "diverged"
      ? "problem"
      : comparison.state === "pending"
        ? "pending"
        : "quiet";

  return (
    <Collapsible open={showAll} onOpenChange={setShowAll}>
      <div data-session-path-state={comparison.state} className="border-t border-border/50 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <p className="text-sm font-medium">Session PATH</p>
            <span className="flex items-center gap-2 text-ui text-muted-foreground">
              <StatusDot state={COMPARISON_DOT[comparison.state]} />
              {comparisonStateLabel(comparison)}
            </span>
          </div>
          <CollapsibleTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`${showAll ? "Hide" : "Show"} all login and Session PATH directories`}
            >
              {showAll ? <CaretUpIcon /> : <CaretDownIcon />}
              {showAll ? "Hide paths" : "Show all paths"}
            </Button>
          </CollapsibleTrigger>
        </div>

        {comparison.state === "diverged" ? <DivergenceNotice comparison={comparison} /> : null}
        {comparison.state === "pending" ? <PendingComparisonNotice /> : null}
        {comparison.state === "unknown" ? (
          <Notice
            className="mt-2"
            announce
            tone="neutral"
            icon={WarningIcon}
            title="Couldn't compare the login PATH"
            detail="The login shell did not answer. The Session PATH below is still the value commands receive."
          />
        ) : null}
        {environment.systemPathIssues.map((issue) => (
          <SystemPathIssueNotice key={`${issue.file}:${issue.entry}`} issue={issue} />
        ))}

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <PathFact
            title="Login PATH"
            detail={`${comparison.loginEntries.length} directories`}
            tone={differenceTone}
          >
            {comparison.state === "unknown" ? (
              <p className="text-ui text-muted-foreground">
                The login shell did not provide a PATH.
              </p>
            ) : comparison.missingFromSession.length > 0 ? (
              <PathEntries entries={comparison.missingFromSession} />
            ) : (
              <p className="text-ui text-muted-foreground">All login directories reach Sessions.</p>
            )}
          </PathFact>
          <PathFact
            title="Session PATH"
            detail={`${comparison.sessionEntries.length} directories`}
            tone={differenceTone}
          >
            {comparison.state === "unknown" ? (
              <PathEntries entries={comparison.sessionEntries} />
            ) : comparison.missingFromSession.length > 0 ? (
              <p
                className={cn(
                  "text-ui",
                  differenceTone === "problem" ? "text-destructive" : "text-attention",
                )}
              >
                Missing the login directories beside this column.
              </p>
            ) : comparison.sessionOnly.length > 0 ? (
              <>
                <p className="mb-1 text-ui text-muted-foreground">{sessionOnlyLabel}</p>
                <PathEntries entries={comparison.sessionOnly} />
              </>
            ) : (
              <p className="text-ui text-muted-foreground">No additional Session directories.</p>
            )}
          </PathFact>
        </div>

        {!comparison.sharedOrderMatches && comparison.state !== "unknown" ? (
          <div className="mt-2">
            <p
              className={cn(
                "mb-1 text-ui font-medium",
                differenceTone === "problem" ? "text-destructive" : "text-attention",
              )}
            >
              Shared directory order differs
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <PathColumn
                title="Login order"
                entries={comparison.loginEntries.filter((entry) =>
                  comparison.sessionEntries.includes(entry),
                )}
                tone={differenceTone}
              />
              <PathColumn
                title="Session order"
                entries={comparison.sessionEntries.filter((entry) =>
                  comparison.loginEntries.includes(entry),
                )}
                tone={differenceTone}
              />
            </div>
          </div>
        ) : null}
      </div>
      <CollapsibleContent className="mt-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <PathColumn title="All login PATH directories" entries={comparison.loginEntries} />
          <PathColumn title="All Session PATH directories" entries={comparison.sessionEntries} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function comparisonStateLabel(comparison: SessionPathComparison): string {
  switch (comparison.state) {
    case "matching":
      return "Matches login shell";
    case "pending":
      return "Completing interactive login PATH";
    case "diverged":
      return "Differs from login shell";
    case "unknown":
      return "Login shell unavailable";
  }
}

function SystemPathIssueNotice({
  issue,
}: {
  issue: CliToolStatus["environment"]["systemPathIssues"][number];
}) {
  return (
    <Notice
      className="mt-2 border-attention/30 bg-attention/10 text-attention"
      announce
      tone="neutral"
      icon={WarningIcon}
      title="A system PATH entry is malformed"
      detail={
        <>
          <code className="break-all font-mono text-current">{issue.file}</code> contains{" "}
          <code className="break-all font-mono text-current">{issue.entry}</code>. Microsoft&apos;s
          .NET CLI installer commonly writes it without expanding{" "}
          <code className="font-mono text-current">~</code>. macOS adds it to every login PATH.
          Volli filters it so Sessions stay usable, but other tools can still reject that PATH.
          Volli will not modify this root-owned file.
        </>
      }
    />
  );
}

function PendingComparisonNotice() {
  return (
    <Notice
      className="mt-2"
      announce
      tone="neutral"
      icon={WarningIcon}
      title="Completing the interactive login PATH"
      detail="The difference below may resolve when the shell pass finishes. Refresh to read its completed state."
    />
  );
}

function DivergenceNotice({ comparison }: { comparison: SessionPathComparison }) {
  const missing = comparison.missingFromSession.length;
  const title =
    missing > 0
      ? `Session PATH is missing ${missing} login ${missing === 1 ? "directory" : "directories"}`
      : "Session PATH orders shared directories differently";
  const detail =
    missing > 0
      ? "Commands installed in those directories cannot run in Sessions."
      : "A command may resolve to a different copy in a Session.";

  return (
    <Notice
      className="mt-2"
      announce
      tone="error"
      icon={WarningIcon}
      title={title}
      detail={detail}
    />
  );
}

function PathFact({
  title,
  detail,
  tone,
  children,
}: {
  title: string;
  detail: string;
  tone: "quiet" | "pending" | "problem";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border p-2",
        tone === "problem"
          ? "border-destructive/30 bg-destructive/10"
          : tone === "pending"
            ? "border-attention/30 bg-attention/10"
            : "border-border/50 bg-muted/30",
      )}
    >
      <p
        className={cn(
          "text-label uppercase",
          tone === "problem"
            ? "text-destructive"
            : tone === "pending"
              ? "text-attention"
              : "text-muted-foreground",
        )}
      >
        {title}
      </p>
      <p className="mb-1 text-ui text-muted-foreground">{detail}</p>
      {children}
    </div>
  );
}

function PathColumn({
  title,
  entries,
  tone = "quiet",
}: {
  title: string;
  entries: readonly string[];
  tone?: "quiet" | "pending" | "problem";
}) {
  return (
    <PathFact title={title} detail={`${entries.length} directories`} tone={tone}>
      <PathEntries entries={entries} />
    </PathFact>
  );
}

/** Never truncate a path here: this is diagnostic evidence, not a compact label. */
function PathEntries({ entries }: { entries: readonly string[] }) {
  return (
    <ol className="flex flex-col gap-1">
      {entries.map((entry, index) => (
        <li key={`${index}:${entry}`} className="flex min-w-0 gap-2">
          <span aria-hidden className="shrink-0 font-mono text-ui text-muted-foreground">
            {index + 1}
          </span>
          <code className="min-w-0 break-all font-mono text-ui text-foreground">{entry}</code>
        </li>
      ))}
    </ol>
  );
}
