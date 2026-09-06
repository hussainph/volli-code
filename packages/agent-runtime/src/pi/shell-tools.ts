/**
 * The three background shell tools, riding the one {@link RuntimeShellPort}
 * (VC-270).
 *
 * Three names for one capability, on ./browser-tools.ts's terms: a tool per
 * intent keeps each schema small and each call legible in the ledger, while
 * membership stays all-or-nothing because one port answers them all.
 *
 * What a background shell is: a command that runs BESIDE the turn. `execute`
 * holds the turn until the command exits or its timeout fires, so a dev
 * server, a watch build, a long test run or a log tail could not run at all
 * without blocking, backgrounding with `&` and losing the handle, or asking
 * the person to run it in a terminal. `shell_start` spawns it and comes back
 * after a settle window with whatever it printed; `shell_output` reads what
 * is NEW since the last read, so a poll loop costs the same context every
 * time rather than growing without bound; `shell_kill` ends it.
 *
 * The model knows what it has because every result here restates the
 * Session's live shells — id, state, age, command. The tool calls are the
 * durable record, and re-reading them is free (the owner ruled out a per-turn
 * prompt channel for this). What survives compaction is a named follow-up.
 *
 * Deliberately absent, as the port is deliberately narrow: no stdin, no PTY,
 * no restart verb, no filter on reads. A shell a person types into is the
 * terminal, not this.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import {
  shellCommandLine,
  shellStanding,
  type NonCodingToolId,
  type RuntimeShellOutputOutcome,
  type RuntimeShellPort,
  type RuntimeShellRecord,
  type RuntimeShellState,
} from "@volli/shared";
import { ShellRefusal } from "../shell/refusal";

/** The vocabulary's shell half, in the order the surface offers it. */
export const SHELL_TOOL_NAMES = [
  "shell_start",
  "shell_output",
  "shell_kill",
] as const satisfies readonly NonCodingToolId[];

export type ShellToolId = (typeof SHELL_TOOL_NAMES)[number];

/**
 * The structured half of every shell result, beside the text the model
 * reads: what `pi/activity.ts` names a row by and reads an exit code off,
 * so the transcript never parses the prose. JSON-safe by construction.
 */
export interface ShellToolDetails {
  shellId: string;
  command: string;
  state: RuntimeShellState;
  exitCode: number | null;
}

function detailsOf(shell: RuntimeShellRecord): ShellToolDetails {
  return {
    shellId: shell.shellId,
    command: shell.command,
    state: shell.state,
    exitCode: shell.code,
  };
}

/**
 * The per-Session cap on RUNNING shells, restated in the held-shells footer
 * so the model can see how close it is before a start is refused. The one
 * number: the desktop's host imports this constant and enforces it against
 * the Session's running shells, so there is no second copy to drift.
 */
export const SHELL_MAX_PER_SESSION = 4;

/** How long a command's first line is allowed to be in a listing. */
const COMMAND_LINE_LIMIT = 80;

/** The shared one-line name, bounded to what a result can afford to spend on it. */
function firstLine(command: string): string {
  const line = shellCommandLine(command);
  return line.length > COMMAND_LINE_LIMIT ? `${line.slice(0, COMMAND_LINE_LIMIT - 1)}…` : line;
}

/**
 * Bytes, not UTF-16 code units. Every bound this tool states is a byte bound
 * — the ring, the tail cap — so the sizes it reports must be bytes too, or a
 * model reading a multi-byte log would be told a number that matches nothing
 * it was promised.
 */
