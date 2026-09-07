import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRefusal, SHELL_MAX_PER_SESSION } from "@volli/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { BackgroundShellState } from "../../ipc/contract";
import { BackgroundShellHost, type BackgroundShellOwner } from "./background-shell-host";

const owner: BackgroundShellOwner = {
  sessionId: "session-1",
  attachmentId: "attachment-1",
  projectId: "project-1",
  ticketId: "ticket-1",
};
const other: BackgroundShellOwner = { ...owner, sessionId: "session-2", attachmentId: "att-2" };

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "volli-shell-host-"));
}

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", VOLLI_SESSION_TOKEN: "tok-shared" };

interface Harness {
  host: BackgroundShellHost;
  published: BackgroundShellState[];
  removed: string[];
}

const hosts: BackgroundShellHost[] = [];

function harness(
  overrides: Partial<ConstructorParameters<typeof BackgroundShellHost>[0]> = {},
): Harness {
  const published: BackgroundShellState[] = [];
  const removed: string[] = [];
  let ids = 0;
  const host = new BackgroundShellHost({
    publishState: (state) => published.push(state),
    publishRemoved: (shellId) => removed.push(shellId),
    createId: () => `sh-${++ids}`,
    settleMs: 150,
    killGraceMs: 200,
    ...overrides,
  });
  hosts.push(host);
  return { host, published, removed };
}

function start(
  host: BackgroundShellHost,
  command: string,
  who = owner,
  title: string | null = null,
) {
  return host.start(who, { command, cwd: workspace(), title, env: ENV });
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.disposeSession(owner.sessionId);
    host.disposeSession(other.sessionId);
  }
});

