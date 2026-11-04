/**
 * The dev log viewer (VC-699): this Mac's log and every connected host's, in
 * one time-ordered stream.
 *
 * Each line names the machine that wrote it. Filter by level, source,
 * component, trace, Session, ticket or any text; select a trace on any line
 * to follow that one operation across every machine it touched, in time
 * order. Pause holds the view while lines keep arriving; Copy and Export
 * write what is shown as JSON lines.
 *
 * Shown in dev builds, and in product builds only with the `cloud`
 * experiment on ({@link useLogViewerEnabled}). Nothing here writes anything.
 * {@link LogStream} is the same stream under a fixed filter, for a surface
 * that wants one operation's lines (the "Add a host over SSH" checklist's
 * Details, VC-700).
 */
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import * as React from "react";
import { errorMessage, LOG_LEVELS, type HostLogEntry, type LogLevel } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@renderer/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@renderer/components/ui/select";
import { Spinner } from "@renderer/components/ui/spinner";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

import { localLogSource, useLogSources, type LogSource, type LogSourceStatus } from "./log-sources";
import {
  clockOf,
  componentsOf,
  EMPTY_FILTER,
  filterLines,
  linesOf,
  mergeLines,
  recordFields,
  ROW_ID_FIELDS,
  toJsonl,
  traceSummary,
  VIEWER_RENDER_CAP,
  type LogFilter,
  type ViewerLine,
} from "./log-viewer-model";

/* ---------------------------------------------------------------- gating */

/**
 * Dev builds always; a product build only with the `cloud` experiment on.
 * The experiment is the host's (`settings.experiments`), read once.
 */
