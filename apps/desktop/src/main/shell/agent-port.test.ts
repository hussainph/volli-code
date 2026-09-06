import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionCommandEnvironment, ShellRefusal } from "@volli/agent-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createAgentShellPort, type AgentShellPort } from "./agent-port";
import { BackgroundShellHost } from "./background-shell-host";

const signal = new AbortController().signal;

const identity = {
  sessionId: "session-1",
  ticketDisplayId: "VC-270",
  sessionToken: "tok-shared-with-execute",
};

const ports: AgentShellPort[] = [];

function workspace(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "volli-shell-port-")));
}

function port(overrides: Partial<Parameters<typeof createAgentShellPort>[0]> = {}) {
  const host = new BackgroundShellHost({
    publishState: () => {},
    publishRemoved: () => {},
    settleMs: 150,
    killGraceMs: 200,
  });
  const ws = workspace();
  const built = createAgentShellPort({
    host,
    scope: { projectId: "project-1", ticketId: "ticket-1" },
    session: { sessionId: "session-1", attachmentId: "attachment-1" },
    workspacePath: ws,
    identity,
    pathPrefixes: ["/opt/volli/bin"],
    ...overrides,
  });
  ports.push(built);
  return { port: built, host, ws };
}

afterEach(() => {
  for (const one of ports.splice(0)) one.dispose();
});

describe("createAgentShellPort", () => {
  it("runs in the Session workspace by default, and hands back the Session's shells on every result", async () => {
    const { port: shell, ws } = port();

    const started = await shell.start({ command: "pwd; sleep 30", signal });
    expect(started.output).toBe(`${ws}\n`);
    expect(started.shells.map((one) => one.shellId)).toEqual([started.shell.shellId]);

    const read = await shell.output({ shellId: started.shell.shellId, signal });
    expect(read.shells).toHaveLength(1);
    const killed = await shell.kill({ shellId: started.shell.shellId, signal });
    expect(killed.shell.state).toBe("exited");
    expect(killed.shells.map((one) => one.state)).toEqual(["exited"]);
  });

  it("accepts a cwd inside the workspace, relative or absolute, and refuses one outside as shell.cwd", async () => {
    const { port: shell, ws } = port();
    mkdirSync(join(ws, "packages", "app"), { recursive: true });

    const relative = await shell.start({ command: "pwd", cwd: "packages/app", signal });
    expect(relative.output).toBe(`${join(ws, "packages", "app")}\n`);
    const absolute = await shell.start({ command: "pwd", cwd: join(ws, "packages"), signal });
    expect(absolute.output).toBe(`${join(ws, "packages")}\n`);

    for (const cwd of ["..", "/tmp", `${ws}-evil`, "packages/../../x"]) {
      const refused = shell.start({ command: "pwd", cwd, signal });
      await expect(refused).rejects.toBeInstanceOf(ShellRefusal);
      await expect(refused).rejects.toMatchObject({ rule: "shell.cwd" });
    }
    // Nothing was started by the refusals.
    expect((await shell.output({ shellId: relative.shell.shellId, signal })).shells).toHaveLength(
      2,
    );
  });

  it("spawns through the one shared environment record, carrying the identity and the token execute got", async () => {
    // Landmine 1 and 2 together: the identity object is handed in, never
    // minted here, and the record is `sessionCommandEnvironment`'s — so the
    // token a background shell exports is the token the execute tool's
    // child exports, and PATH carries the same prefixes.
    const { port: shell } = port();
    const started = await shell.start({
      command:
        "printenv VOLLI_SESSION; printenv VOLLI_TICKET; printenv VOLLI_SESSION_TOKEN; printenv PATH",
      signal,
    });
    const expected = sessionCommandEnvironment(process.env, {
      identity,
      pathPrefixes: ["/opt/volli/bin"],
    });
    expect(started.output).toBe(
      `session-1\nVC-270\n${identity.sessionToken}\n${expected["PATH"]}\n`,
    );
  });

  it("forwards title and tail, and answers a withdrawn call without touching the host", async () => {
    const { port: shell } = port();
    const started = await shell.start({
      command: "printf 0123456789; sleep 30",
      title: "counter",
      signal,
    });
    expect(started.shell.title).toBe("counter");
    const tail = await shell.output({ shellId: started.shell.shellId, tail: 3, signal });
    expect(tail).toMatchObject({ output: "789", truncated: true });

    const withdrawn = new AbortController();
    withdrawn.abort();
    await expect(shell.start({ command: "sleep 30", signal: withdrawn.signal })).rejects.toThrow();
    expect((await shell.output({ shellId: started.shell.shellId, signal })).shells).toHaveLength(1);
  });

  it("disposes every shell the Session started, and only its own", async () => {
    const { port: mine, host } = port();
    const theirs = createAgentShellPort({
      host,
      scope: { projectId: "project-1", ticketId: "ticket-2" },
      session: { sessionId: "session-2", attachmentId: "attachment-2" },
      workspacePath: workspace(),
      identity: { sessionId: "session-2", ticketDisplayId: null },
      pathPrefixes: [],
    });
    ports.push(theirs);
    await mine.start({ command: "sleep 30", signal });
    await theirs.start({ command: "sleep 30", signal });
    // A subagent — any other Session — never sees the parent's shells.
    expect((await theirs.output({ shellId: "x", signal }).catch((e) => e)).rule).toBe(
      "shell.unknown",
    );

    mine.dispose();

    expect(host.list("session-1")).toEqual([]);
    expect(host.list("session-2")).toHaveLength(1);
  });
});