describe("BackgroundShellHost", () => {
  it("fails the call when the command could not be spawned at all", async () => {
    // A spawn that never produced a pid is broken plumbing, not a judged
    // refusal: it must throw something the tool layer lets through, so the
    // call fails loudly rather than reading as a shell that printed nothing.
    const { host, published } = harness();

    const failed = await host
      .start(owner, {
        command: "whatever",
        cwd: join(workspace(), "no-such-directory"),
        title: null,
        env: ENV,
      })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(ShellRefusal);
    expect((failed as Error).message).toContain("Could not start a background shell");
    // Nothing was published and nothing is held: a shell that never ran is
    // not a shell the Session owns.
    expect(published).toEqual([]);
    expect(host.list(owner.sessionId)).toEqual([]);
  });

  it("cuts the ring on a byte bound without splitting the read into invalid UTF-8", async () => {
    // The ring is bounded in BYTES and a chunk may end mid-codepoint. The
    // decode happens once per read, so a cut that lands inside a 3-byte
    // character must still yield a readable string rather than throwing.
    const { host } = harness({ outputMaxBytes: 16 });
    // Ten copies of U+8D77, written as raw hex so the bytes do not depend on
    // this file's encoding or on the child's locale: 30 bytes into a 16-byte
    // ring, so the front is cut at an offset (14) that cannot fall on a
    // 3-byte character boundary.
    const started = await host.start(owner, {
      command: `printf '${"\\xe8\\xb5\\xb7".repeat(10)}'`,
      cwd: workspace(),
      title: null,
      env: ENV,
    });
    await until(() => host.list(owner.sessionId)[0]?.state === "exited");

    const read = host.read(owner, started.shell.shellId, 16);

    // Never more than the bound promised: a cut that fell mid-character is
    // advanced to the next boundary rather than decoded into a U+FFFD, which
    // would re-encode to three bytes and overshoot.
    expect(Buffer.byteLength(read.output)).toBeLessThanOrEqual(16);
    expect(read.truncated).toBe(true);
    // Whole characters only — no replacement character we manufactured. The
    // cut at byte 14 lands inside the character starting at 12, so the read
    // begins at 15: five whole characters, fifteen bytes.
    expect(read.output).not.toContain("\ufffd");
    expect(read.output).toBe("\u8d77".repeat(5));
  });

  it("starts a command beside the caller, and returns what it printed in the settle window", async () => {
    const { host, published } = harness();
    const started = await start(host, "echo listening on :5173; sleep 30");

    expect(started.pid).toBeGreaterThan(0);
    expect(started.output).toBe("listening on :5173\n");
    expect(started.shell).toMatchObject({
      shellId: "sh-1",
      command: "echo listening on :5173; sleep 30",
      title: null,
      state: "running",
      code: null,
      signal: null,
      exitedAt: null,
    });
    expect(started.shell.startedAt).toBeGreaterThan(0);
    // The renderer is told the moment it exists, with the Session it belongs to.
    expect(published[0]).toMatchObject({
      shellId: "sh-1",
      sessionId: "session-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      state: "running",
      pid: started.pid,
    });
    expect(host.list(owner.sessionId).map((shell) => shell.shellId)).toEqual(["sh-1"]);
  });

  it("returns early when the command exits inside the settle window, with its code", async () => {
    const { host } = harness({ settleMs: 3_000 });
    const before = Date.now();
    const started = await start(host, "echo done; exit 3");

    expect(Date.now() - before).toBeLessThan(2_500);
    expect(started.output).toBe("done\n");
    expect(started.shell).toMatchObject({ state: "exited", code: 3, signal: null });
  });

  it("records the exit code, and a read after the exit reports exited — never a stale running", async () => {
    // anthropics/claude-code#13091: the state a read reports is the state at
    // read time. A model polling a dead process would otherwise loop forever.
    const { host, published } = harness();
    const started = await start(host, "sleep 0.3; echo bye; exit 7");
    expect(started.shell.state).toBe("running");

    await until(() => published.some((state) => state.state === "exited"));
    const read = host.read(owner, "sh-1");

    expect(read.shell).toMatchObject({ state: "exited", code: 7, signal: null });
    expect(read.shell.exitedAt).not.toBeNull();
    expect(read.output).toBe("bye\n");
    expect(published.at(-1)).toMatchObject({ shellId: "sh-1", state: "exited", code: 7 });
  });

  it("reads only what is new since the last read, and says when nothing is", async () => {
    const { host } = harness();
    const started = await start(
      host,
      "printf a; sleep 0.3; printf b; sleep 0.3; printf c; sleep 30",
    );

    // The start itself is the first read: the settle output moved the cursor.
    expect(started.output).toBe("a");
    await until(() => host.read(owner, "sh-1").output === "b");
    // The cursor moved with the read above; the next read has nothing.
    await until(() => host.read(owner, "sh-1").output === "c");
    expect(host.read(owner, "sh-1")).toMatchObject({ output: "", truncated: false });
  });

  it("interleaves stderr with stdout in arrival order", async () => {
    const { host } = harness();
    const started = await start(host, "echo out; echo err 1>&2; sleep 30");
    expect(started.output).toBe("out\nerr\n");
  });

  it("answers tail with the last N bytes of everything retained, capped, and marks the cut", async () => {
    const { host } = harness();
    const started = await start(host, "printf 'abcdefghij'; sleep 30");
    // The start moved the cursor past everything; tail ignores the cursor.
    expect(started.output).toBe("abcdefghij");
    expect(host.read(owner, "sh-1").output).toBe("");

    expect(host.read(owner, "sh-1", 4)).toMatchObject({ output: "ghij", truncated: true });
    // Asking for more than there is returns everything, uncut.
    expect(host.read(owner, "sh-1", 100)).toMatchObject({ output: "abcdefghij", truncated: false });
    // The cap lives in policy, not in the caller's number.
    const { host: capped } = harness({ tailMaxBytes: 3 });
    await start(capped, "printf 'abcdefghij'; sleep 30");
    expect(capped.read(owner, "sh-1", 100)).toMatchObject({ output: "hij", truncated: true });
  });

  it("bounds the ring buffer, and reports the bytes it dropped as truncation", async () => {
    const { host } = harness({ outputMaxBytes: 1_000 });
    // Well past the bound, after the settle window so the start reads none of it.
    await start(host, "sleep 0.3; for i in $(seq 1 100); do printf '%0100d' $i; done; sleep 30");
    await until(() => host.tailOf("sh-1")?.output.endsWith("100") === true);

    const read = host.read(owner, "sh-1");
    expect(read.truncated).toBe(true);
    // Exact, not chunk-granular: the last 1,000 bytes of 10,000.
    expect(read.output.length).toBe(1_000);
    expect(read.output.endsWith("100")).toBe(true);
    // Once the dropped bytes are behind the cursor, later reads are whole.
    expect(host.read(owner, "sh-1")).toMatchObject({ output: "", truncated: false });
  });

  it("caps a Session at the policy count, and tells the model what to do about it", async () => {
    const { host } = harness();
    for (let index = 0; index < SHELL_MAX_PER_SESSION; index += 1) await start(host, "sleep 30");

    const refused = start(host, "sleep 30");
    await expect(refused).rejects.toBeInstanceOf(ShellRefusal);
    await expect(refused).rejects.toMatchObject({ rule: "shell.limit" });
    await expect(refused).rejects.toThrow(/kill one/);
    // Another Session's count is its own.
    await expect(start(host, "sleep 30", other)).resolves.toMatchObject({
      pid: expect.any(Number),
    });
    // An exited shell still counts until it is forgotten? No: the cap is on
    // LIVE shells, so a Session that let its shells finish is not stuck.
    host.disposeSession(other.sessionId);
    await host.kill(owner, "sh-1");
    await expect(start(host, "sleep 30")).resolves.toMatchObject({ shell: { shellId: "sh-6" } });
  });

  it("kills with SIGTERM, records the signal, and refuses a second kill as already exited", async () => {
    const { host, published } = harness();
    await start(host, "sleep 30");

    const killed = await host.kill(owner, "sh-1");
    expect(killed.shell).toMatchObject({ state: "exited", code: null, signal: "SIGTERM" });
    expect(published.at(-1)).toMatchObject({ shellId: "sh-1", state: "exited", signal: "SIGTERM" });

    const again = host.kill(owner, "sh-1");
    await expect(again).rejects.toBeInstanceOf(ShellRefusal);
    await expect(again).rejects.toMatchObject({ rule: "shell.exited" });
    // The record and its tail stay readable after the kill.
    expect(host.read(owner, "sh-1").shell.state).toBe("exited");
  });

  it("escalates to SIGKILL after the grace when a shell ignores SIGTERM", async () => {
    const { host } = harness({ killGraceMs: 150 });
    await start(host, "trap '' TERM; sleep 30");

    const killed = await host.kill(owner, "sh-1");
    expect(killed.shell).toMatchObject({ state: "exited", signal: "SIGKILL" });
  });

  it("kills the whole process group, so a server's children die with it", async () => {
    const { host } = harness();
    const started = await start(host, "sleep 30 & sleep 30");
    const groupAlive = (): boolean => {
      try {
        process.kill(-started.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(groupAlive()).toBe(true);
    await host.kill(owner, "sh-1");
    await until(() => !groupAlive());
  });

  it("refuses another Session's shell, and an unknown id, as unknown", async () => {
    const { host } = harness();
    await start(host, "sleep 30");

    expect(() => host.read(other, "sh-1")).toThrow(ShellRefusal);
    expect(() => host.read(other, "sh-1")).toThrow(/sh-1/);
    try {
      host.read(owner, "sh-9");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ rule: "shell.unknown" });
    }
    await expect(host.kill(other, "sh-1")).rejects.toMatchObject({ rule: "shell.unknown" });
    expect(host.list(other.sessionId)).toEqual([]);
  });

  it("kills every shell a Session started when its attachment ends, and forgets them — and nothing before", async () => {
    const { host, removed } = harness();
    const running = await start(host, "sleep 30");
    await start(host, "exit 0", owner, "quick");
    await start(host, "sleep 30", other);
    await until(() => host.read(owner, "sh-2").shell.state === "exited");
    // An exited shell's record stays readable until the attachment ends.
    expect(host.list(owner.sessionId).map((shell) => shell.state)).toEqual(["running", "exited"]);
    expect(removed).toEqual([]);

    host.disposeSession(owner.sessionId);

    expect(host.list(owner.sessionId)).toEqual([]);
    expect(removed.toSorted()).toEqual(["sh-1", "sh-2"]);
    await until(() => {
      try {
        process.kill(-running.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    // The other Session's shell is untouched.
    expect(host.list(other.sessionId).map((shell) => shell.shellId)).toEqual(["sh-3"]);
  });

  it("hands a shell exactly the environment it was given, and nothing of the host's", async () => {
    // The environment is the caller's — the port builds it through the one
    // shared record builder — so the token a shell sees is the token execute
    // saw, and a host secret is not in it.
    const { host } = harness();
    const started = await start(
      host,
      "printenv VOLLI_SESSION_TOKEN; printenv HOME; printenv VOLLI_HOST_ONLY; echo end",
    );
    expect(started.output).toBe("tok-shared\nend\n");
  });

  it("gives the renderer every shell's chrome and tail, and lets the person kill one", async () => {
    const { host } = harness();
    await start(host, "echo hello; sleep 30", owner, "server");
    await start(host, "sleep 30", other);

    expect(host.listAll().map((shell) => [shell.shellId, shell.sessionId, shell.title])).toEqual([
      ["sh-1", "session-1", "server"],
      ["sh-2", "session-2", null],
    ]);
    // The renderer's tail is the whole retained output, and does not move the
    // model's cursor.
    expect(host.tailOf("sh-1")).toMatchObject({ output: "hello\n", shell: { state: "running" } });
    expect(host.read(owner, "sh-1").output).toBe("");
    expect(host.tailOf("sh-9")).toBeNull();

    await host.killAny("sh-1");
    expect(host.tailOf("sh-1")).toMatchObject({ shell: { state: "exited", signal: "SIGTERM" } });
    // A person's kill on an exited shell is a no-op, not a refusal.
    await expect(host.killAny("sh-1")).resolves.toBeUndefined();
    await expect(host.killAny("sh-9")).resolves.toBeUndefined();
  });

  it("uses the wall clock only through the injected now", async () => {
    const now = vi.fn(() => 1_000);
    const { host } = harness({ now });
    const started = await start(host, "exit 0");
    expect(started.shell.startedAt).toBe(1_000);
    expect(started.shell.exitedAt).toBe(1_000);
  });
});