function bytesOf(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** An age as the model reads it: seconds under a minute, then minutes, then hours. */
function age(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** The name a shell is listed by: its title when the model gave one, else its command's first line. */
function label(shell: RuntimeShellRecord): string {
  return shell.title ?? firstLine(shell.command);
}

/**
 * The held-shells footer every result carries (§4): id, state, age, label —
 * one line each, so the model can see what it holds without a prompt channel
 * telling it.
 *
 * The count states RUNNING against the cap, because that is what the cap
 * counts. An exited shell stays listed — its output is still readable until
 * the attachment ends — but it occupies no slot, and folding the two into
 * one `N of 4` would tell a model with four corpses and one server that it
 * was over a limit it was nowhere near.
 */
function heldShells(shells: readonly RuntimeShellRecord[], now: number): string {
  if (shells.length === 0) return "This Session holds no background shells.";
  const running = shells.filter((shell) => shell.state === "running").length;
  const exited = shells.length - running;
  const count =
    exited === 0
      ? `${running} running of ${SHELL_MAX_PER_SESSION}`
      : `${running} running of ${SHELL_MAX_PER_SESSION}, ${exited} exited and still readable`;
  return [
    `Background shells this Session holds (${count}):`,
    ...shells.map(
      (shell) =>
        `- ${shell.shellId} · ${shellStanding(shell)} · ${age(now - shell.startedAt)} · ${label(shell)}`,
    ),
  ].join("\n");
}

/** The one-line account of a shell that leads every result about it. */
function headline(shell: RuntimeShellRecord, now: number): string {
  if (shell.state === "running") {
    return `Background shell ${shell.shellId} is running (started ${age(now - shell.startedAt)} ago): ${firstLine(shell.command)}`;
  }
  const how =
    shell.signal !== null ? `by signal ${shell.signal}` : `with code ${shell.code ?? "?"}`;
  const ran = age((shell.exitedAt ?? now) - shell.startedAt);
  return `Background shell ${shell.shellId} exited ${how} after ${ran}: ${firstLine(shell.command)}`;
}

function outputBlock(output: string): string[] {
  return output.length === 0 ? [] : [output.endsWith("\n") ? output.slice(0, -1) : output];
}

function readText(
  outcome: RuntimeShellOutputOutcome,
  tail: number | undefined,
  now: number,
): string {
  const { shell, output } = outcome;
  // What was GRANTED, never what was asked for: `tail` is the model's number
  // and the host bounds it, so echoing the request would promise a megabyte
  // beside the 64 kB actually handed back.
  const granted = bytesOf(output);
  const what =
    tail === undefined
      ? granted === 0
        ? "No new output since the last read."
        : `New output since the last read (${granted} bytes):`
      : `The last ${granted} bytes of everything retained:`;
  return [
    headline(shell, now),
    what,
    ...outputBlock(output),
    ...(outcome.truncated
      ? ["Volli dropped earlier bytes at its own bound; the output above starts mid-stream."]
      : []),
    heldShells(outcome.shells, now),
  ].join("\n");
}

/**
 * What a refused action tells the model — ./browser-tools.ts's refusal shape,
 * one port over: a result rather than a thrown error, because a refusal is
 * the policy working and the model is the one who can act on it.
 */
function refusalText(refusal: ShellRefusal): string {
  return [
    "Volli refused the shell action, and nothing was done.",
    refusal.message,
    `Refused by rule ${refusal.rule}. The policy is not yours to adjust, and this must not be attempted another way: act on what the refusal says, or continue without it.`,
  ].join("\n");
}

/**
 * Run one port call under the same two signals every non-coding tool waits on
 * — Pi's per-call cancellation and the attachment's own — with the same
 * one-listener-each, removed-in-finally bargain ./tools.ts strikes. A
 * {@link ShellRefusal} is an answer; anything else thrown is a host that could
 * not act at all, and fails the call.
 */
async function guarded(
  signals: readonly (AbortSignal | undefined)[],
  run: (signal: AbortSignal) => Promise<AgentToolResult<ShellToolDetails | undefined>>,
): Promise<AgentToolResult<ShellToolDetails | undefined>> {
  const withdrawn = new AbortController();
  const abandon = (): void => withdrawn.abort();
  const live = signals.filter((one) => one !== undefined);
  for (const one of live) {
    if (one.aborted) abandon();
    else one.addEventListener("abort", abandon, { once: true });
  }
  try {
    return await run(withdrawn.signal);
  } catch (error) {
    if (!(error instanceof ShellRefusal)) throw error;
    return { content: [{ type: "text", text: refusalText(error) }], details: undefined };
  } finally {
    for (const one of live) one.removeEventListener("abort", abandon);
  }
}

function text(value: string, details: ShellToolDetails): AgentToolResult<ShellToolDetails> {
  return { content: [{ type: "text", text: value }], details };
}

// ---- schemas: what the model may say, and nothing it may not -----------------

const startSchema = Type.Object({
  command: Type.String({ description: "The shell command to run beside the turn." }),
  cwd: Type.Optional(
    Type.String({
      description: "Where to run it. Defaults to the Session workspace, and must stay inside it.",
    }),
  ),
  title: Type.Optional(
    Type.String({ description: "A short name for the shell, shown wherever it is listed." }),
  ),
});

const outputSchema = Type.Object({
  shellId: Type.String({ description: "The background shell to read, from shell_start." }),
  tail: Type.Optional(
    Type.Number({
      description:
        "Instead of what is new, the last N bytes of everything retained. Volli bounds N.",
    }),
  ),
});

const killSchema = Type.Object({
  shellId: Type.String({ description: "The background shell to end." }),
});

// ---- descriptions: the claims a schema cannot state --------------------------

const DESCRIPTIONS: Record<ShellToolId, string> = {
  shell_start: [
    "Start a command that runs beside the turn instead of holding it: a dev server, a watch build, a long test run, a log tail.",
    "Returns the shell's id and whatever it printed in its first second, so a server's listening line comes back in the same call.",
    "Volli caps how many a Session may hold and kills every one when the Session's attachment ends. Use execute for a command you want to wait on.",
  ].join(" "),
  shell_output: [
    "Read a background shell's output. By default this returns only what is new since the last read of that shell, so polling costs the same each time;",
    "pass tail to get the last N bytes of everything retained instead. The result states whether the shell is still running or has exited, and with what.",
  ].join(" "),
  shell_kill: [
    "End a background shell: SIGTERM, then SIGKILL if it lingers.",
    "Its output stays readable with shell_output until the Session's attachment ends.",
  ].join(" "),
};

const LABELS: Record<ShellToolId, string> = {
  shell_start: "shell start",
  shell_output: "shell output",
  shell_kill: "shell kill",
};

/**
 * Build one shell tool by name, bound to the port that answers it.
 *
 * A factory over a name rather than three exported creators, for
 * `createBrowserTool`'s reason: the caller is `createSessionTools` switching
 * over bindings whose three arms all carry the same port.
 *
 * `now` is injectable so the ages in a result are deterministic under test;
 * production takes the wall clock.
 */
export function createShellTool(
  name: ShellToolId,
  port: RuntimeShellPort,
  signal?: AbortSignal,
  now: () => number = Date.now,
): AgentTool {
  const common = { name, label: LABELS[name], description: DESCRIPTIONS[name] };
  switch (name) {
    case "shell_start": {
      const tool: AgentTool<typeof startSchema, ShellToolDetails | undefined> = {
        ...common,
        parameters: startSchema,
        execute: (_id, params, callSignal) =>
          guarded([signal, callSignal], async (withdrawn) => {
            const started = await port.start({
              command: params.command,
              ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
              ...(params.title === undefined ? {} : { title: params.title }),
              signal: withdrawn,
            });
            const at = now();
            return text(
              [
                `Started background shell ${started.shell.shellId} (pid ${started.pid}): ${firstLine(started.shell.command)}`,
                started.output.length === 0
                  ? "It printed nothing in its first second. Read it later with shell_output."
                  : `Output so far (${bytesOf(started.output)} bytes):`,
                ...outputBlock(started.output),
                heldShells(started.shells, at),
              ].join("\n"),
              detailsOf(started.shell),
            );
          }),
      };
      return tool;
    }
    case "shell_output": {
      const tool: AgentTool<typeof outputSchema, ShellToolDetails | undefined> = {
        ...common,
        parameters: outputSchema,
        execute: (_id, params, callSignal) =>
          guarded([signal, callSignal], async (withdrawn) => {
            const read = await port.output({
              shellId: params.shellId,
              ...(params.tail === undefined ? {} : { tail: params.tail }),
              signal: withdrawn,
            });
            return text(readText(read, params.tail, now()), detailsOf(read.shell));
          }),
      };
      return tool;
    }
    case "shell_kill": {
      const tool: AgentTool<typeof killSchema, ShellToolDetails | undefined> = {
        ...common,
        parameters: killSchema,
        execute: (_id, params, callSignal) =>
          guarded([signal, callSignal], async (withdrawn) => {
            const killed = await port.kill({ shellId: params.shellId, signal: withdrawn });
            const at = now();
            return text(
              [
                `Killed background shell ${killed.shell.shellId} (${shellStanding(killed.shell)}): ${firstLine(killed.shell.command)}`,
                "Its output stays readable with shell_output until this attachment ends.",
                heldShells(killed.shells, at),
              ].join("\n"),
              detailsOf(killed.shell),
            );
          }),
      };
      return tool;
    }
  }
}
