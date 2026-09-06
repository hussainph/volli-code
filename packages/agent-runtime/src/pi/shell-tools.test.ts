import { NON_CODING_TOOL_IDS, type RuntimeShellPort, type RuntimeShellRecord } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { ShellRefusal } from "../shell/refusal";
import { createShellTool, SHELL_TOOL_NAMES } from "./shell-tools";
import { createSessionTools } from "./tools";

/** The method every fresh fixture port answers with: a loud failure. */
const unused = async (): Promise<never> => {
  throw new Error("this test's port method was not meant to be called");
};

function unusedPort(): RuntimeShellPort {
  return { start: unused, output: unused, kill: unused };
}

const NOW = 1_700_000_000_000;
const clock = (): number => NOW;

function record(overrides: Partial<RuntimeShellRecord> = {}): RuntimeShellRecord {
  return {
    shellId: "sh-1",
    command: "pnpm dev",
    title: null,
    state: "running",
    code: null,
    signal: null,
    startedAt: NOW - 12_000,
    exitedAt: null,
    ...overrides,
  };
}

/** The text half of a tool result, joined the way the model reads it. */
function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .flatMap((entry) => (entry.type === "text" && entry.text !== undefined ? [entry.text] : []))
    .join("\n");
}

describe("shell tools", () => {
  it("reaches the Session's surface through createSessionTools when the one port is wired", async () => {
    const port = unusedPort();
    port.output = async () => ({
      shell: record(),
      output: "",
      truncated: false,
      shells: [record()],
    });
    const tools = createSessionTools({ tools: { tools: [] }, shell: port }, {} as never);

    expect(tools.map((tool) => tool.name)).toEqual([...SHELL_TOOL_NAMES]);
    const read = await tools[1]?.execute("call-0", { shellId: "sh-1" });
    expect(read?.content[0]).toMatchObject({ type: "text" });
  });

  it("names the three shell tools in the Authority vocabulary, last and in the offered order", () => {
    expect(SHELL_TOOL_NAMES).toEqual(["shell_start", "shell_output", "shell_kill"]);
    expect(NON_CODING_TOOL_IDS.slice(-3)).toEqual(SHELL_TOOL_NAMES);
    for (const name of SHELL_TOOL_NAMES) {
      expect(createShellTool(name, unusedPort()).name).toBe(name);
    }
  });

  it("starts a shell, hands back its id and pid, and what it printed in the settle window", async () => {
    const port = unusedPort();
    const calls: unknown[] = [];
    port.start = async (input) => {
      calls.push({ command: input.command, cwd: input.cwd, title: input.title });
      return {
        shell: record({ startedAt: NOW - 1_000 }),
        pid: 4242,
        output: "  VITE ready\n  ➜  Local: http://localhost:5173/\n",
        shells: [record({ startedAt: NOW - 1_000 })],
      };
    };
    const tool = createShellTool("shell_start", port, undefined, clock);

    const result = await tool.execute("call-1", {
      command: "pnpm dev",
      cwd: "/ws/app",
      title: "dev server",
    });
    const text = resultText(result);

    // The structured half rides beside the text: what the activity row is
    // named by and reads its exit code off, so nothing parses the prose.
    expect(result.details).toEqual({
      shellId: "sh-1",
      command: "pnpm dev",
      state: "running",
      exitCode: null,
    });
    expect(calls).toEqual([{ command: "pnpm dev", cwd: "/ws/app", title: "dev server" }]);
    expect(text).toContain("sh-1");
    expect(text).toContain("pid 4242");
    expect(text).toContain("http://localhost:5173/");
    // Every shell result restates the Session's live shells: id, command,
    // age, state — the durable record the model re-reads for free (§4).
    expect(text).toMatch(/sh-1.*running.*1s.*pnpm dev/);
  });

  it("says plainly when a started shell printed nothing yet", async () => {
    const port = unusedPort();
    port.start = async () => ({ shell: record(), pid: 1, output: "", shells: [record()] });
    const tool = createShellTool("shell_start", port, undefined, clock);

    const text = resultText(await tool.execute("call-1", { command: "pnpm dev" }));

    expect(text).toContain("printed nothing");
  });

  it("reads only what is new, and says so, forwarding tail as the explicit override", async () => {
    const port = unusedPort();
    const reads: unknown[] = [];
    port.output = async (input) => {
      reads.push({ shellId: input.shellId, tail: input.tail });
      return {
        shell: record(),
        output: input.tail === undefined ? "line 3\n" : "line 2\nline 3\n",
        truncated: input.tail !== undefined,
        shells: [record()],
      };
    };
    const tool = createShellTool("shell_output", port, undefined, clock);

    const fresh = resultText(await tool.execute("call-1", { shellId: "sh-1" }));
    expect(fresh).toContain("running");
    expect(fresh).toContain("since the last read");
    expect(fresh).toContain("line 3");
    expect(fresh).not.toContain("line 2");

    const tail = resultText(await tool.execute("call-2", { shellId: "sh-1", tail: 12 }));
    // The GRANTED byte count, not the requested one: the fixture hands back
    // 14 bytes for a request of 12, and the text must describe what arrived.
    expect(tail).toContain("last 14 bytes");
    expect(tail).not.toContain("last 12 bytes");
    expect(tail).toContain("line 2");
    // Truncation is stated, so the model knows the head is gone rather than
    // guessing from a line that starts mid-word.
    expect(tail).toContain("dropped");
    expect(reads).toEqual([
      { shellId: "sh-1", tail: undefined },
      { shellId: "sh-1", tail: 12 },
    ]);
  });

  it("reports the bytes the host granted, never the megabyte the model asked for", async () => {
    // The host clamps `tail` to its own cap. Echoing the request would
    // promise a million bytes beside the handful actually handed back.
    const port = unusedPort();
    port.output = async () => ({
      shell: record(),
      output: "tail end\n",
      truncated: true,
      shells: [record()],
    });
    const tool = createShellTool("shell_output", port, undefined, clock);

    const text = resultText(await tool.execute("call-1", { shellId: "sh-1", tail: 1_000_000 }));

    expect(text).toContain("last 9 bytes");
    expect(text).not.toContain("1000000");
  });

  it("counts bytes rather than UTF-16 code units, because every bound it states is bytes", async () => {
    const port = unusedPort();
    // Four characters, ten bytes: three 3-byte CJK codepoints and a newline.
    port.output = async () => ({
      shell: record(),
      output: "\u8d77\u52d5\u4e2d\n",
      truncated: false,
      shells: [record()],
    });
    const tool = createShellTool("shell_output", port, undefined, clock);

    const text = resultText(await tool.execute("call-1", { shellId: "sh-1" }));

    expect(text).toContain("(10 bytes)");
    expect(text).not.toContain("(4 bytes)");
  });

  it("reports an exited shell as exited with its code on the read, never as a stale running", async () => {
    // anthropics/claude-code#13091: a read that keeps saying "running" after
    // the process died sends the model into a poll loop on a corpse. The
    // state on the result is the port's word at read time, and the text leads
    // with it.
    const port = unusedPort();
    port.output = async () => ({
      shell: record({ state: "exited", code: 1, exitedAt: NOW - 500 }),
      output: "error: boom\n",
      truncated: false,
      shells: [record({ state: "exited", code: 1, exitedAt: NOW - 500 })],
    });
    const tool = createShellTool("shell_output", port, undefined, clock);

    const result = await tool.execute("call-1", { shellId: "sh-1" });
    const text = resultText(result);

    expect(result.details).toMatchObject({ state: "exited", exitCode: 1 });
    expect(text.split("\n")[0]).toMatch(/exited/);
    expect(text).toContain("code 1");
    expect(text).not.toMatch(/^.*is running/m);
    expect(text).toContain("error: boom");
  });

  it("says when a read had nothing new, so an empty result is not mistaken for an empty shell", async () => {
    const port = unusedPort();
    port.output = async () => ({
      shell: record(),
      output: "",
      truncated: false,
      shells: [record()],
    });
    const tool = createShellTool("shell_output", port, undefined, clock);

    expect(resultText(await tool.execute("call-1", { shellId: "sh-1" }))).toContain(
      "No new output",
    );
  });

  it("kills a shell and reports how it ended", async () => {
    const port = unusedPort();
    port.kill = async () => ({
      shell: record({ state: "exited", code: null, signal: "SIGTERM", exitedAt: NOW }),
      shells: [],
    });
    const tool = createShellTool("shell_kill", port, undefined, clock);

    const text = resultText(await tool.execute("call-1", { shellId: "sh-1" }));

    expect(text).toContain("sh-1");
    expect(text).toContain("SIGTERM");
    expect(text).toContain("no background shells");
  });

  it("restates every live shell with id, state, age and the command's first line", async () => {
    const port = unusedPort();
    port.output = async () => ({
      shell: record(),
      output: "",
      truncated: false,
      shells: [
        record(),
        record({
          shellId: "sh-2",
          command: "pnpm test --watch\n# second line never shown",
          title: "tests",
          state: "exited",
          code: 0,
          startedAt: NOW - 3_600_000 * 2,
          exitedAt: NOW - 60_000,
        }),
      ],
    });
    const tool = createShellTool("shell_output", port, undefined, clock);

    const text = resultText(await tool.execute("call-1", { shellId: "sh-1" }));

    // The cap counts running shells, so the footer states running against it
    // and keeps the corpse in the list without charging it a slot.
    expect(text).toContain("1 running of 4, 1 exited and still readable");
    expect(text).toMatch(/sh-1.*running.*12s.*pnpm dev/);
    expect(text).toMatch(/sh-2.*exited 0.*2h.*tests/);
    expect(text).not.toContain("second line never shown");
  });

  it("never tells the model it is over a cap it is nowhere near", async () => {
    // Four corpses and one server: the cap counts RUNNING, so this Session
    // holds one of four and may start three more. A footer that counted
    // records would read "5 of 4" and stop the model starting anything.
    const port = unusedPort();
    const dead = (id: string): RuntimeShellRecord =>
      record({ shellId: id, state: "exited", code: 0, exitedAt: NOW - 1_000 });
    port.output = async () => ({
      shell: record(),
      output: "",
      truncated: false,
      shells: [dead("sh-1"), dead("sh-2"), dead("sh-3"), dead("sh-4"), record({ shellId: "sh-5" })],
    });
    const tool = createShellTool("shell_output", port, undefined, clock);

    const text = resultText(await tool.execute("call-1", { shellId: "sh-5" }));

    expect(text).toContain("1 running of 4, 4 exited and still readable");
    expect(text).not.toMatch(/\b5 of 4\b/);
  });

  it("states only the cap when every shell it holds is running", async () => {
    const port = unusedPort();
    port.output = async () => ({
      shell: record(),
      output: "",
      truncated: false,
      shells: [record(), record({ shellId: "sh-2" })],
    });
    const tool = createShellTool("shell_output", port, undefined, clock);

    const text = resultText(await tool.execute("call-1", { shellId: "sh-1" }));

    expect(text).toContain("2 running of 4");
    expect(text).not.toContain("still readable");
  });

  it("words every way a shell can stand: minutes and hours of age, a signal, an exit with no code, a cut line", async () => {
    const port = unusedPort();
    const long = `pnpm ${"x".repeat(100)}`;
    port.output = async () => ({
      shell: record({
        command: long,
        state: "exited",
        code: null,
        signal: "SIGKILL",
        startedAt: NOW - 90_000,
        // No exit time recorded: the age is measured to now.
        exitedAt: null,
      }),
      // No trailing newline: printed as it stands, not cut by one.
      output: "partial",
      truncated: false,
      shells: [
        record({ shellId: "sh-m", startedAt: NOW - 5 * 60_000 }),
        // Exited with neither code nor signal — a spawn that failed after a
        // pid was handed out — reads as an unknown exit rather than a crash.
        record({ shellId: "sh-q", state: "exited", code: null, signal: null }),
      ],
    });
    const tool = createShellTool("shell_output", port, undefined, clock);

    const text = resultText(await tool.execute("call-1", { shellId: "sh-1" }));

    expect(text).toContain("exited by signal SIGKILL after 1m");
    expect(text).toContain(`pnpm ${"x".repeat(74)}…`);
    expect(text).toMatch(/partial\n/);
    expect(text).toMatch(/sh-m.*running.*5m/);
    expect(text).toMatch(/sh-q.*exited \?/);

    // The same unknown exit, as a headline.
    port.output = async () => ({
      shell: record({ state: "exited", code: null, signal: null, exitedAt: NOW }),
      output: "",
      truncated: false,
      shells: [],
    });
    expect(resultText(await tool.execute("call-2", { shellId: "sh-1" }))).toContain(
      "exited with code ? after 12s",
    );
  });

  it("withdraws a call in flight when the attachment's live signal fires, and forgets the listener after", async () => {
    const port = unusedPort();
    const attachment = new AbortController();
    let seen: AbortSignal | null = null;
    port.output = async (input) => {
      seen = input.signal;
      attachment.abort();
      return { shell: record(), output: "", truncated: false, shells: [] };
    };
    await createShellTool("shell_output", port, attachment.signal).execute("c1", {
      shellId: "sh-1",
    });
    expect(seen!.aborted).toBe(true);
  });

  it("answers a refusal with the rule that made it, rather than failing the call", async () => {
    const port = unusedPort();
    port.start = async () => {
      throw new ShellRefusal(
        "shell.limit",
        "This Session already holds 4 background shells: kill one with shell_kill, or reuse one.",
      );
    };
    port.output = async () => {
      throw new ShellRefusal("shell.unknown", "No background shell sh-9 belongs to this Session.");
    };
    port.kill = async () => {
      throw new ShellRefusal("shell.exited", "Background shell sh-1 already exited.");
    };

    const started = resultText(
      await createShellTool("shell_start", port).execute("c1", { command: "sleep 9" }),
    );
    expect(started).toContain("Volli refused the shell action");
    expect(started).toContain("shell.limit");
    expect(started).toContain("kill one");

    const read = resultText(
      await createShellTool("shell_output", port).execute("c2", { shellId: "sh-9" }),
    );
    expect(read).toContain("shell.unknown");

    const killed = resultText(
      await createShellTool("shell_kill", port).execute("c3", { shellId: "sh-1" }),
    );
    expect(killed).toContain("shell.exited");
  });

  it("lets anything but a refusal fail the call, because that is a broken host", async () => {
    const port = unusedPort();
    port.output = async () => {
      throw new Error("the process table is gone");
    };
    await expect(
      createShellTool("shell_output", port).execute("c1", { shellId: "sh-1" }),
    ).rejects.toThrow("the process table is gone");
  });

  it("withdraws a port call when the attachment's signal or the call's fires", async () => {
    const port = unusedPort();
    const seen: boolean[] = [];
    port.output = async (input) => {
      seen.push(input.signal.aborted);
      return { shell: record(), output: "", truncated: false, shells: [] };
    };
    const attachment = new AbortController();
    attachment.abort();
    await createShellTool("shell_output", port, attachment.signal).execute("c1", {
      shellId: "sh-1",
    });
    const call = new AbortController();
    call.abort();
    await createShellTool("shell_output", port).execute("c2", { shellId: "sh-1" }, call.signal);
    expect(seen).toEqual([true, true]);
  });

  it("tells the model what a background shell is for, and what it is not", () => {
    const start = createShellTool("shell_start", unusedPort());
    const output = createShellTool("shell_output", unusedPort());
    expect(start.description).toContain("beside");
    expect(start.parameters).toMatchObject({ required: ["command"] });
    // Reads are incremental by default; the model has to be told, because
    // the schema cannot say it.
    expect(output.description).toContain("since the last read");
    expect(output.parameters).toMatchObject({ required: ["shellId"] });
  });
});
