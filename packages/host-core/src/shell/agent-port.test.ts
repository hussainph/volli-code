import { getEventListeners } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionCommandEnvironment, ShellRefusal } from "@volli/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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

  it("awaits credentials before spawning and layers them above the budget but below identity", async () => {
    const held = Promise.withResolvers<Readonly<Record<string, string>>>();
    const secretEnvironment = vi.fn(() => held.promise);
    const { port: shell, host } = port({
      concurrencyEnv: async () => ({ API_TOKEN: "budget", VOLLI_SESSION: "budget" }),
      secretEnvironment,
    });
    const start = vi.spyOn(host, "start");
    const command =
      "printenv API_TOKEN; printenv VOLLI_SESSION; printenv VOLLI_TICKET; printenv VOLLI_SESSION_TOKEN";
    const pending = shell.start({ command, signal });
    // Let the budget resolve so the credential hook is the pending operation.
    await vi.waitFor(() => expect(secretEnvironment).toHaveBeenCalledExactlyOnceWith(signal));
    expect(start).not.toHaveBeenCalled();
    held.resolve({
      API_TOKEN: "resolved-secret",
      VOLLI_SESSION: "secret-session",
      VOLLI_TICKET: "secret-ticket",
      VOLLI_SESSION_TOKEN: "secret-token",
    });
    const started = await pending;
    expect(start).toHaveBeenCalledOnce();
    expect(started.output).toBe(`resolved-secret\nsession-1\nVC-270\n${identity.sessionToken}\n`);
  });

  it("rejects a failed credential read without spawning", async () => {
    const held = Promise.withResolvers<Readonly<Record<string, string>>>();
    const failure = new Error("credential read failed");
    const { port: shell, host } = port({ secretEnvironment: () => held.promise });
    const start = vi.spyOn(host, "start");
    const pending = shell.start({ command: "echo must-not-run", signal });
    const rejected = expect(pending).rejects.toBe(failure);
    held.reject(failure);
    await rejected;
    expect(start).not.toHaveBeenCalled();
    expect(host.list("session-1")).toEqual([]);
  });

  it.each(["concurrency", "secrets"] as const)(
    "does not spawn a call withdrawn while awaiting %s",
    async (waitingOn) => {
      const held = Promise.withResolvers<Record<string, string>>();
      const secretEnvironment = vi.fn(() => (waitingOn === "secrets" ? held.promise : {}));
      const { port: shell, host } = port({
        secretEnvironment,
        ...(waitingOn === "concurrency" ? { concurrencyEnv: () => held.promise } : {}),
      });
      const start = vi.spyOn(host, "start");
      const withdrawn = new AbortController();
      const failure = new Error("call withdrawn");
      const pending = shell.start({ command: "echo must-not-run", signal: withdrawn.signal });
      const rejected = expect(pending).rejects.toBe(failure);
      if (waitingOn === "secrets") {
        await vi.waitFor(() =>
          expect(secretEnvironment).toHaveBeenCalledExactlyOnceWith(withdrawn.signal),
        );
      }
      withdrawn.abort(failure);
      // Leave the host promise held: cancellation must not depend on its settling.
      await rejected;
      if (waitingOn === "concurrency") expect(secretEnvironment).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(host.list("session-1")).toEqual([]);
      expect(getEventListeners(withdrawn.signal, "abort")).toEqual([]);
    },
    1_000,
  );

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

  it("hands notifyOn to the host: its match reaches the Session that started the shell, and a pattern the host will not run is refused as shell.pattern (VC-495)", async () => {
    const notices: { sessionId: string; kind: string; line?: string }[] = [];
    const host = new BackgroundShellHost({
      publishState: () => {},
      publishRemoved: () => {},
      settleMs: 150,
      killGraceMs: 200,
      exitNoticeGraceMs: 40,
      onNotice: (notice) =>
        notices.push({
          sessionId: notice.sessionId,
          kind: notice.kind,
          ...(notice.kind === "matched" ? { line: notice.line } : {}),
        }),
    });
    const { port: shell } = port({ host });

    const refused = shell.start({
      command: "sleep 30",
      notifyOn: { pattern: "(a)\\1", regex: true },
      signal,
    });
    await expect(refused).rejects.toMatchObject({ rule: "shell.pattern" });
    expect(host.list("session-1")).toEqual([]);

    await shell.start({
      command: "sleep 0.3; echo listening on :5173; sleep 30",
      notifyOn: { pattern: "listening on", regex: false },
      signal,
    });
    const deadline = Date.now() + 4_000;
    while (notices.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(notices).toEqual([
      { sessionId: "session-1", kind: "matched", line: "listening on :5173" },
    ]);
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
    await expect(theirs.output({ shellId: "x", signal })).rejects.toMatchObject({
      rule: "shell.unknown",
    });

    mine.dispose();

    expect(host.list("session-1")).toEqual([]);
    expect(host.list("session-2")).toHaveLength(1);
  });
});
