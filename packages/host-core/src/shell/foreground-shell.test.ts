import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ShellRefusal, SHELL_MAX_PER_SESSION } from "@volli/agent-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  BackgroundShellHost,
  type BackgroundShellNotice,
  type BackgroundShellOwner,
  type BackgroundShellState,
  type ForegroundShellOptions,
} from "./background-shell-host";

const owner: BackgroundShellOwner = {
  sessionId: "session-1",
  attachmentId: "attachment-1",
  projectId: "project-1",
  ticketId: null,
};
const hosts: BackgroundShellHost[] = [];
const directories: string[] = [];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for child");
    await pause(10);
  }
}

function harness(overrides: Partial<ConstructorParameters<typeof BackgroundShellHost>[0]> = {}) {
  const states: BackgroundShellState[] = [];
  const removed: string[] = [];
  const notices: BackgroundShellNotice[] = [];
  const pids: number[] = [];
  const exits: string[] = [];
  const cwd = mkdtempSync(join(process.cwd(), ".foreground-shell-"));
  directories.push(cwd);
  let ids = 0;
  const host = new BackgroundShellHost({
    publishState: (state) => states.push(state),
    publishRemoved: (id) => removed.push(id),
    onNotice: (notice) => notices.push(notice),
    createId: () => `sh-${++ids}`,
    settleMs: 5,
    killGraceMs: 30,
    exitNoticeGraceMs: 40,
    ledger: {
      recordSpawn: (spawn) => {
        pids.push(spawn.pid);
        return `row-${pids.length}`;
      },
      markExited: (id) => exits.push(id),
    },
    ...overrides,
  });
  hosts.push(host);
  const input = (command: string) => ({
    command,
    cwd,
    title: null,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  function run(command: string, options: Partial<ForegroundShellOptions> = {}) {
    const controller = new AbortController();
    const output: string[] = [];
    const promise = host.runForeground(owner, input(command), {
      toolCallId: "call-1",
      signal: controller.signal,
      onOutput: (text) => output.push(text),
      ...options,
    });
    return { promise, controller, output };
  }
  return { host, run, input, states, removed, notices, pids, exits };
}

function alive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("foreground shell lifecycle", () => {
  it("runs through the shared ledger privately, retaining stdout and stderr through normal exit", async () => {
    const { host, run, states, notices, pids, exits } = harness();
    const running = run("echo before; sleep 0.1; echo after >&2; exit 7");
    await until(() => running.output.some((text) => text.includes("before")));
    expect(host.foregroundAvailable(owner.sessionId, "call-1")).toBe(true);
    expect(host.listAll()).toEqual([]);
    expect(host.list(owner.sessionId)).toEqual([]);
    expect(host.tailOf("sh-1")).toBeNull();
    expect(() => host.read(owner, "sh-1")).toThrow(ShellRefusal);
    expect(host.liveCwds()).toHaveLength(1);
    expect(pids).toHaveLength(1);
    await expect(running.promise).resolves.toEqual({
      output: "before\nafter\n",
      code: 7,
      signal: null,
    });
    expect(running.output.at(-1)).toBe("before\nafter\n");
    expect(exits).toEqual(["row-1"]);
    await pause(100);
    expect(states).toEqual([]);
    expect(notices).toEqual([]);
    expect(host.foregroundAvailable(owner.sessionId, "call-1")).toBe(false);
  });

  it("moves the existing child, survives its former timeout and cancellation, retains pre/post output and notices one exit", async () => {
    const { host, run, states, notices, pids, exits } = harness();
    const running = run("echo before; sleep 0.3; echo after; exit 3", { timeout: 0.15 });
    await until(() => running.output.includes("before\n"));
    const moved = host.moveForeground(owner.sessionId, "call-1");
    expect(moved).toEqual({ shellId: "sh-1" });
    await expect(running.promise).resolves.toEqual({
      output: "before\n",
      code: null,
      signal: null,
      background: moved,
    });
    expect(pids).toHaveLength(1);
    expect(host.list(owner.sessionId)).toHaveLength(1);
    expect(host.tailOf(moved.shellId)?.output).toBe("before\n");
    expect(host.read(owner, moved.shellId).output).toBe("");
    expect(host.foregroundAvailable(owner.sessionId, "call-1")).toBe(false);
    expect(() => host.moveForeground(owner.sessionId, "call-1")).toThrow(ShellRefusal);
    running.controller.abort();
    await pause(180);
    expect(alive(pids[0]!)).toBe(true);
    expect(host.list(owner.sessionId)[0]?.state).toBe("running");
    await until(() => notices.length === 1);
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "exited",
        shellId: moved.shellId,
        code: 3,
        tail: "before\nafter\n",
      }),
    ]);
    expect(host.read(owner, moved.shellId).output).toBe("after\n");
    expect(host.tailOf(moved.shellId)?.output).toBe("before\nafter\n");
    expect(running.output.at(-1)).toBe("before\n");
    expect(states.map((state) => state.state)).toEqual(["running", "exited"]);
    expect(exits).toEqual(["row-1"]);
    await pause(100);
    expect(notices).toHaveLength(1);
  });

  it("caps promotion atomically, leaving a refused foreground call private and cancellable", async () => {
    const { host, run, input, states, pids } = harness();
    for (let i = 0; i < SHELL_MAX_PER_SESSION; i += 1) await host.start(owner, input("sleep 30"));
    const running = run("echo ready; sleep 30");
    const rejected = expect(running.promise).rejects.toMatchObject({ output: "ready\n" });
    await until(() => running.output.includes("ready\n"));
    expect(host.foregroundAvailable(owner.sessionId, "call-1")).toBe(false);
    expect(() => host.moveForeground(owner.sessionId, "call-1")).toThrow(/kill one/);
    expect(states).toHaveLength(SHELL_MAX_PER_SESSION);
    expect(host.listAll()).toHaveLength(SHELL_MAX_PER_SESSION);
    expect(alive(pids.at(-1)!)).toBe(true);
    running.controller.abort();
    await rejected;
    await until(() => !alive(pids.at(-1)!));
  });

  it("keeps the timeout after a cap refusal, and can promote after a background slot opens", async () => {
    const { host, run, input } = harness();
    for (let i = 0; i < SHELL_MAX_PER_SESSION; i += 1) await host.start(owner, input("sleep 30"));
    const timed = run("echo timed; sleep 30", { timeout: 0.15 });
    const rejection = expect(timed.promise).rejects.toThrow("Command timed out after 0.15 seconds");
    await until(() => timed.output.includes("timed\n"));
    expect(() => host.moveForeground(owner.sessionId, "call-1")).toThrow(ShellRefusal);
    await rejection;
    const running = run("echo ready; sleep 30");
    await until(() => running.output.includes("ready\n"));
    await host.kill(owner, "sh-1");
    expect(host.foregroundAvailable(owner.sessionId, "call-1")).toBe(true);
    const moved = host.moveForeground(owner.sessionId, "call-1");
    await running.promise;
    await expect(host.kill(owner, moved.shellId)).resolves.toMatchObject({
      shell: { state: "exited", signal: "SIGTERM" },
    });
  });

  it.each(["timeout", "abort"] as const)(
    "rejects with retained output on %s and kills the process group",
    async (reason) => {
      const { host, run, pids, states, notices, exits } = harness();
      const running = run(
        "echo ready; trap '' TERM; sleep 30 & sleep 30",
        reason === "timeout" ? { timeout: 0.2 } : {},
      );
      const rejection = expect(running.promise).rejects.toMatchObject({
        output: "ready\n",
        message: expect.stringContaining(reason === "timeout" ? "timed out" : "aborted"),
      });
      await until(() => running.output.includes("ready\n"));
      if (reason === "abort") running.controller.abort();
      await rejection;
      expect(host.foregroundAvailable(owner.sessionId, "call-1")).toBe(false);
      expect(() => host.moveForeground(owner.sessionId, "call-1")).toThrow(ShellRefusal);
      await until(() => !alive(pids[0]!));
      await until(() => exits.length === 1);
      expect(exits).toEqual(["row-1"]);
      expect(states).toEqual([]);
      expect(notices).toEqual([]);
    },
  );

  it("disposes both modes, escalates the kill, forgets records and suppresses notices", async () => {
    const { host, run, input, pids, removed, notices } = harness();
    await host.start(owner, input("trap '' TERM; echo bg; sleep 30"));
    const foreground = run("trap '' TERM; echo fg; sleep 30");
    const rejection = expect(foreground.promise).rejects.toThrow("attachment ended");
    await until(() => foreground.output.includes("fg\n"));
    host.disposeSession(owner.sessionId);
    await rejection;
    expect(host.listAll()).toEqual([]);
    expect(removed).toEqual(["sh-1"]);
    await until(() => pids.every((pid) => !alive(pid)));
    await pause(100);
    expect(notices).toEqual([]);
  });

  it("disposes a moved child like any background shell", async () => {
    const { host, run, pids, removed, notices } = harness();
    const running = run("echo ready; trap '' TERM; sleep 30");
    await until(() => running.output.includes("ready\n"));
    host.moveForeground(owner.sessionId, "call-1");
    await running.promise;
    host.disposeSession(owner.sessionId);
    expect(removed).toEqual(["sh-1"]);
    await until(() => !alive(pids[0]!));
    expect(notices).toEqual([]);
  });

  it("joins foreground kills at close, including a start disposed before its continuation runs", async () => {
    const { host, run, pids, exits } = harness();
    const running = run("trap '' TERM; echo ready; sleep 30");
    const rejection = expect(running.promise).rejects.toThrow("host is stopping");
    const close = host.close();
    expect(host.close()).toBe(close);
    await rejection;
    await close;
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    expect(exits).toEqual(["row-1"]);
    await expect(run("echo nope").promise).rejects.toMatchObject({ rule: "shell.closing" });
    expect(() => host.moveForeground(owner.sessionId, "call-1")).toThrow(ShellRefusal);
  });

  it("cancels a pending foreground start on immediate attachment disposal", async () => {
    const { host, run, pids } = harness();
    const running = run("echo ready; sleep 30");
    const rejection = expect(running.promise).rejects.toThrow("attachment ended");
    host.disposeSession(owner.sessionId);
    await rejection;
    await until(() => !alive(pids[0]!));
    expect(host.listAll()).toEqual([]);
  });

  it("honors read-before-grace and person/agent kills for moved shells", async () => {
    const { host, run, notices } = harness({ exitNoticeGraceMs: 120 });
    const first = run("echo ready; sleep 0.1; exit 5");
    await until(() => first.output.includes("ready\n"));
    host.moveForeground(owner.sessionId, "call-1");
    await first.promise;
    await until(() => host.list(owner.sessionId)[0]?.state === "exited");
    expect(host.read(owner, "sh-1").shell.code).toBe(5);
    await pause(150);
    expect(notices).toEqual([]);
    const second = run("echo ready; sleep 30");
    await until(() => second.output.includes("ready\n"));
    host.moveForeground(owner.sessionId, "call-1");
    await second.promise;
    await host.killAny("sh-2");
    await until(() => notices.length === 1);
    expect(notices[0]).toMatchObject({ kind: "exited", byPerson: true, signal: "SIGTERM" });
    const third = run("echo ready; sleep 30");
    await until(() => third.output.includes("ready\n"));
    host.moveForeground(owner.sessionId, "call-1");
    await third.promise;
    await host.kill(owner, "sh-3");
    await pause(150);
    expect(notices).toHaveLength(1);
  });

  it("bounds and redacts the returned foreground snapshot and promotion tail", async () => {
    const { host, run } = harness({
      outputMaxBytes: 16,
      tailMaxBytes: 4,
      redactOutput: (text) => text.replaceAll("secret", "hidden"),
    });
    const running = run("printf '0123456789secret'; sleep 30");
    await until(() => running.output.length > 0);
    expect(running.output.at(-1)).toBe("0123456789hidden");
    host.moveForeground(owner.sessionId, "call-1");
    await expect(running.promise).resolves.toMatchObject({ output: "dden" });
    expect(host.tailOf("sh-1")?.output).toBe("0123456789hidden");
  });

  it("rejects an invalid timeout, already-aborted call or duplicate call without spawning", async () => {
    const { run, pids } = harness();
    await expect(run("echo nope", { timeout: -1 }).promise).rejects.toThrow("Invalid timeout");
    await expect(run("echo nope", { signal: AbortSignal.abort() }).promise).rejects.toThrow(
      "aborted",
    );
    expect(pids).toEqual([]);
    const first = run("echo ready; sleep 30");
    const rejection = expect(first.promise).rejects.toThrow("aborted");
    await until(() => first.output.includes("ready\n"));
    await expect(run("echo nope").promise).rejects.toThrow("already running");
    expect(pids).toHaveLength(1);
    first.controller.abort();
    await rejection;
  });

  it("fails spawn loudly and rejects callback faults rather than leaking a private child", async () => {
    const { host, run, input, pids } = harness();
    await expect(
      host.runForeground(
        owner,
        { ...input("echo nope"), cwd: join(process.cwd(), "missing-foreground-cwd") },
        {
          toolCallId: "call-1",
          signal: new AbortController().signal,
          onOutput: () => {},
        },
      ),
    ).rejects.toThrow("Could not start a background shell");
    const running = run("echo ready; sleep 30", {
      onOutput: () => {
        throw new Error("listener failed");
      },
    });
    await expect(running.promise).rejects.toThrow("listener failed");
    await until(() => !alive(pids[0]!));
  });

  it("refuses a child already exited while its inherited pipes are still draining", async () => {
    const { host, run, pids, states } = harness();
    // A real grandchild keeps the pipes open briefly after bash itself exits.
    // `close` waits for it, but a dead bash must not become a running shell.
    const running = run("echo ready; sleep 0.2 & exit 0");
    await until(() => running.output.includes("ready\n"));
    await until(() => {
      try {
        process.kill(pids[0]!, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(host.foregroundAvailable(owner.sessionId, "call-1")).toBe(false);
    expect(() => host.moveForeground(owner.sessionId, "call-1")).toThrow("already exited");
    await expect(running.promise).resolves.toEqual({ output: "ready\n", code: 0, signal: null });
    expect(states).toEqual([]);
  });

  it("retains independent call cancellation bindings within one Session", async () => {
    const { host, run, pids } = harness();
    const first = run("echo one; sleep 30");
    const second = run("echo two; sleep 30", { toolCallId: "call-2" });
    const rejection = expect(second.promise).rejects.toThrow("aborted");
    await until(() => first.output.includes("one\n") && second.output.includes("two\n"));
    host.moveForeground(owner.sessionId, "call-1");
    await first.promise;
    expect(host.foregroundAvailable(owner.sessionId, "call-2")).toBe(true);
    second.controller.abort();
    await rejection;
    await until(() => !alive(pids[1]!));
    expect(alive(pids[0]!)).toBe(true);
  });

  it("uses the normal match and exit notices after promotion without repeating foreground matches", async () => {
    const { host, input, notices } = harness();
    let text = "";
    const running = host.runForeground(
      owner,
      {
        ...input("echo before; sleep 0.15; echo ready; sleep 0.05; exit 0"),
        notifyOn: { pattern: "ready", regex: false },
      },
      {
        toolCallId: "call-1",
        signal: new AbortController().signal,
        onOutput: (output) => {
          text = output;
        },
      },
    );
    await until(() => text === "before\n");
    host.moveForeground(owner.sessionId, "call-1");
    await running;
    await until(() => notices.length === 2);
    expect(notices.map((notice) => notice.kind)).toEqual(["matched", "exited"]);
    expect(notices[0]).toMatchObject({ line: "ready" });
    const matched = host.runForeground(
      owner,
      {
        ...input("echo ready; sleep 0.1; echo ready; exit 0"),
        notifyOn: { pattern: "ready", regex: false },
      },
      {
        toolCallId: "call-2",
        signal: new AbortController().signal,
        onOutput: (output) => {
          text = output;
        },
      },
    );
    await until(() => text === "ready\n");
    host.moveForeground(owner.sessionId, "call-2");
    await matched;
    await until(() => notices.length === 3);
    expect(notices.map((notice) => notice.kind)).toEqual(["matched", "exited", "exited"]);
  });

  it("returns cancellation output even before a successful spawn has been attached", async () => {
    const { host, run, input } = harness();
    const running = run("sleep 30");
    const rejection = expect(running.promise).rejects.toMatchObject({ output: "" });
    running.controller.abort();
    await rejection;
    const controller = new AbortController();
    const failed = host.runForeground(
      owner,
      { ...input("echo nope"), cwd: join(process.cwd(), "missing-foreground-cwd") },
      {
        toolCallId: "call-2",
        signal: controller.signal,
        onOutput: () => {},
      },
    );
    const aborted = expect(failed).rejects.toMatchObject({ output: "" });
    controller.abort();
    await aborted;
    await pause(20);
    for (const timeout of [NaN, Infinity, 2_147_484]) {
      await expect(run("echo nope", { timeout }).promise).rejects.toThrow("Invalid timeout");
    }
  });

  it("does not move another Session's call and cleanly arbitrates exit against move", async () => {
    const { host, run, notices, states } = harness({ exitNoticeGraceMs: 0 });
    for (const delay of [0, 30, 0, 30]) {
      const running = run("echo ready; sleep 0.02; echo end");
      await until(() => running.output.some((text) => text.includes("ready")));
      expect(host.foregroundAvailable("other-session", "call-1")).toBe(false);
      expect(() => host.moveForeground("other-session", "call-1")).toThrow(ShellRefusal);
      await pause(delay);
      let moved: { shellId: string } | undefined;
      try {
        moved = host.moveForeground(owner.sessionId, "call-1");
      } catch (error) {
        expect(error).toBeInstanceOf(ShellRefusal);
      }
      const result = await running.promise;
      if (moved !== undefined) {
        expect(result.background).toEqual(moved);
        await until(() => notices.some((notice) => notice.shellId === moved.shellId));
        expect(notices.filter((notice) => notice.shellId === moved.shellId)).toHaveLength(1);
        expect(
          states.filter((state) => state.shellId === moved.shellId).map((state) => state.state),
        ).toEqual(["running", "exited"]);
      } else {
        expect(result).toEqual({ output: "ready\nend\n", code: 0, signal: null });
        expect(() => host.moveForeground(owner.sessionId, "call-1")).toThrow(ShellRefusal);
      }
    }
  });
});
