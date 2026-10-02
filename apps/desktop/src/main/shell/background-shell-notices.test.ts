/**
 * What a background shell tells its Session by itself (VC-495), proved at the
 * host's public interface with real children: `start`, `read`, `kill`,
 * `killAny` and `disposeSession` in, `onNotice` out. The delivery of a notice
 * into a chat is `shell-notices.test.ts`'s business; this file owns WHEN the
 * host speaks, WHAT it hands over, and what it never lets through unredacted.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRefusal } from "@volli/agent-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  BackgroundShellHost,
  SHELL_NOTICE_TAIL_MAX_BYTES,
  type BackgroundShellNotice,
  type BackgroundShellOwner,
} from "./background-shell-host";

const owner: BackgroundShellOwner = {
  sessionId: "session-1",
  attachmentId: "attachment-1",
  projectId: "project-1",
  ticketId: "ticket-1",
};

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

const hosts: BackgroundShellHost[] = [];

function harness(overrides: Partial<ConstructorParameters<typeof BackgroundShellHost>[0]> = {}) {
  const notices: BackgroundShellNotice[] = [];
  let ids = 0;
  const host = new BackgroundShellHost({
    publishState: () => {},
    publishRemoved: () => {},
    createId: () => `sh-${++ids}`,
    settleMs: 150,
    killGraceMs: 200,
    exitNoticeGraceMs: 40,
    onNotice: (notice) => notices.push(notice),
    ...overrides,
  });
  hosts.push(host);
  return { host, notices };
}

function start(
  host: BackgroundShellHost,
  command: string,
  options: { title?: string | null; notifyOn?: { pattern: string; regex: boolean } } = {},
) {
  return host.start(owner, {
    command,
    cwd: mkdtempSync(join(tmpdir(), "volli-shell-notice-")),
    title: options.title ?? null,
    env: ENV,
    ...(options.notifyOn === undefined ? {} : { notifyOn: options.notifyOn }),
  });
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const host of hosts.splice(0)) host.disposeSession(owner.sessionId);
});

describe("an exit notice", () => {
  it("tells the owning Session when a shell exits on its own, with how it ended, how long it ran and a tail of what it printed", async () => {
    // A clock that ticks 5s per reading: the host reads it once at the start
    // and once at the exit, so the runtime is 5s whatever the machine's speed.
    let readings = 0;
    const { host, notices } = harness({ now: () => 5_000 * (readings += 1) });

    const started = await start(host, "echo building; sleep 0.4; echo FAILED >&2; exit 3", {
      title: "ci run",
    });
    expect(started.shell.state).toBe("running");
    await until(() => notices.length > 0);

    expect(notices).toEqual([
      {
        kind: "exited",
        sessionId: "session-1",
        shellId: "sh-1",
        label: "ci run",
        code: 3,
        signal: null,
        runtimeMs: 5_000,
        byPerson: false,
        tail: "building\nFAILED\n",
        truncated: false,
      },
    ]);
  });
});

/** The one exit notice a test waits for. */
async function exitNotice(notices: BackgroundShellNotice[]) {
  await until(() => notices.length > 0);
  const notice = notices[0];
  if (notice?.kind !== "exited") throw new Error("expected an exit notice");
  return notice;
}