export function useLogViewerEnabled(): boolean {
  const [cloud, setCloud] = React.useState(false);
  React.useEffect(() => {
    if (import.meta.env.DEV) return;
    let live = true;
    void sessionRpcClient()
      .settings.experiments.query()
      .then(
        (snapshot) => {
          if (live) setCloud(snapshot.cloud.enabled);
        },
        // Work no one asked for: with no answer the viewer stays hidden.
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, []);
  return import.meta.env.DEV || cloud;
}

/* ----------------------------------------------------------------- state */

interface SourceView {
  readonly status: LogSourceStatus;
  readonly detail?: string;
  /** Lines this source said it could not send (evicted, or its host restarted). */
  readonly gaps: number;
}

/** Every source started, its lines merged; `paused` holds the view, never the reading. */
function useLogLines(sources: readonly LogSource[], paused: boolean) {
  const held = React.useRef<ViewerLine[]>([]);
  const [lines, setLines] = React.useState<readonly ViewerLine[]>([]);
  const [views, setViews] = React.useState<Readonly<Record<string, SourceView>>>({});
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;
  const scheduled = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const publish = React.useCallback(() => {
    if (scheduled.current !== null || pausedRef.current) return;
    // A burst of batches is one render.
    scheduled.current = setTimeout(() => {
      scheduled.current = null;
      if (!pausedRef.current) setLines(held.current);
    }, 100);
  }, []);

  React.useEffect(() => {
    if (!paused) setLines(held.current);
  }, [paused]);

  const restart = React.useRef<(id: string) => void>(() => {});
  const retry = React.useCallback((id: string) => restart.current(id), []);

  React.useEffect(() => {
    const stops = new Map<string, () => void>();
    const start = (source: LogSource) => {
      setViews((all) => ({
        ...all,
        [source.id]: { status: "connecting", gaps: all[source.id]?.gaps ?? 0 },
      }));
      stops.set(
        source.id,
        source.start({
          onLines: (entries: readonly HostLogEntry[], gap: boolean) => {
            held.current = mergeLines(held.current, linesOf(source.id, entries));
            if (gap) {
              setViews((all) => ({
                ...all,
                [source.id]: {
                  ...(all[source.id] ?? { status: "live" }),
                  gaps: (all[source.id]?.gaps ?? 0) + 1,
                },
              }));
            }
            publish();
          },
          onStatus: (status, detail) =>
            setViews((all) => ({
              ...all,
              [source.id]: {
                status,
                ...(detail === undefined ? {} : { detail }),
                gaps: all[source.id]?.gaps ?? 0,
              },
            })),
        }),
      );
    };
    for (const source of sources) start(source);
    restart.current = (id) => {
      const source = sources.find((candidate) => candidate.id === id);
      if (!source) return;
      stops.get(id)?.();
      start(source);
    };
    return () => {
      restart.current = () => {};
      for (const stop of stops.values()) stop();
    };
  }, [sources, publish]);

  React.useEffect(
    () => () => {
      if (scheduled.current !== null) clearTimeout(scheduled.current);
      // A remount (React's StrictMode does one in development) must be able
      // to schedule again: a cleared timer left here would hold every later
      // batch back from the screen.
      scheduled.current = null;
    },
    [],
  );

  return { lines, views, retry };
}

const DOT: Record<LogSourceStatus, StatusDotState> = {
  connecting: "starting",
  live: "ready",
  failed: "error",
};

const LEVEL_TONE: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-attention",
  error: "text-destructive",
};

const LEVEL_OPTIONS = LOG_LEVELS.map((level) => ({
  key: level,
  label: level[0]!.toUpperCase() + level.slice(1),
}));

/* ------------------------------------------------------------- the rows */

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function LogRow({
  line,
  sourceLabel,
  showSource,
  foldSource,
  onFilter,
}: {
  line: ViewerLine;
  sourceLabel: string;
  showSource: boolean;
  /** Name the machine under a narrow row: only when the stream holds more than one. */
  foldSource: boolean;
  onFilter(field: "traceId" | "sessionId" | "ticketId" | "component", value: string): void;
}) {
  const [open, setOpen] = React.useState(false);
  const { record } = line;
  const fields = recordFields(record);
  return (
    <li
      className="border-b border-border/50 text-ui"
      data-testid="log-row"
      data-level={record.level}
    >
      <div className="grid grid-cols-2 items-baseline gap-2 px-4 py-2 hover:bg-muted/40 @sm/logs:grid-cols-[6rem_4rem_minmax(0,1fr)] @2xl/logs:grid-cols-[6rem_4rem_8rem_minmax(0,1fr)] @4xl/logs:grid-cols-[6rem_4rem_8rem_7rem_minmax(0,1fr)]">
        <span className="font-mono text-muted-foreground tabular-nums">{clockOf(record.ts)}</span>
        <span className={cn("w-10 shrink-0", LEVEL_TONE[record.level])}>{record.level}</span>
        <button
          type="button"
          className="hidden truncate text-left text-muted-foreground hover:text-foreground @2xl/logs:block"
          title={record.component}
          onClick={() => onFilter("component", record.component)}
        >
          {record.component}
        </button>
        {showSource ? (
          <span
            className="hidden truncate text-muted-foreground @4xl/logs:block"
            title={sourceLabel}
          >
            {sourceLabel}
          </span>
        ) : (
          <span className="hidden @4xl/logs:block" />
        )}
        <button
          type="button"
          className="col-span-2 min-w-0 text-left [overflow-wrap:anywhere] @sm/logs:col-span-1"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {record.msg}
        </button>
        <span className="col-span-full flex flex-wrap gap-1">
          {/* A narrow pane folds the Component and Source columns under the
              message instead of dropping them: in a stream that interleaves
              several machines, a line that no longer names its machine (or
              its component) is ambiguous. Each folded value hides at the width
              where its own column appears, so a row says each once. */}
          <span
            className={cn(
              "mr-1 flex min-w-0 items-baseline gap-2 text-label text-muted-foreground",
              foldSource ? "@4xl/logs:hidden" : "@2xl/logs:hidden",
            )}
          >
            {foldSource ? (
              <span className="truncate" title={sourceLabel}>
                {sourceLabel}
              </span>
            ) : null}
            <button
              type="button"
              className="truncate text-left hover:text-foreground @2xl/logs:hidden"
              title={record.component}
              onClick={() => onFilter("component", record.component)}
            >
              {record.component}
            </button>
          </span>
          {ROW_ID_FIELDS.map((field) => {
            const value = record[field];
            if (typeof value !== "string") return null;
            const filterable = field === "traceId" || field === "sessionId" || field === "ticketId";
            return (
              <button
                key={field}
                type="button"
                disabled={!filterable}
                title={`${field} ${value}`}
                className="rounded-control border border-border px-2 font-mono text-label text-muted-foreground enabled:hover:text-foreground"
                onClick={() => {
                  if (filterable) onFilter(field, value);
                }}
              >
                {field.replace(/Id$/u, "")} {shortId(value)}
              </button>
            );
          })}
        </span>
      </div>
      {open ? (
        <pre className="overflow-x-auto bg-muted/30 px-2 py-1 whitespace-pre-wrap text-muted-foreground">
          {JSON.stringify(
            {
              // A column or its folded line can truncate; the disclosure keeps
              // their full values available alongside the record's fields.
              ...(showSource ? { source: sourceLabel } : {}),
              component: record.component,
              ...fields,
            },
            null,
            2,
          )}
        </pre>
      ) : null}
    </li>
  );
}

function LogRows({
  lines,
  labels,
  showSource,
  onFilter,
  empty,
}: {
  lines: readonly ViewerLine[];
  labels: ReadonlyMap<string, string>;
  showSource: boolean;
  onFilter(field: "traceId" | "sessionId" | "ticketId" | "component", value: string): void;
  empty: string;
}) {
  const shown =
    lines.length > VIEWER_RENDER_CAP ? lines.slice(lines.length - VIEWER_RENDER_CAP) : lines;
  if (shown.length === 0) return <p className={EMPTY_INLINE}>{empty}</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-container border border-border bg-card">
      <div className="sticky top-0 grid grid-cols-2 gap-2 border-b border-border bg-card px-4 py-2 text-ui font-medium text-muted-foreground @sm/logs:grid-cols-[6rem_4rem_minmax(0,1fr)] @2xl/logs:grid-cols-[6rem_4rem_8rem_minmax(0,1fr)] @4xl/logs:grid-cols-[6rem_4rem_8rem_7rem_minmax(0,1fr)]">
        <span>Time</span>
        <span>Level</span>
        <span className="hidden @2xl/logs:block">Component</span>
        <span className="hidden @4xl/logs:block">Source</span>
        <span className="hidden @sm/logs:block">Message</span>
      </div>
      <ol data-testid="log-rows">
        {shown.map((line) => (
          <LogRow
            key={line.key}
            line={line}
            sourceLabel={labels.get(line.source) ?? line.source}
            showSource={showSource}
            foldSource={showSource && labels.size > 1}
            onFilter={onFilter}
          />
        ))}
      </ol>
    </div>
  );
}

