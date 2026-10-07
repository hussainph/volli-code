import type { HostLogEntry, LogRecord } from "@volli/shared";

import { registerRemoteLogSource, type LogSource } from "@renderer/components/logs/log-sources";
import { LogStream, LogViewer } from "@renderer/components/logs/log-viewer";

export const title = "Log viewer (VC-699)";
export const note =
  "This Mac and a remote box in one stream; follow the Add-a-host trace across both";

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
const box = fixedSource("box", "box.tail", BOX);

// The box is a registered remote source, as the "Add a host" flow registers one.
registerRemoteLogSource(box);

export default function LogViewerScratch() {
  return (
    <div className="flex h-[720px] flex-col gap-6 p-6">
      <div className="flex min-h-0 flex-1 flex-col">
        <LogViewer local={mac} />
      </div>
      <div className="h-40 rounded-card border border-border p-2">
        <LogStream className="h-full" local={mac} filter={{ component: "ssh-install" }} />
      </div>
    </div>
  );
}