describe("what an exit notice carries out of the host", () => {
  it("scrubs the tail with the stored-credential redactor, so a value the person typed never reaches the chat", async () => {
    const { host, notices } = harness({
      redactOutput: (text) => text.replaceAll("hunter2-the-stored-value", "[redacted]"),
    });
    await start(host, "sleep 0.3; echo password is hunter2-the-stored-value; exit 1");

    const notice = await exitNotice(notices);

    expect(notice.tail).toBe("password is [redacted]\n");
  });

  it("scrubs the tail with the shared pattern redactor too, with no credential store involved", async () => {
    const { host, notices } = harness();
    await start(
      host,
      "sleep 0.3; echo token ghp_0123456789abcdefghijklmnopqrstuvwxyz01; echo Authorization: Bearer abc.def.ghi; exit 1",
    );

    const notice = await exitNotice(notices);

    expect(notice.tail).not.toContain("ghp_0123456789");
    expect(notice.tail).not.toContain("abc.def.ghi");
    expect(notice.tail).toContain("[redacted]");
  });

  it("redacts before it cuts, so a secret straddling the tail's cut leaves no fragment behind", async () => {
    const secret = `ghp_${"A1b2".repeat(9)}`;
    const before = `${"z".repeat(100)}\n`;
    // Sized so that a cut made BEFORE redaction would start ten bytes into the
    // secret and keep thirty of its characters.
    const after = `\n${"y".repeat(SHELL_NOTICE_TAIL_MAX_BYTES + 10 - secret.length - 1)}`;
    const { host, notices } = harness();
    await start(host, `sleep 0.3; printf '%s' '${before}${secret}${after}'; exit 1`);

    const notice = await exitNotice(notices);

    expect(notice.truncated).toBe(true);
    expect(notice.tail).not.toContain(secret.slice(10));
    expect(notice.tail).toContain("[redacted]");
  });

  it("bounds the tail to a few kilobytes and says it was cut", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 0.3; seq 1 3000; exit 1");

    const notice = await exitNotice(notices);

    expect(Buffer.byteLength(notice.tail)).toBeLessThanOrEqual(SHELL_NOTICE_TAIL_MAX_BYTES);
    expect(notice.tail.endsWith("2999\n3000\n")).toBe(true);
    expect(notice.truncated).toBe(true);
  });

  it("counts the tail as read, so the shell_output that follows is not a repeat of it", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 0.3; echo the-end; exit 1");

    const notice = await exitNotice(notices);

    expect(notice.tail).toBe("the-end\n");
    expect(host.read(owner, "sh-1")).toMatchObject({ output: "", truncated: false });
  });

  it("names the shell by its title, or by the command's first line — scrubbed and short", async () => {
    const { host, notices } = harness();
    const longLine = `sleep 0.3; echo ${"w".repeat(200)} # API_KEY=sk-live-0123456789abcdef`;
    await start(host, `${longLine}\nexit 1`);
    await start(host, "sleep 0.3 # secret=sk-live-0123456789abcdef", {
      title: "deploy sk-live-0123456789abcdef",
    });

    await until(() => notices.length === 2);
    const labels = notices.map((notice) => notice.label);

    for (const label of labels) {
      expect(label).not.toContain("sk-live-0123456789abcdef");
      expect([...label].length).toBeLessThanOrEqual(80);
    }
    expect(labels.toSorted()).toEqual([
      expect.stringMatching(/^deploy /),
      expect.stringMatching(/^sleep 0\.3; echo w+/),
    ]);
  });
});

/** Every `matched` notice so far. */
const matches = (notices: BackgroundShellNotice[]) =>
  notices.filter((notice) => notice.kind === "matched");

