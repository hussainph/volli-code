import * as React from "react";
import type { HostLinkRelayEvent, HostLogEntry, HostLogsBatch, LogRecord } from "@volli/shared";

import type { LogSource } from "@renderer/components/logs/log-sources";
import { LogStream, LogViewer } from "@renderer/components/logs/log-viewer";
import { attachRemoteLogSources, relayLogLink } from "@renderer/components/logs/remote-log-sources";
import { Button } from "@renderer/components/ui/button";
import type { RelayHostLinkRpc } from "@renderer/lib/relay-host-link";
import type { HostLinkView } from "@renderer/stores/host-connection";

export const title = "Log viewer (VC-699, VC-712)";
export const note =
  "This Mac and a remote box in one stream, the box over the Workspace link relay; follow the Add-a-host trace across both";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SESSION = "9c585826-3d34-408e-9ebf-d58ecaaad6a7";
const T0 = Date.parse("2026-10-07T09:15:00.000Z");

function at(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

function entries(
  lines: [number, Partial<LogRecord> & Pick<LogRecord, "component" | "msg">][],
): HostLogEntry[] {
  return lines.map(([ms, record], index) => ({
    cursor: `fixture:${index + 1}`,
    record: { ts: at(ms), level: "info", ...record } as LogRecord,
  }));
}

/** What this Mac logged while the person added a box and ran a ticket on it. */
const MAC = entries([
  [0, { component: "ssh-install", msg: "install started", traceId: TRACE, host: "box" }],
  [40, { component: "ssh-install", msg: "step started", step: "probe", traceId: TRACE }],
  [
    610,
    { component: "ssh-install", msg: "step done", step: "probe", durationMs: 570, traceId: TRACE },
  ],
  [620, { component: "ssh-install", msg: "step started", step: "upload", traceId: TRACE }],
  [
    4210,
    {
      component: "ssh-install",
      msg: "step done",
      step: "upload",
      durationMs: 3590,
      traceId: TRACE,
    },
  ],
  [
    4300,
    { component: "ssh-install", msg: "step done", step: "unit", durationMs: 80, traceId: TRACE },
  ],
  [
    5100,
    { component: "ssh-install", msg: "step done", step: "pair", durationMs: 790, traceId: TRACE },
  ],
  [
    5200,
    {
      component: "renderer:host-link",
      msg: "link state",
      from: "connecting",
      to: "ready",
      traceId: TRACE,
    },
  ],
  [9000, { component: "rpc", level: "debug", msg: "rpc call", operation: "settings.experiments" }],
  [61000, { component: "power", msg: "system sleeping", reason: "suspend" }],
  [940000, { component: "power", msg: "system woke", reason: "resume" }],
  [940050, { component: "renderer:host-link", msg: "wake", cause: "power-resume", traceId: TRACE }],
  [
    940400,
    {
      component: "renderer:host-link",
      level: "warn",
      msg: "link state",
      from: "ready",
      to: "unreachable",
      reason: "host-unreachable",
      traceId: TRACE,
    },
  ],
  [
    941100,
    {
      component: "renderer:host-link",
      msg: "link state",
      from: "connecting",
      to: "ready",
      traceId: TRACE,
    },
  ],
  [
    941120,
    {
      component: "renderer:host-link",
      msg: "resubscribe",
      path: "session.subscribe",
      why: "welcome",
      traceId: TRACE,
    },
  ],
]);

/** What the box logged for the same operation, read over its host link's `host.logs`. */
const BOX = entries([
  [
    5180,
    {
      component: "hostd",
      msg: "host protocol: connected",
      connection: "8a9e7bf4",
      actor: "device",
      traceId: TRACE,
    },
  ],
  [
    7000,
    {
      component: "rpc",
      level: "debug",
      msg: "rpc call",
      operation: "sessions.create",
      traceId: TRACE,
      door: "websocket",
    },
  ],
  [
    7020,
    {
      component: "session",
      msg: "session session.created",
      sessionId: SESSION,
      ticketId: "VC-12",
      traceId: TRACE,
    },
  ],
  [
    7400,
    {
      component: "session",
      msg: "session command.recorded",
      sessionId: SESSION,
      intent: "message.submit",
      traceId: TRACE,
    },
  ],
  [
    7600,
    {
      component: "session",
      msg: "session turn.started",
      sessionId: SESSION,
      turnId: "t-1",
      traceId: TRACE,
    },
  ],
  [
    58000,
    {
      component: "publish",
      msg: "branch pushed",
      ticketId: "VC-12",
      branch: "volli/VC-12-mcp-server",
      traceId: TRACE,
    },
  ],
  [
    600000,
    {
      component: "follow-up",
      msg: "follow-up release claimed",
      sessionId: SESSION,
      reason: "idle-boundary",
      traceId: TRACE,
    },
  ],
  [
    600400,
    {
      component: "session",
      msg: "session turn.completed",
      sessionId: SESSION,
      turnId: "t-2",
      traceId: TRACE,
    },
  ],
  [
    940600,
    {
      component: "hostd",
      level: "info",
      msg: "host protocol: closed",
      connection: "8a9e7bf4",
      code: 1006,
    },
  ],
  [
    941050,
    { component: "hostd", msg: "host protocol: connected", connection: "1c2d3e4f", traceId: TRACE },
  ],
]);

function fixedSource(id: string, label: string, lines: HostLogEntry[]): LogSource {
  return {
    id,
    label,
    start(handlers) {
      handlers.onStatus("live");
      handlers.onLines(lines, false);
      return () => undefined;
    },
  };
}

const mac = fixedSource("this-mac", "This Mac", MAC);

/* ── The box, over the Workspace link relay (VC-712) ─────────────────────── */

const BOX_HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const BOX_PROJECT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OPEN: HostLinkView = { status: "open" };
const FULL = {
  code: "TOO_MANY_REQUESTS",
  reason: "subscription-limit",
  message:
    "This project’s link carries as many live views as it can; this one waits for a free one.",
};

/**
 * The box as main's relay answers for it: its recent log (the fixture, then a
 * line every two seconds) behind `hostLink.query` and `hostLink.subscribe`,
 * with the relay's own event shapes. "Fill the link" makes the relay refuse
 * the log's stream (`subscription-limit`, AM1), so the source polls; "Drop
 * the link" takes the project's link down, so the dot says so.
 */
/** The line a lab box cursor names: `box:<seq>`. */
function seqOf(cursor: unknown): number {
  return typeof cursor === "string" && cursor.startsWith("box:") ? Number(cursor.slice(4)) : 0;
}

function labBox() {
  const lines: HostLogEntry[] = BOX.map(({ record }, index) => ({
    cursor: `box:${index + 1}`,
    record,
  }));
  const followers = new Set<(line: HostLogEntry) => void>();
  const streams = new Set<() => void>();
  const listeners = new Set<() => void>();
  let link: HostLinkView = OPEN;
  let full = false;
  const after = (cursor: unknown) => lines.filter((line) => seqOf(line.cursor) > seqOf(cursor));
  const batch = (held: HostLogEntry[]): HostLogsBatch => ({
    entries: held,
    gap: false,
    cursor: lines.at(-1)!.cursor,
  });
  let tick = 0;
  /** A heartbeat line every two seconds, while the scratch is mounted. */
  const beat = () => {
    tick += 1;
    const line: HostLogEntry = {
      cursor: `box:${lines.length + 1}`,
      record: {
        ts: new Date().toISOString(),
        level: tick % 5 === 0 ? "warn" : "info",
        component: "hostd",
        msg: tick % 3 === 0 ? "ログ — ünïcödé heartbeat ✓" : "heartbeat",
        tick,
      } as LogRecord,
    };
    lines.push(line);
    for (const follower of followers) follower(line);
  };
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const subscribeChanges = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const rpc = {
    hostLink: {
      query: {
        query: async ({ input }: { input?: { after?: string; limit?: number } }) => {
          if (link.status !== "open")
            throw new Error("The project’s host can’t be reached right now.");
          const unread = input?.after === undefined ? lines : after(input.after);
          return batch(unread.slice(-(input?.limit ?? 500)));
        },
      },
      mutate: { mutate: async () => undefined },
      subscribe: {
        subscribe: (
          { input, lastEventId }: { input?: { after?: string }; lastEventId?: string },
          handlers: { onData(event: HostLinkRelayEvent): void },
        ) => {
          if (full) {
            queueMicrotask(() => handlers.onData({ kind: "error", error: FULL }));
            return { unsubscribe: () => undefined };
          }
          const follower = (line: HostLogEntry) =>
            handlers.onData({ kind: "data", data: batch([line]), id: line.cursor });
          const end = (event: HostLinkRelayEvent) => {
            followers.delete(follower);
            streams.delete(stop);
            handlers.onData(event);
          };
          const stop = () => end(link.status === "open" ? { kind: "error", error: FULL } : LOST);
          queueMicrotask(() => {
            handlers.onData({ kind: "started" });
            const backlog = after(lastEventId ?? input?.after);
            if (backlog.length > 0) {
              handlers.onData({ kind: "data", data: batch(backlog), id: backlog.at(-1)!.cursor });
            }
            followers.add(follower);
            streams.add(stop);
          });
          return {
            unsubscribe: () => {
              followers.delete(follower);
              streams.delete(stop);
            },
          };
        },
      },
    },
  };
  return {
    // The lab's stand-in for the window's client: only the relay's slice is served.
    rpc: rpc as unknown as RelayHostLinkRpc,
    hosts: {
      getState: () => ({
        hosts: [
          {
            id: BOX_HOST,
            name: "box.tail",
            local: false,
            os: "linux" as const,
            version: "0.3.0",
            link: link.status === "open" ? OPEN : link,
            liveSessions: 1,
            update: null,
            expiredSignIns: [],
          },
        ],
        projects: {
          [BOX_PROJECT]: {
            hostId: BOX_HOST,
            link,
            ...(link.status === "open" ? { granted: ["sign-ins", "host.logs"] } : {}),
          },
        },
      }),
      subscribe: subscribeChanges,
    },
    state: { getState: () => link, subscribe: subscribeChanges },
    setFull(next: boolean) {
      full = next;
      // A foreground view takes the log's slot: its stream yields.
      if (full) for (const stop of Array.from(streams)) stop();
      changed();
    },
    setDropped(dropped: boolean) {
      link = dropped ? { status: "reconnecting" } : OPEN;
      if (dropped) for (const stop of Array.from(streams)) stop();
      changed();
    },
    start() {
      const timer = setInterval(beat, 2_000);
      return () => clearInterval(timer);
    },
  };
}

const LOST: HostLinkRelayEvent = {
  kind: "lost",
  error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Dropped." },
};

/** The box registered as production registers it: the host-connection state, the relay. */
function useLabBox() {
  const [box] = React.useState(labBox);
  React.useEffect(() => {
    const detach = attachRemoteLogSources({
      hosts: box.hosts,
      link: (workspaceId) =>
        relayLogLink(workspaceId, { rpc: box.rpc, state: box.state, resumeDelaysMs: [250, 1_000] }),
      timing: { pollMs: 2_000, pollsPerFollowRetry: 5 },
    });
    const stop = box.start();
    return () => {
      detach();
      stop();
    };
  }, [box]);
  return box;
}

export default function LogViewerScratch() {
  const box = useLabBox();
  const [full, setFull] = React.useState(false);
  const [dropped, setDropped] = React.useState(false);
  return (
    <div className="flex h-[760px] flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          aria-pressed={full}
          onClick={() => {
            box.setFull(!full);
            setFull(!full);
          }}
        >
          {full ? "Free the box’s link" : "Fill the box’s link"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={dropped}
          onClick={() => {
            box.setDropped(!dropped);
            setDropped(!dropped);
          }}
        >
          {dropped ? "Reconnect the box" : "Drop the box’s link"}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <LogViewer local={mac} />
      </div>
      <div className="h-40 rounded-card border border-border p-2">
        <LogStream className="h-full" local={mac} filter={{ component: "ssh-install" }} />
      </div>
    </div>
  );
}
