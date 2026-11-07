/** A transcript-only exploration. The diff hand-off and all turn facts are fixtures. */
import * as React from "react";
import {
  CheckCircleIcon,
  CaretDownIcon,
  CaretRightIcon,
  FileCodeIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import {
  ACTIVITY_METADATA_KEY,
  type ActivityDescriptor,
  type ActivityOutcome,
} from "@volli/shared";
import type { BundleRow } from "@volli/session-presentation";
import type { DynamicToolUIPart } from "ai";

import { ActivityBundle } from "@renderer/components/chat/activity-ui";
import { TurnRunningMark } from "@renderer/components/chat/chat-plane";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";

export const title = "Turn change summary";
export const note = "A turn-end receipt in the transcript · simulated wiring";
export const viewport = "stage" as const;

type FileChange = {
  path: string;
  status: "Added" | "Edited" | "Deleted";
  added: number;
  removed: number;
};
type Check = { command: string; exit: number };
type Scenario = "One file" | "Many files" | "Failed check" | "Running";

const files: FileChange[] = [
  { path: "src/chat/turn-summary.tsx", status: "Added", added: 82, removed: 0 },
  { path: "src/chat/activity-ui.tsx", status: "Edited", added: 16, removed: 4 },
  { path: "src/chat/turn-summary.test.tsx", status: "Added", added: 43, removed: 0 },
  { path: "src/chat/old-receipt.tsx", status: "Deleted", added: 0, removed: 21 },
  { path: "src/chat/transcript.tsx", status: "Edited", added: 12, removed: 3 },
  { path: "src/chat/transcript.test.tsx", status: "Edited", added: 9, removed: 2 },
];
const checks: Check[] = [
  { command: "vp test run src/chat/turn-summary.test.tsx", exit: 0 },
  { command: "vp run typecheck", exit: 0 },
];
const scenarios: Scenario[] = ["One file", "Many files", "Failed check", "Running"];

// These mirror chat-activity's descriptor/tool fixture builders. Those builders
// are local to that scratch; keeping the fixture here avoids a production edit.
function fixtureTool(
  kind: "write-file" | "run-command",
  label: string,
  path: string | null,
  exit = 0,
): DynamicToolUIPart {
  const outcome: ActivityOutcome = {
    exitCode: kind === "run-command" ? exit : null,
    matchCount: null,
    fileCount: null,
    lineCount: null,
    bytes: null,
    addedLines: kind === "write-file" ? 82 : null,
    removedLines: kind === "write-file" ? 0 : null,
    diff: null,
    summary: null,
  };
  const descriptor: ActivityDescriptor = {
    kind,
    nativeToolName: kind,
    subject: { label, path, lineRange: null },
    outcome,
    startedAt: 0,
    endedAt: 2400,
  };
  return {
    type: "dynamic-tool",
    toolName: kind,
    toolCallId: `fixture-${kind}-${label}`,
    toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
    state: "output-available",
    input: null,
    output: null,
  };
}
function activityRows(verification: Check[]): BundleRow[] {
  return [
    { kind: "tool", key: "write", part: fixtureTool("write-file", files[0].path, files[0].path) },
    ...verification.map((check) => ({
      kind: "tool" as const,
      key: check.command,
      part: fixtureTool("run-command", check.command, null, check.exit),
    })),
  ];
}

function Stats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-label tabular-nums">
      <span className="text-positive">+{added}</span>{" "}
      <span className="text-destructive">−{removed}</span>
    </span>
  );
}

function TurnReceipt({
  changes,
  verification,
  onOpenFile,
}: {
  changes: FileChange[];
  verification: Check[];
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const visible = expanded ? changes : changes.slice(0, 4);
  const added = changes.reduce((sum, file) => sum + file.added, 0);
  const removed = changes.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-4 px-4 py-2">
        <span className="text-ui font-medium">
          Files changed <span className="text-muted-foreground">({changes.length})</span>
        </span>
        <Stats added={added} removed={removed} />
      </div>
      <div className="border-t border-border py-1">
        {visible.map((file) => {
          const slash = file.path.lastIndexOf("/");
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => onOpenFile(file.path)}
              aria-label={`Open diff for ${file.path}, ${file.status}, +${file.added} −${file.removed}`}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-ui hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <FileCodeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
                {file.path.slice(slash + 1)}
              </span>
              <span className="shrink-0 text-label text-muted-foreground">{file.status}</span>
              <Stats added={file.added} removed={file.removed} />
              <CaretRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
        {changes.length > 4 ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="flex items-center gap-1 px-4 py-2 text-label text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <CaretDownIcon aria-hidden className={expanded ? "size-3 rotate-180" : "size-3"} />
            {expanded ? "Show less" : `Show ${changes.length - 4} more files`}
          </button>
        ) : null}
      </div>
      <div className="border-t border-border px-4 py-2">
        <div className="mb-1 text-ui font-medium">Verification</div>
        {verification.map((check) => (
          <div key={check.command} className="flex items-center gap-2 py-1 text-ui">
            {check.exit === 0 ? (
              <CheckCircleIcon aria-hidden className="size-4 shrink-0 text-positive" />
            ) : (
              <XCircleIcon aria-hidden weight="fill" className="size-4 shrink-0 text-destructive" />
            )}
            <code className="min-w-0 flex-1 truncate text-label" title={check.command}>
              {check.command}
            </code>
            <span
              className={
                check.exit === 0
                  ? "shrink-0 text-label text-muted-foreground"
                  : "shrink-0 text-label text-destructive"
              }
            >
              Exit {check.exit}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TurnChangeSummaryScratch() {
  const [scenario, setScenario] = React.useState<Scenario>("Many files");
  const [selected, setSelected] = React.useState<string | null>(null);
  const changes = scenario === "One file" ? files.slice(0, 1) : files;
  const verification =
    scenario === "Failed check" ? [checks[0], { ...checks[1], exit: 1 }] : checks;
  return (
    <ContentColumn className="flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-center gap-1">
        {scenarios.map((name) => (
          <Button
            key={name}
            size="xs"
            variant={scenario === name ? "secondary" : "ghost"}
            onClick={() => {
              setScenario(name);
              setSelected(null);
            }}
          >
            {name}
          </Button>
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <div className="self-end rounded-lg bg-muted px-4 py-2 text-ui">
          Add a summary of changes at the end of each turn.
        </div>
        <ActivityBundle rows={activityRows(verification)} onOpenFile={setSelected} />
        {scenario === "Running" ? (
          <TurnRunningMark />
        ) : (
          <>
            <div className="text-label text-muted-foreground">Worked for 2m 13s</div>
            <p className="text-ui text-foreground">
              Added a turn-end summary with changed files and verification results.
            </p>
            <TurnReceipt
              key={scenario}
              changes={changes}
              verification={verification}
              onOpenFile={setSelected}
            />
          </>
        )}
      </div>
      {selected ? (
        <div
          role="status"
          className="rounded-md border border-border bg-muted px-4 py-2 text-label text-muted-foreground"
        >
          Simulated wiring · Open diff:{" "}
          <span className="font-mono text-foreground">{selected}</span>
        </div>
      ) : null}
    </ContentColumn>
  );
}