describe("a notifyOn match notice", () => {
  it("tells the Session the first time a literal appears in the output, while the shell keeps running", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 0.3; echo compiling; echo listening on :5173; sleep 30", {
      title: "dev server",
      notifyOn: { pattern: "listening on", regex: false },
    });

    await until(() => matches(notices).length > 0);

    expect(notices).toEqual([
      {
        kind: "matched",
        sessionId: "session-1",
        shellId: "sh-1",
        label: "dev server",
        pattern: "listening on",
        regex: false,
        line: "listening on :5173",
      },
    ]);
    expect(host.list(owner.sessionId)[0]?.state).toBe("running");
  });

  it("matches a regex against whole lines", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 0.3; echo ok; echo FAIL 12 tests; sleep 30", {
      notifyOn: { pattern: "FAIL \\d+ tests", regex: true },
    });

    await until(() => matches(notices).length > 0);

    expect(matches(notices)[0]).toMatchObject({ line: "FAIL 12 tests", regex: true });
  });

  it("finds a line that arrives in pieces", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 0.3; printf 'listen'; sleep 0.2; printf 'ing on :1\\n'; sleep 30", {
      notifyOn: { pattern: "listening on", regex: false },
    });

    await until(() => matches(notices).length > 0);

    expect(matches(notices)[0]).toMatchObject({ line: "listening on :1" });
  });

  it("sends one per shell however chatty the shell is — the flood bound", async () => {
    const { host, notices } = harness();
    // Every line matches, for as long as the process lives.
    await start(host, "sleep 0.3; i=0; while [ $i -lt 400 ]; do echo tick $i; i=$((i+1)); done", {
      notifyOn: { pattern: "tick", regex: false },
    });

    await until(() => notices.some((notice) => notice.kind === "exited"));
    await pause(100);

    expect(matches(notices)).toHaveLength(1);
    expect(matches(notices)[0]).toMatchObject({ line: "tick 0" });
  });

  it("does not repeat what shell_start already showed the model in its settle window", async () => {
    const { host, notices } = harness();
    const started = await start(
      host,
      "echo listening on :5173; sleep 0.4; echo listening again; sleep 30",
      {
        notifyOn: { pattern: "listening", regex: false },
      },
    );
    expect(started.output).toBe("listening on :5173\n");

    await pause(700);

    expect(notices).toEqual([]);
  });

  it("tests a last line that never got its newline when the shell exits, and says so before the exit", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 0.3; printf FAIL; exit 1", {
      notifyOn: { pattern: "FAIL", regex: false },
    });

    await until(() => notices.length === 2);

    expect(notices.map((notice) => notice.kind)).toEqual(["matched", "exited"]);
  });

  it("matches against the redacted line, so a pattern cannot be used to probe for a secret", async () => {
    const { host, notices } = harness({
      redactOutput: (text) => text.replaceAll("hunter2-the-stored-value", "[redacted]"),
    });
    await start(host, "sleep 0.3; echo password is hunter2-the-stored-value; sleep 30", {
      notifyOn: { pattern: "hunter2", regex: false },
    });
    await start(host, "sleep 0.3; echo password is hunter2-the-stored-value; sleep 30", {
      notifyOn: { pattern: "password is", regex: false },
    });

    await until(() => matches(notices).length > 0);
    await pause(300);

    expect(matches(notices)).toEqual([
      expect.objectContaining({ shellId: "sh-2", line: "password is [redacted]" }),
    ]);
  });

  it("scrubs and bounds the line it quotes", async () => {
    const { host, notices } = harness();
    await start(
      host,
      `sleep 0.3; echo hit ghp_0123456789abcdefghijklmnopqrstuvwxyz01 ${"x".repeat(900)}; sleep 30`,
      { notifyOn: { pattern: "hit", regex: false } },
    );

    await until(() => matches(notices).length > 0);
    const line = (matches(notices)[0] as { line: string }).line;

    expect(line).not.toContain("ghp_0123");
    expect(line).toContain("[redacted]");
    expect([...line].length).toBeLessThanOrEqual(500);
  });

  it("drops the rest of a line that outgrows its buffer, and still finds the next line", async () => {
    const { host, notices } = harness();
    // 30 kB with no newline, then an ordinary line. The pattern sits in the
    // long line's dropped remainder as well as in the next line.
    await start(
      host,
      "sleep 0.3; head -c 30000 /dev/zero | tr '\\0' x; echo listening-in-the-tail-of-a-long-line; echo; echo listening on :1; sleep 30",
      { notifyOn: { pattern: "listening", regex: false } },
    );

    await until(() => matches(notices).length > 0);
    await pause(100);

    expect(matches(notices)).toHaveLength(1);
    expect(matches(notices)[0]).toMatchObject({ line: "listening on :1" });
  });

  it("does not turn a half-printed line into a match once the Session has killed the shell itself", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 0.2; printf listening; sleep 30", {
      notifyOn: { pattern: "listening", regex: false },
    });
    await pause(500);
    // No newline yet, so nothing has matched.
    expect(notices).toEqual([]);

    await host.kill(owner, "sh-1");
    await pause(300);

    expect(notices).toEqual([]);
  });

  it("goes quiet when the Session's attachment ends", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 0.4; echo listening; sleep 30", {
      notifyOn: { pattern: "listening", regex: false },
    });

    host.disposeSession(owner.sessionId);
    await pause(700);

    expect(notices).toEqual([]);
  });
});

describe("a notice sink that fails", () => {
  it("is logged and does not take the shell host down with it", async () => {
    // The sink runs inside the child's `close` and `data` handlers: a throw
    // there would be an uncaught exception in main, and a shell the model
    // can still read is worth more than a notice that could not be sent.
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const { host } = harness({
        onNotice: () => {
          throw new Error("sink down");
        },
      });
      await start(host, "sleep 0.3; echo hit; exit 2", {
        notifyOn: { pattern: "hit", regex: false },
      });
      await until(() => errors.length >= 2);

      expect(host.read(owner, "sh-1")).toMatchObject({
        shell: { state: "exited", code: 2 },
        output: "",
      });
      expect(errors.map((args) => String(args[1]))).toEqual([
        expect.stringContaining("sink down"),
        expect.stringContaining("sink down"),
      ]);
    } finally {
      console.error = originalError;
    }
  });
});