/* ----------------------------------------------------------- the viewer */

async function copyLines(lines: readonly ViewerLine[]): Promise<void> {
  try {
    await navigator.clipboard.writeText(toJsonl(lines));
  } catch (error) {
    toastError(`Couldn't copy the log: ${errorMessage(error)}`);
  }
}

function exportLines(lines: readonly ViewerLine[]): void {
  const url = URL.createObjectURL(
    new Blob([`${toJsonl(lines)}\n`], { type: "application/x-ndjson" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `volli-log-${new Date().toISOString().replaceAll(":", "-")}.jsonl`;
  anchor.click();
  URL.revokeObjectURL(url);
}

const FILTER_INPUTS = [
  { field: "traceId", label: "Trace" },
  { field: "sessionId", label: "Session" },
  { field: "ticketId", label: "Ticket" },
  { field: "component", label: "Component" },
] as const;

/** The whole viewer: Settings → System → Logs. */
export function LogViewer({ local = defaultLocalSource }: { local?: LogSource } = {}) {
  const sources = useLogSources(local);
  const [paused, setPaused] = React.useState(false);
  const [filter, setFilter] = React.useState<LogFilter>(EMPTY_FILTER);
  const { lines, views, retry } = useLogLines(sources, paused);
  const labels = React.useMemo(
    () => new Map(sources.map((source) => [source.id, source.label])),
    [sources],
  );
  const shown = React.useMemo(() => filterLines(lines, filter), [lines, filter]);
  const components = React.useMemo(() => componentsOf(lines), [lines]);
  const trace = filter.traceId === "" ? null : traceSummary(lines, filter.traceId);
  const set = <Field extends keyof LogFilter>(field: Field, value: LogFilter[Field]) =>
    setFilter((current) => ({ ...current, [field]: value }));

  return (
    <div className="@container/logs flex min-h-0 flex-1 flex-col gap-4" data-testid="log-viewer">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1" role="group" aria-label="Sources">
          {sources.map((source) => {
            const view = views[source.id];
            const active = filter.source === source.id;
            return (
              <Button
                key={source.id}
                size="sm"
                variant={active ? "secondary" : "ghost"}
                aria-pressed={active}
                title={
                  view?.detail ??
                  (view?.gaps ? `${view.gaps} gaps: lines this host no longer held` : undefined)
                }
                onClick={() => set("source", active ? "" : source.id)}
              >
                {view === undefined || view.status === "connecting" ? (
                  <Spinner />
                ) : (
                  <StatusDot state={DOT[view.status]} />
                )}
                {source.label}
              </Button>
            );
          })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void copyLines(shown)}>
            <CopyIcon />
            Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => exportLines(shown)}>
            <DownloadSimpleIcon />
            Export
          </Button>
        </span>
      </div>
      <InputGroup>
        <InputGroupAddon>
          <MagnifyingGlassIcon />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search logs"
          placeholder="Search logs"
          value={filter.text}
          onChange={(event) => set("text", event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="Filter logs">
                <FunnelIcon />
                Filters
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-4 p-4"
            >
              <label className="flex flex-col gap-1 text-ui font-medium">
                Minimum level
                <Select
                  value={filter.minLevel}
                  onValueChange={(level) => set("minLevel", level as LogLevel)}
                >
                  <SelectTrigger aria-label="Minimum level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVEL_OPTIONS.map(({ key, label }) => (
                      <SelectItem key={key} value={key}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-ui font-medium">
                Source
                <Select
                  value={filter.source || "all"}
                  onValueChange={(source) => set("source", source === "all" ? "" : source)}
                >
                  <SelectTrigger aria-label="Log source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    {sources.map((source) => (
                      <SelectItem key={source.id} value={source.id}>
                        {source.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {FILTER_INPUTS.map(({ field, label }) => (
                <label key={field} className="flex flex-col gap-1 text-ui font-medium">
                  {label}
                  <Input
                    aria-label={label}
                    list={field === "component" ? "log-components" : undefined}
                    value={filter[field]}
                    onChange={(event) => set(field, event.target.value.trim())}
                    className={field === "component" ? "" : "font-mono"}
                  />
                </label>
              ))}
              <datalist id="log-components">
                {components.map((component) => (
                  <option key={component} value={component} />
                ))}
              </datalist>
            </PopoverContent>
          </Popover>
          {Object.keys(EMPTY_FILTER).some(
            (key) => filter[key as keyof LogFilter] !== EMPTY_FILTER[key as keyof LogFilter],
          ) && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear filters"
              onClick={() => setFilter(EMPTY_FILTER)}
            >
              <XIcon />
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>
      <div className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
        <span>
          {shown.length} of {lines.length} lines
        </span>
        {Object.entries(filter)
          .filter(([key, value]) => value !== EMPTY_FILTER[key as keyof LogFilter])
          .map(([key, value]) => (
            <Button
              key={key}
              variant="outline"
              size="xs"
              onClick={() =>
                setFilter((current) => ({
                  ...current,
                  [key]: EMPTY_FILTER[key as keyof LogFilter],
                }))
              }
            >
              {key === "minLevel" ? "Level" : key === "text" ? "Search" : key.replace(/Id$/u, "")}:{" "}
              {labels.get(value) ?? value}
              <XIcon />
            </Button>
          ))}
      </div>
      {trace !== null ? (
        <p className="text-ui text-muted-foreground" data-testid="trace-summary">
          {`Trace ${shortId(filter.traceId)} · ${trace.lines} lines · ${
            trace.sources.map((id) => labels.get(id) ?? id).join(" → ") || "no source yet"
          }${trace.durationMs === null ? "" : ` · ${(trace.durationMs / 1000).toFixed(2)} s`}`}
        </p>
      ) : null}
      {sources
        .filter((source) => views[source.id]?.status === "failed")
        .map((source) => (
          <Notice
            key={source.id}
            tone="error"
            announce
            title={`Couldn't read ${source.label} logs`}
            actions={
              <Button size="xs" variant="outline" onClick={() => retry(source.id)}>
                <ArrowClockwiseIcon />
                Retry
              </Button>
            }
          />
        ))}
      {lines.length === 0 &&
      sources.some(
        (source) => views[source.id] === undefined || views[source.id]?.status === "connecting",
      ) ? (
        <div
          role="status"
          aria-label="Reading logs"
          className="flex flex-col gap-2 rounded-container border border-border bg-card p-4"
        >
          <Skeleton aria-hidden className="h-4 w-3/4" />
          <Skeleton aria-hidden className="h-4 w-1/2" />
        </div>
      ) : lines.length === 0 &&
        sources.some((source) => views[source.id]?.status === "failed") ? null : (
        <LogRows
          lines={shown}
          labels={labels}
          showSource
          onFilter={(field, value) => set(field, value)}
          empty={lines.length === 0 ? "No lines" : "No lines match"}
        />
      )}
    </div>
  );
}

const defaultLocalSource = localLogSource();

/**
 * One operation's lines, live: the viewer's stream under a fixed filter, with
 * no controls. For a surface that shows what one flow did, such as the
 * "Add a host over SSH" checklist's Details (VC-700), which passes the trace
 * id it minted when the person pressed Add.
 */
export function LogStream({
  filter,
  local = defaultLocalSource,
  className,
}: {
  filter: Partial<LogFilter>;
  local?: LogSource;
  className?: string;
}) {
  const sources = useLogSources(local);
  const { lines } = useLogLines(sources, false);
  const fixed = React.useMemo(() => ({ ...EMPTY_FILTER, ...filter }), [filter]);
  const labels = React.useMemo(
    () => new Map(sources.map((source) => [source.id, source.label])),
    [sources],
  );
  const shown = React.useMemo(() => filterLines(lines, fixed), [lines, fixed]);
  return (
    <div
      className={cn("@container/logs flex min-h-0 flex-col", className)}
      data-testid="log-stream"
    >
      <LogRows
        lines={shown}
        labels={labels}
        showSource={sources.length > 1}
        onFilter={() => undefined}
        empty="Nothing logged yet"
      />
    </div>
  );
}
