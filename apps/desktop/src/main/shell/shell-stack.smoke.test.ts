/**
 * The background shell stack end to end, in process and for $0 (VC-270):
 * the real host, the real per-Session port, the real three tools the model
 * calls, and the island projection over exactly what main pushed to the
 * renderer. No model turn, no Electron, no display.
 *
 * What the ticket's smoke step asks for, minus the pixels: the island's mount
 * is VC-268, so "the glyph reads running" is read here off the four fields
 * the island's row carries, folded from exactly what main pushed. The
 * projection function itself belongs to the renderer and is tested there
 * (`components/chat/island-shells.test.ts`); main does not import across the
 * process boundary to reach it.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellTool } from "@volli/agent-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { SessionRuntimeCommandRequest } from "@volli/session-engine";
import type { SessionProjection } from "@volli/shared";

import type { BackgroundShellState } from "../../ipc/contract";
import { createAgentShellPort, type AgentShellPort } from "./agent-port";
import { BackgroundShellHost } from "./background-shell-host";
import { relayShellNotices } from "./shell-notices";

/** The four fields the Activity Island's shell row carries. */
interface IslandRow {
  id: string;
  command: string;
  state: "running" | "exited";
  code: number | null;
}

/**
 * One Session's rows as the island reads them, in start order — the shape
 * `useIslandShells` hands the mount, restated here over the pushed records so
 * this smoke stays inside main.
 */
function islandRows(pushed: Iterable<BackgroundShellState>, sessionId: string): IslandRow[] {
  return [...pushed]
    .filter((shell) => shell.sessionId === sessionId)
    .toSorted((a, b) => a.startedAt - b.startedAt)
    .map((shell) => ({
      id: shell.shellId,
      command: shell.command,
      state: shell.state,
      code: shell.code,
    }));
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map((entry) => (entry.type === "text" ? (entry.text ?? "") : "")).join("\n");

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let port: AgentShellPort | null = null;
afterEach(() => port?.dispose());

describe("background shell stack smoke", () => {
  it("starts a sleeping echo, reads it, sees it exit 0, and refuses a kill on the corpse", async () => {
    // What main pushes to the renderer, folded the way the store folds it.
    const pushed = new Map<string, BackgroundShellState>();
    const host = new BackgroundShellHost({
      publishState: (shell) => pushed.set(shell.shellId, shell),
      publishRemoved: (shellId) => pushed.delete(shellId),
      settleMs: 200,
      killGraceMs: 200,
    });
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "volli-shell-smoke-")));
    port = createAgentShellPort({
      host,
      scope: { projectId: "project-1", ticketId: "ticket-1" },
      session: { sessionId: "session-1", attachmentId: "attachment-1" },
      workspacePath: workspace,
      identity: { sessionId: "session-1", ticketDisplayId: "VC-270", sessionToken: "tok" },
      pathPrefixes: [],
    });
    const start = createShellTool("shell_start", port);
    const output = createShellTool("shell_output", port);
    const kill = createShellTool("shell_kill", port);
    const island = () => islandRows(pushed.values(), "session-1");

    // 1. shell_start a sleeping echo: the first line comes back in the call.
    // Printed text that is not in the command itself, since every result
    // restates the command in its live-shells footer.
    const command = "echo $((40+2)); sleep 0.6; echo $((99+1)); exit 0";
    const started = text(await start.execute("c1", { command }));
    expect(started).toMatch(/Started background shell \S+ \(pid \d+\)/);
    expect(started).toContain("\n42\n");
    const shellId = /Started background shell (\S+) /.exec(started)?.[1];
    expect(shellId).toBeDefined();

    // 2. The island shows it running.
    expect(island()).toEqual([{ id: shellId, command, state: "running", code: null }]);

    // 3. shell_output reads only what is new.
    const first = text(await output.execute("c2", { shellId }));
    expect(first).toContain("is running");
    expect(first).toContain("No new output");
    expect(first).not.toContain("\n42\n");

    // 4. It exits; the glyph reads exit 0, and the next read says exited —
    //    never a stale running.
    await until(() => pushed.get(shellId!)?.state === "exited");
    expect(island()[0]).toMatchObject({ state: "exited", code: 0 });
    const last = text(await output.execute("c3", { shellId }));
    expect(last.split("\n")[0]).toContain("exited with code 0");
    expect(last).toContain("\n100\n");

    // 5. A kill on the exited shell refuses with shell.exited.
    const refused = text(await kill.execute("c4", { shellId }));
    expect(refused).toContain("Volli refused the shell action");
    expect(refused).toContain("shell.exited");

    // 6. The attachment ends: the shell is gone from the renderer's view.
    port!.dispose();
    expect(island()).toEqual([]);
  });

  it("tells the Session by itself when a long command prints its line and when it exits, and says nothing for the kill it asked for (VC-495)", async () => {
    // The whole path with no model and no Electron: the tool the model calls,
    // the real port and host, the relay, and a fake of the runtime the notices
    // are steered through.
    const commands: SessionRuntimeCommandRequest[] = [];
    const relay = relayShellNotices({
      report: () => {},
      runtime: {
        command: async (request) => {
          commands.push(request);
          return { receipt: { status: "accepted" } } as never;
        },
        projection: async () => ({
          projection: {
            stopped: null,
            liveExecutor: { id: "executor" },
          } as unknown as SessionProjection,
          throughSequence: 0,
        }),
        subscribe: async () => () => {},
      },
    });
    const host = new BackgroundShellHost({
      publishState: () => {},
      publishRemoved: () => {},
      settleMs: 200,
      killGraceMs: 200,
      exitNoticeGraceMs: 60,
      onNotice: (notice) => void relay(notice),
    });
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "volli-shell-smoke-")));
    port = createAgentShellPort({
      host,
      scope: { projectId: "project-1", ticketId: "ticket-1" },
      session: { sessionId: "session-1", attachmentId: "attachment-1" },
      workspacePath: workspace,
      identity: { sessionId: "session-1", ticketDisplayId: "VC-495", sessionToken: "tok" },
      pathPrefixes: [],
    });
    const start = createShellTool("shell_start", port);
    const kill = createShellTool("shell_kill", port);
    const bodies = () =>
      commands.map((request) => {
        if (request.command.kind !== "message.submit") throw new Error("expected a submit");
        const part = request.command.message.parts[0];
        return part?.type === "text" ? part.text : "";
      });

    // A long command that prints its line and then exits non-zero.
    await start.execute("c1", {
      command: "sleep 0.5; echo ready on $((40+2)); sleep 0.3; echo boom >&2; exit 4",
      title: "ci",
      notifyOn: "ready on",
    });
    await until(() => commands.length === 2, 6_000);

    expect(commands.map((request) => request.commandId.split(":").at(-1))).toEqual([
      "match",
      "exit",
    ]);
    expect(bodies()[0]).toContain("ready on 42");
    expect(bodies()[1]).toContain("background shell");
    expect(bodies()[1]).toContain("exited with code 4");
    expect(bodies()[1]).toContain("boom");
    for (const request of commands) {
      expect(request).toMatchObject({
        sessionId: "session-1",
        origin: { kind: "volli", reason: "shell-notice" },
      });
    }

    // A shell the model kills itself: its tool result is the whole news.
    const second = await start.execute("c2", { command: "sleep 30" });
    const secondId = /Started background shell (\S+) /.exec(
      second.content.map((entry) => (entry.type === "text" ? entry.text : "")).join("\n"),
    )?.[1];
    await kill.execute("c3", { shellId: secondId });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(commands).toHaveLength(2);
  });
});