describe("a notifyOn pattern the host will not run", () => {
  const refused = [
    ["a regex that does not compile", { pattern: "(", regex: true }],
    ["an empty pattern", { pattern: "", regex: false }],
    ["a literal that spans lines", { pattern: "one\ntwo", regex: false }],
    ["a pattern over the length bound", { pattern: "a".repeat(201), regex: false }],
    ["a repeated group that repeats inside itself", { pattern: "(a+)+$", regex: true }],
    ["a repeated group of alternatives", { pattern: "(a|aa)*b", regex: true }],
    ["a back-reference", { pattern: "(a)\\1", regex: true }],
    ["a pattern with a run of open-ended repeats", { pattern: ".*a.*b.*c", regex: true }],
  ] as const;

  it.each(refused)("refuses %s before anything is spawned", async (_name, notifyOn) => {
    const { host } = harness();

    const failed = await start(host, "sleep 30", { notifyOn }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(ShellRefusal);
    expect(failed).toMatchObject({ rule: "shell.pattern" });
    expect(host.list(owner.sessionId)).toEqual([]);
  });

  it.each([
    ["a literal full of regex metacharacters", { pattern: "(a+)+$", regex: false }],
    ["an ordinary alternation", { pattern: "error|FAIL|panic", regex: true }],
    ["a port", { pattern: "listening on :\\d+", regex: true }],
    ["an optional group", { pattern: "(Compiled )?successfully", regex: true }],
    ["a class holding repeat characters", { pattern: "[+*]{2}", regex: true }],
  ] as const)("runs %s", async (_name, notifyOn) => {
    const { host } = harness();

    const started = await start(host, "sleep 30", { notifyOn });

    expect(started.shell.state).toBe("running");
  });
});

describe("an exit the model has already seen", () => {
  it("is not repeated when the model read the exit with shell_output before the notice went out", async () => {
    const { host, notices } = harness({ exitNoticeGraceMs: 400 });
    await start(host, "sleep 0.3; echo bye; exit 7");

    // A read while it still runs tells the model nothing about an exit.
    expect(host.read(owner, "sh-1").shell.state).toBe("running");
    await until(() => host.list(owner.sessionId)[0]?.state === "exited");
    const read = host.read(owner, "sh-1");
    expect(read).toMatchObject({ output: "bye\n", shell: { state: "exited", code: 7 } });
    await pause(700);

    expect(notices).toEqual([]);
  });

  it("still comes when the model only read the shell while it was running", async () => {
    const { host, notices } = harness({ exitNoticeGraceMs: 100 });
    await start(host, "sleep 0.3; exit 7");
    host.read(owner, "sh-1");

    await until(() => notices.length > 0);

    expect(notices[0]).toMatchObject({ kind: "exited", code: 7 });
  });

  it("is not sent for a shell whose exit shell_start itself reported inside its settle window", async () => {
    // Zero grace is the sharpest case: a timer that fired as soon as the exit
    // landed would beat `start` back to the model.
    const { host, notices } = harness({ exitNoticeGraceMs: 0, settleMs: 3_000 });

    const started = await start(host, "echo done; exit 3");
    expect(started.shell).toMatchObject({ state: "exited", code: 3 });
    await pause(300);

    expect(notices).toEqual([]);
  });
});

describe("who ended the shell", () => {
  it("stays quiet about a shell the Session's own shell_kill ended — its tool result already said so", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 30");

    const killed = await host.kill(owner, "sh-1");
    expect(killed.shell).toMatchObject({ state: "exited", signal: "SIGTERM" });
    // Well past the grace: a notice that was going to come would have.
    await pause(200);

    expect(notices).toEqual([]);
  });

  it("tells the Session when a person ended its shell from the Island, because nothing else would", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 30");

    await host.killAny("sh-1");
    await until(() => notices.length > 0);

    expect(notices).toEqual([
      expect.objectContaining({
        kind: "exited",
        sessionId: "session-1",
        shellId: "sh-1",
        code: null,
        signal: "SIGTERM",
        byPerson: true,
      }),
    ]);
  });

  it("drops an exit notice still waiting out its grace when the Session's attachment ends", async () => {
    // The shell exited on its own, and the Session went away before the notice
    // was due: there is no one left to tell.
    const { host, notices } = harness({ exitNoticeGraceMs: 300 });
    await start(host, "sleep 0.3; exit 2");
    await until(() => host.list(owner.sessionId)[0]?.state === "exited");

    host.disposeSession(owner.sessionId);
    await pause(600);

    expect(notices).toEqual([]);
  });

  it("says nothing for shells that die with their Session's attachment", async () => {
    const { host, notices } = harness();
    await start(host, "sleep 30");
    await start(host, "sleep 0.3");

    host.disposeSession(owner.sessionId);
    await pause(600);

    expect(notices).toEqual([]);
  });
});
