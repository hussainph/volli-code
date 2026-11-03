/** A simulated transcript comparison; no command or backend is run here. */
import * as React from "react";
import {
  CaretRightIcon,
  CheckCircleIcon,
  FileTextIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  SpinnerGapIcon,
  TerminalWindowIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import {
  ACTIVITY_METADATA_KEY,
  type ActivityDescriptor,
  type ActivityKind,
  type ActivityOutcome,
} from "@volli/shared";
import {
  activityDescriptor,
  activityStatus,
  describeActivity,
  type BundleRow,
} from "@volli/session-presentation";
import type { DynamicToolUIPart } from "ai";
import { ActivityBundle, ToolRow } from "@renderer/components/chat/activity-ui";
import { Shimmer } from "@renderer/components/ui/ai-elements/shimmer";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

export const title = "Tool calls · Shipped / v2";
export const note = "Simulated wiring · transcript rows and groups";
export const viewport = "stage" as const;

// The same descriptor-stamped fixture shapes and values as chat-activity. The
// gallery's builders are private; the two columns here share each part object.
function outcome(patch: Partial<ActivityOutcome> = {}): ActivityOutcome {
  return {
    exitCode: null,
    matchCount: null,
    fileCount: null,
    lineCount: null,
    bytes: null,
    addedLines: null,
    removedLines: null,
    diff: null,
    summary: null,
    ...patch,
  };
}
function descriptor(
  kind: ActivityKind,
  label: string,
  patch: Partial<ActivityDescriptor> = {},
): ActivityDescriptor {
  return {
    kind,
    nativeToolName: kind,
    subject: {
      label,
      path: ["read-file", "edit-file", "write-file"].includes(kind) ? label : null,
      lineRange: null,
    },
    outcome: null,
    startedAt: 0,
    endedAt: 2400,
    ...patch,
  };
}
let sequence = 0;
function tool(
  activity: ActivityDescriptor,
  options: {
    state?: "input-streaming" | "input-available" | "output-error";
    output?: string;
    errorText?: string;
  } = {},
): DynamicToolUIPart {
  const base = {
    type: "dynamic-tool" as const,
    toolName: activity.nativeToolName,
    toolCallId: `v2-fixture-${sequence++}`,
    toolMetadata: { [ACTIVITY_METADATA_KEY]: activity } as DynamicToolUIPart["toolMetadata"],
    input: null,
  };
  if (options.state === "input-streaming" || options.state === "input-available")
    return { ...base, state: options.state };
  if (options.state === "output-error")
    return {
      ...base,
      state: "output-error",
      errorText: options.errorText ?? "ENOENT: no such file or directory",
    };
  return { ...base, state: "output-available", output: options.output ?? null };
}
const command = (label: string, output = "0 errors") =>
  tool(descriptor("run-command", label, { outcome: outcome({ exitCode: 0 }) }), { output });
const read = (label: string) =>
  tool(descriptor("read-file", label), { output: "export * from './session'" });
const search = tool(
  descriptor("search", "groupMessageParts", { outcome: outcome({ matchCount: 14, fileCount: 6 }) }),
  { output: "src/renderer/lab/chat/activity.ts:77:export function groupMessageParts(" },
);
const list = tool(
  descriptor("list-directory", "apps/desktop/src/preload/", { outcome: outcome({ fileCount: 4 }) }),
  { output: "index.ts\napi.ts" },
);
const edit = tool(
  descriptor("edit-file", "src/renderer/lab/chat/activity.ts", {
    outcome: outcome({ addedLines: 24, removedLines: 3, diff: "@@ -1 +1 @@\n-old\n+new" }),
  }),
);
const write = tool(
  descriptor("write-file", "src/renderer/lab/chat/fold.test.ts", {
    outcome: outcome({ addedLines: 41 }),
  }),
);
const checks = [
  command("pnpm run -r typecheck"),
  command("pnpm run -r test", "Test Files  186 passed (186)\nTests  3068 passed (3068)"),
  command("vp check", "818 files formatted\n786 files linted"),
];
const explore = [
  read("apps/desktop/src/main/index.ts"),
  search,
  list,
  read("apps/desktop/src/preload/api.ts"),
  read("packages/session-engine/src/index.ts"),
  tool(descriptor("search", "SessionProjection", { outcome: outcome({ matchCount: 0 }) }), {
    output: "",
  }),
  tool(descriptor("read-file", "packages/session-rpc/src/router.ts"), { state: "input-available" }),
];
const pending = tool(descriptor("run-command", "pnpm run -r typecheck"), {
  state: "input-streaming",
});
const editing = tool(descriptor("edit-file", "src/renderer/lab/chat/activity.ts"), {
  state: "input-available",
});
const failedCommand = tool(
  descriptor("run-command", "pnpm run -r test", { outcome: outcome({ exitCode: 1 }) }),
  { output: "1 failed | 183 passed" },
);
const missing = tool(descriptor("read-file", "packages/gone.ts"), { state: "output-error" });
const longOutput = tool(descriptor("run-command", "pnpm run -r test"), {
  output: Array.from(
    { length: 60 },
    (_, i) => `  ✓ src/renderer/lab/chat/activity.test.ts:${i + 1}  passed`,
  ).join("\n"),
});
const liveBase = tool(descriptor("run-command", "vp run -r test"), { state: "input-available" });
const settled = [...checks, edit, write];
const tall = [...checks, ...explore, ...settled].map((part, index) =>
  Object.assign({}, part, { toolCallId: `${part.toolCallId}-tall-${index}` }),
);
function bundle(parts: readonly DynamicToolUIPart[]): BundleRow[] {
  return parts.map((part, index) => ({ kind: "tool", key: `${part.toolCallId}-${index}`, part }));
}
const settledBundle = bundle(settled);
const tallBundle = bundle(tall);
const failedBundle = bundle([...explore.slice(0, 2), missing]);

function Path({ value, running }: { value: string; running: boolean }) {
  const slash = value.lastIndexOf("/");
  if (slash < 0 || slash === value.length - 1)
    return running ? <Shimmer as="span">{value}</Shimmer> : <span>{value}</span>;
  const directory = value.slice(0, slash + 1);
  const name = value.slice(slash + 1);
  return (
    <span>
      {running ? (
        <Shimmer as="span" className="text-muted-foreground">
          {directory}
        </Shimmer>
      ) : (
        <span className="text-muted-foreground">{directory}</span>
      )}
      {running ? <Shimmer as="span">{name}</Shimmer> : name}
    </span>
  );
}
function Glyph({ part }: { part: DynamicToolUIPart }) {
  const kind = activityDescriptor(part).kind;
  const status = activityStatus(part);
  const failed =
    status === "failed" ||
    status === "denied" ||
    (kind === "run-command" && (activityDescriptor(part).outcome?.exitCode ?? 0) !== 0);
  const Icon = failed
    ? XCircleIcon
    : status === "running" || status === "pending"
      ? SpinnerGapIcon
      : kind === "run-command"
        ? TerminalWindowIcon
        : kind === "search"
          ? MagnifyingGlassIcon
          : kind === "list-directory"
            ? FolderIcon
            : kind === "edit-file" || kind === "write-file"
              ? PencilSimpleIcon
              : FileTextIcon;
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-4 shrink-0",
        failed ? "text-destructive" : "text-muted-foreground",
        (status === "running" || status === "pending") && "animate-spin motion-reduce:animate-none",
      )}
    />
  );
}
function V2Row({
  part,
  metaAtEnd,
  liveSeconds,
}: {
  part: DynamicToolUIPart;
  metaAtEnd: boolean;
  liveSeconds?: number;
}) {
  const row = describeActivity(part);
  const activity = activityDescriptor(part);
  const running = row.status === "running" || row.status === "pending";
  const exit = activity.outcome?.exitCode;
  const failed =
    row.status === "failed" ||
    row.status === "denied" ||
    (row.kind === "run-command" && exit != null && exit !== 0);
  const object = activity.subject.label ?? row.object ?? row.nativeToolName;
  const verbs: Partial<Record<ActivityKind, [string, string, string]>> = {
    "run-command": ["Running", "Ran", "Failed to run"],
    "read-file": ["Reading", "Read", "Failed to read"],
    "edit-file": ["Editing", "Edited", "Failed to edit"],
    "write-file": ["Creating", "Created", "Failed to create"],
    search: ["Searching", "Searched", "Failed to search"],
    "list-directory": ["Listing", "Listed", "Failed to list"],
  };
  const verb = (verbs[row.kind] ?? [row.verb, row.verb, "Failed"])[failed ? 2 : running ? 0 : 1];
  const commandFailure = row.kind === "run-command" && exit != null && exit !== 0;
  const output =
    part.state === "output-available" && typeof part.output === "string"
      ? part.output
      : (activity.outcome?.diff ?? null);
  const error = part.state === "output-error" ? part.errorText : commandFailure ? output : null;
  const expandable = Boolean(output && !error);
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null);
  const open = userOpen ?? (running && Boolean(output));
  const lines = output?.split("\n") ?? [];
  const hidden = Math.max(0, lines.length - 6);
  const meta = liveSeconds !== undefined && running ? `${liveSeconds}s` : row.meta;
  return (
    <div className="min-w-0 text-ui">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setUserOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Glyph part={part} />
        <span className="min-w-0 truncate">
          {commandFailure ? (
            <>
              <span className="font-mono">{object}</span> exited with code {exit}
            </>
          ) : (
            <>
              {running ? <Shimmer as="span">{verb}</Shimmer> : verb}{" "}
              {row.kind === "run-command" ? (
                running ? (
                  <Shimmer as="span" className="font-mono">
                    {object}
                  </Shimmer>
                ) : (
                  <span className="font-mono">{object}</span>
                )
              ) : (
                <Path value={object} running={running} />
              )}
            </>
          )}
        </span>
        {meta && !commandFailure ? (
          <span className={cn("shrink-0 text-muted-foreground", metaAtEnd && "ml-auto")}>
            {meta}
          </span>
        ) : null}
        {expandable ? (
          <CaretRightIcon
            aria-hidden
            className={cn("size-3 shrink-0 text-muted-foreground", open && "rotate-90")}
          />
        ) : null}
      </button>
      {error ? (
        <pre className="ml-6 max-h-48 overflow-auto rounded-md border border-destructive/30 bg-destructive/10 p-2 font-mono text-ui whitespace-pre-wrap text-destructive">
          {error}
        </pre>
      ) : null}
      {open && output && !error ? (
        <div className="ml-6">
          <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-ui whitespace-pre-wrap">
            {lines.slice(-6).join("\n")}
          </pre>
          {hidden ? (
            <div className="py-1 text-muted-foreground">
              +{hidden} {hidden === 1 ? "line" : "lines"} · model saw{" "}
              {part.toolCallId === longOutput.toolCallId ? "less" : "all"}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
function V2Bundle({
  parts,
  summary,
  rail,
  metaAtEnd,
  initialOpen = false,
}: {
  parts: readonly DynamicToolUIPart[];
  summary: string;
  rail: boolean;
  metaAtEnd: boolean;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(initialOpen);
  const running = parts.some((part) => ["running", "pending"].includes(activityStatus(part)));
  const failed = parts.some(
    (part) =>
      activityStatus(part) === "failed" || (activityDescriptor(part).outcome?.exitCode ?? 0) !== 0,
  );
  const Icon = failed ? XCircleIcon : running ? SpinnerGapIcon : CheckCircleIcon;
  return (
    <div className="text-ui">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-sm py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            failed ? "text-destructive" : "text-muted-foreground",
            running && "animate-spin motion-reduce:animate-none",
          )}
        />
        {running ? <Shimmer as="span">{summary}</Shimmer> : <span>{summary}</span>}
        <CaretRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 text-muted-foreground", open && "rotate-90")}
        />
      </button>
      <div
        hidden={!open}
        className={cn(
          "max-h-96 space-y-1 overflow-auto",
          rail && "ml-2 border-l border-border pl-4",
        )}
      >
        {parts.map((part) => (
          <V2Row key={part.toolCallId} part={part} metaAtEnd={metaAtEnd} />
        ))}
      </div>
    </div>
  );
}
function Comparison({
  label,
  shipped,
  children,
}: React.PropsWithChildren<{ label: string; shipped: React.ReactNode }>) {
  return (
    <section className="space-y-2">
      <h2 className="text-label uppercase text-muted-foreground">{label}</h2>
      <div className="grid grid-cols-2 gap-6">
        <div className="min-w-0">{shipped}</div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

function LiveCommand({ metaAtEnd }: { metaAtEnd: boolean }) {
  const [tick, setTick] = React.useState(0);
  const [replay, setReplay] = React.useState(0);
  const [ending, setEnding] = React.useState<"running" | "done" | "failed">("running");
  React.useEffect(() => {
    if (ending !== "running") return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [ending]);
  const lines = [
    " RUN  v4.1.11",
    " ✓ activity.test.ts (42)",
    " ✓ fold.test.ts (18)",
    " ✓ session.test.ts (31)",
    " ✓ transcript.test.ts (27)",
    " ✓ tools.test.ts (12)",
    " ✓ stream.test.ts (9)",
    " Test Files  6 passed (6)",
  ];
  const output = lines.slice(0, Math.min(lines.length, tick)).join("\n");
  const stamped = descriptor("run-command", "vp run -r test", {
    endedAt: ending === "running" ? null : tick * 1000,
    outcome: ending === "running" ? null : outcome({ exitCode: ending === "done" ? 0 : 1 }),
  });
  const base = {
    type: "dynamic-tool" as const,
    toolName: liveBase.toolName,
    toolCallId: liveBase.toolCallId,
    input: null,
    toolMetadata: { [ACTIVITY_METADATA_KEY]: stamped } as DynamicToolUIPart["toolMetadata"],
  };
  const part: DynamicToolUIPart =
    ending === "running" && !output
      ? { ...base, state: "input-available" }
      : {
          ...base,
          state: "output-available",
          output: ending === "failed" ? `${output}\n1 failed` : output,
          preliminary: ending === "running",
        };
  return (
    <>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setTick(0);
            setReplay((value) => value + 1);
            setEnding("running");
          }}
        >
          Replay
        </Button>
        <Button size="xs" variant="outline" onClick={() => setEnding("done")}>
          Succeed
        </Button>
        <Button size="xs" variant="outline" onClick={() => setEnding("failed")}>
          Fail
        </Button>
      </div>
      <Comparison label="Live command · simulated wiring" shipped={<ToolRow part={part} />}>
        <V2Row key={replay} part={part} metaAtEnd={metaAtEnd} liveSeconds={tick} />
      </Comparison>
    </>
  );
}
export default function ToolCallV2Scratch() {
  const [rail, setRail] = React.useState(false);
  const [metaAtEnd, setMetaAtEnd] = React.useState(false);
  const liveParts = [...explore.slice(0, 3), liveBase];
  return (
    <div className="mx-auto flex w-full max-w-workbench flex-col gap-6 px-gutter py-8 pb-16">
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant={rail ? "outline" : "secondary"} onClick={() => setRail(false)}>
          No rail
        </Button>
        <Button size="xs" variant={rail ? "secondary" : "outline"} onClick={() => setRail(true)}>
          Guide rail
        </Button>
        <Button
          size="xs"
          variant={!metaAtEnd ? "secondary" : "outline"}
          onClick={() => setMetaAtEnd(false)}
        >
          Meta beside title
        </Button>
        <Button
          size="xs"
          variant={metaAtEnd ? "secondary" : "outline"}
          onClick={() => setMetaAtEnd(true)}
        >
          Meta at edge
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-6 text-label uppercase text-muted-foreground">
        <div>Shipped</div>
        <div>v2</div>
      </div>
      <Comparison
        label="Settled rows"
        shipped={
          <>
            {[...checks, explore[0], search, list, edit, write, longOutput].map((part) => (
              <ToolRow key={part.toolCallId} part={part} />
            ))}
          </>
        }
      >
        {[...checks, explore[0], search, list, edit, write, longOutput].map((part) => (
          <V2Row key={part.toolCallId} part={part} metaAtEnd={metaAtEnd} />
        ))}
      </Comparison>
      <Comparison
        label="In flight"
        shipped={
          <>
            <ToolRow part={pending} />
            <ToolRow part={editing} />
          </>
        }
      >
        <V2Row part={pending} metaAtEnd={metaAtEnd} />
        <V2Row part={editing} metaAtEnd={metaAtEnd} />
      </Comparison>
      <Comparison
        label="Failures"
        shipped={
          <>
            <ToolRow part={failedCommand} />
            <ToolRow part={missing} />
            <ActivityBundle rows={failedBundle} />
          </>
        }
      >
        <V2Row part={failedCommand} metaAtEnd={metaAtEnd} />
        <V2Row part={missing} metaAtEnd={metaAtEnd} />
        <V2Bundle
          parts={[...explore.slice(0, 2), missing]}
          summary="Worked for 12s · 1 failure"
          rail={rail}
          metaAtEnd={metaAtEnd}
          initialOpen
        />
      </Comparison>
      <Comparison label="Settled group" shipped={<ActivityBundle rows={settledBundle} />}>
        <V2Bundle
          parts={settled}
          summary="Worked for 1m 12s · edited 2 files · ran 3 commands"
          rail={rail}
          metaAtEnd={metaAtEnd}
        />
      </Comparison>
      <Comparison
        label="Exploration group"
        shipped={<ActivityBundle rows={bundle(explore.slice(0, 6))} />}
      >
        <V2Bundle
          parts={explore.slice(0, 6)}
          summary="Explored 3 files"
          rail={rail}
          metaAtEnd={metaAtEnd}
        />
      </Comparison>
      <Comparison label="Live group" shipped={<ActivityBundle rows={bundle(liveParts)} />}>
        <V2Bundle
          parts={liveParts}
          summary="Exploring · running 1 command"
          rail={rail}
          metaAtEnd={metaAtEnd}
        />
      </Comparison>
      <Comparison label="Open group · height cap" shipped={<ActivityBundle rows={tallBundle} />}>
        <V2Bundle
          parts={tall}
          summary="Working · edited 2 files · ran 6 commands"
          rail={rail}
          metaAtEnd={metaAtEnd}
          initialOpen
        />
      </Comparison>
      <LiveCommand metaAtEnd={metaAtEnd} />
    </div>
  );
}
