/** Real hostd, Pi, SQLite and socket; only the provider wire is scripted. */
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { piOwnedModelAccess } from "@volli/agent-runtime";
import { shortSessionId } from "@volli/shared";
import {
  scriptedProvider,
  type ScriptedReply,
} from "../../../packages/agent-runtime/test-fixtures/scripted-provider";
import { insertProject } from "@volli/host-core/db/projects-repo";
import { insertTicket } from "@volli/host-core/db/tickets-repo";
import { listRunsForTicket } from "@volli/host-core/db/automations-repo";
import {
  fileSecretKey,
  SecretStore,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
} from "@volli/host-core/secrets";
import { testProject, testTicket } from "@volli/host-core/db/test-helpers";
import { startHostd, type RunningHostd } from "./hostd";
import { headlessRuntimePaths } from "./runtime-paths";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const cliBundle = join(repo, "packages/cli/dist/volli.cjs");
const roots: string[] = [];
const hosts: RunningHostd[] = [];
beforeAll(() =>
  execFileSync("pnpm", ["--filter", "@volli/hostd", "--filter", "@volli/cli", "build"], {
    cwd: repo,
    stdio: "pipe",
  }),
);
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const host of hosts.splice(0)) await host.stop("test done");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(
  replies?: ScriptedReply[],
  busyProof = false,
  credentialFault?: "locked" | "refused" | "corrupt",
) {
  const root = mkdtempSync(join(tmpdir(), "hostd-turn-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  if (credentialFault !== undefined) {
    const keyPath = join(dataDir, SECRET_KEY_FILE_NAME);
    const storePath = join(dataDir, SECRET_STORE_FILE_NAME);
    new SecretStore(storePath, fileSecretKey({ path: keyPath })).put({
      name: "SENTINEL",
      value: "fixture-secret",
      scope: "always",
    });
    if (credentialFault === "locked") rmSync(keyPath);
    else if (credentialFault === "refused") chmodSync(keyPath, 0o640);
    else writeFileSync(storePath, "not a sealed store");
  }
  const directory = join(root, "project");
  if (busyProof) {
    const repository = join(root, "repository");
    mkdirSync(repository);
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
    writeFileSync(
      join(repository, ".gitignore"),
      "node_modules/\nactive\nrelease\nrelease-shell\nshell.pid\n",
    );
    execFileSync("git", ["-C", repository, "add", ".gitignore"]);
    execFileSync("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    execFileSync("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "proof-worktree",
      directory,
    ]);
  } else {
    mkdirSync(directory);
  }
  const script = scriptedProvider(
    replies ?? [
      {
        tool: {
          name: "write",
          args: { path: "proof.txt", content: "CLI scripted turn completed\n" },
        },
      },
      { text: "Headless CLI turn complete" },
    ],
  );
  const modelAccess = {
    ...piOwnedModelAccess({ agentDir: join(root, "pi") }),
    models: script.models,
  };
  const operator = "fixture-operator";
  const operatorsFile = join(root, "operators");
  writeFileSync(
    operatorsFile,
    `ops ${process.getuid!()} sha256:${createHash("sha256").update(operator).digest("hex")} now\n`,
    { mode: 0o600 },
  );
  const socketPath = join(dataDir, "volli.sock");
  const launch = () =>
    startHostd({
      dataDir,
      socketPath,
      operatorsFile,
      operatorsOwnerUid: process.getuid!(),
      version: "test",
      env: { HOME: root, PATH: process.env.PATH },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      runtime: {
        binDir: join(repo, "packages/cli/dist"),
        venue: { id: socketPath, kind: "remote" },
        modelAccess,
      },
    });
  const host = await launch();
  hosts.push(host);
  if (!host.host.database.ok) throw new Error(host.host.database.error);
  insertProject(
    host.host.database.db,
    testProject({ id: "p", path: directory, ticketPrefix: "VC" }),
  );
  insertTicket(
    host.host.database.db,
    testTicket("p", { id: "t", ticketNumber: 1, usesWorktree: false }),
  );
  const cli = async (...argv: string[]) =>
    JSON.parse(
      (
        await exec(process.execPath, [cliBundle, ...argv, "--json"], {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            VOLLI_SOCKET: socketPath,
            VOLLI_OPERATOR_TOKEN: operator,
          },
        })
      ).stdout,
    );
  const restart = async () => {
    expect(await host.stop("restart proof")).toBe(true);
    const recovered = await launch();
    hosts.push(recovered);
    return recovered;
  };
  return { host, script, cli, directory, restart };
}

describe("Linux CLI scripted-provider proof (VC-622)", () => {
  it("starts over the built CLI, runs a real tool, completes and exposes its answer", async () => {
    const f = await fixture();
    const completed = Promise.withResolvers<void>();
    const unsubscribe = f.host.host.sessionWakeBus!.subscribe(({ event }) => {
      if (event.payload.kind === "turn.completed") completed.resolve();
    });
    try {
      const started = await f.cli(
        "session",
        "start",
        "VC-1",
        "--model",
        "scripted-fixture/scripted",
        "--reasoning",
        "off",
        "--title",
        "Permanent proof",
        "-m",
        "Write the proof",
      );
      expect(started.state).toBe("ready");
      await completed.promise;
      const projection = await f.host.host.sessionEngine!.getSession({
        sessionId: started.sessionId,
      });
      expect(projection!.lastTurnOutcome).toBe("completed");
      expect(readFileSync(join(f.directory, "proof.txt"), "utf8")).toBe(
        "CLI scripted turn completed\n",
      );
      expect(await f.cli("session", "answer", started.session)).toMatchObject({
        state: "completed",
        answer: "Headless CLI turn complete",
      });
      expect(f.host.status().capabilities).toMatchObject({
        sessions: "available",
        automations: "available",
        browser: "unavailable",
        terminals: "unavailable",
      });
      const events = await f.host.host.sessionEngine!.listEvents({ sessionId: started.sessionId });
      const surface = events.find(
        ({ payload }) =>
          payload.kind === "session.input.recorded" && payload.input.kind === "tool-surface",
      )!.payload;
      if (surface.kind !== "session.input.recorded" || surface.input.kind !== "tool-surface")
        throw new Error("No frozen surface");
      expect(surface.input.tools).not.toContain("ask_user");
      expect(surface.input.tools).not.toContain("request_secret");
      expect(surface.input.tools.some((name) => name.startsWith("browser_"))).toBe(false);
      expect(surface.input.tools).toContain("shell_start");
      expect(projection!.attachments[0]!.venue.kind).toBe("remote");
      console.log(
        "VC-622 Linux CLI proof: Session birth, actual write tool, turn.completed, CLI answer",
      );
      const rebooted = await f.restart();
      expect(await f.cli("session", "answer", started.session)).toMatchObject({
        state: "completed",
      });
      const restored = await rebooted.host.sessionEngine!.getSession({
        sessionId: started.sessionId,
      });
      expect(restored!.session.title).toBe("Permanent proof");
      expect(restored!.lastTurnOutcome).toBe("completed");
    } finally {
      unsubscribe();
    }
  }, 20_000);

  it.each(["locked", "refused", "corrupt"] as const)(
    "runs a secret-independent turn while saved credentials are %s",
    async (fault) => {
      const f = await fixture([{ text: "No saved secret required" }], false, fault);
      expect(f.host.status().credentials!.state).toBe(fault);
      expect(f.host.status().credentials!.unavailable).toContain("session-env");
      const started = await f.cli(
        "session",
        "start",
        "VC-1",
        "--model",
        "scripted-fixture/scripted",
        "--reasoning",
        "off",
        "--title",
        "Credential proof",
        "-m",
        "No secrets required",
      );
      await vi.waitFor(
        async () =>
          expect((await f.cli("session", "answer", started.session)).state).toBe("completed"),
        { timeout: 5_000 },
      );
    },
    20_000,
  );

  it("starts and completes an armed Automation after a CLI board move", async () => {
    // Utility auto-titling and the turn can race; both wires return the same text.
    const f = await fixture([
      { text: "Armed Automation completed" },
      { text: "Armed Automation completed" },
    ]);
    if (!f.host.host.database.ok) throw new Error("No database");
    const db = f.host.host.database.db;
    const engine = f.host.host.automations.createEngine()!;
    const created = await engine.create({
      commandId: "create",
      projectId: "p",
      name: "CLI armed proof",
      instructions: "Write the proof",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
    });
    if (!created.ok) throw new Error(created.error);
    expect(
      await engine.setEnabled({
        commandId: "enable",
        automationId: created.value.id,
        enabled: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await engine.setColumnArming({
        commandId: "arm",
        projectId: "p",
        status: "doing",
        automationId: created.value.id,
      }),
    ).toMatchObject({ ok: true });
    await f.cli("ticket", "move", "VC-1", "--to", "doing");
    await vi.waitFor(
      async () => {
        const run = listRunsForTicket(db, "t")[0];
        expect(run).toBeDefined();
        expect(
          (await f.host.host.sessionEngine!.getSession({ sessionId: run!.sessionId }))!
            .lastTurnOutcome,
        ).toBe("completed");
      },
      { timeout: 10_000 },
    );
    const run = listRunsForTicket(db, "t")[0]!;
    expect(
      (await f.host.host.sessionEngine!.getSession({ sessionId: run.sessionId }))!.latestTurnOrigin,
    ).toMatchObject({ kind: "automation", automationName: "CLI armed proof" });
    expect(await f.cli("session", "answer", shortSessionId(run.sessionId))).toMatchObject({
      state: "completed",
      answer: "Armed Automation completed",
    });
  }, 20_000);

  it("protects a real worktree on Done during an active turn and between turns with a live shell", async () => {
    const f = await fixture(
      [
        {
          tool: {
            name: "bash",
            args: {
              command: "printf ready > active; while ! test -f release; do sleep 0.02; done",
            },
          },
        },
        {
          tool: {
            name: "shell_start",
            args: {
              command: "echo $$ > shell.pid; while ! test -f release-shell; do sleep 0.02; done",
            },
          },
        },
        { text: "Server running" },
      ],
      true,
    );
    if (!f.host.host.database.ok) throw new Error("No database");
    // A neighbouring finished ticket shares the checkout. Moving it must not
    // interrupt the working Session and thereby hide the activity being judged.
    insertTicket(
      f.host.host.database.db,
      testTicket("p", {
        id: "trim",
        ticketNumber: 2,
        usesWorktree: false,
        worktreePath: f.directory,
      }),
    );
    const dependency = join(f.directory, "node_modules/dependency");
    mkdirSync(join(f.directory, "node_modules"));
    writeFileSync(dependency, "keep while busy");
    const started = await f.cli(
      "session",
      "start",
      "VC-1",
      "--model",
      "scripted-fixture/scripted",
      "--reasoning",
      "off",
      "--title",
      "Busy proof",
      "-m",
      "Hold a turn, then a shell",
    );
    await vi.waitFor(() => expect(existsSync(join(f.directory, "active"))).toBe(true));
    expect(
      (await f.host.host.sessionEngine!.getSession({ sessionId: started.sessionId }))!.turnActive,
    ).toBe(true);
    const moveTrim = (status: string) => f.cli("ticket", "move", "VC-2", "--to", status);
    await moveTrim("done");
    // Allow the detached trim to finish while the gated turn remains active.
    await new Promise((settle) => setTimeout(settle, 100));
    expect(readFileSync(dependency, "utf8")).toBe("keep while busy");
    writeFileSync(join(f.directory, "release"), "");
    await vi.waitFor(
      async () =>
        expect((await f.cli("session", "answer", started.session)).state).toBe("completed"),
      { timeout: 5_000 },
    );
    const pid = Number(readFileSync(join(f.directory, "shell.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(
      (await f.host.host.sessionEngine!.getSession({ sessionId: started.sessionId }))!.turnActive,
    ).toBe(false);
    await moveTrim("todo");
    await moveTrim("done");
    await new Promise((settle) => setTimeout(settle, 100));
    expect(existsSync(dependency)).toBe(true);
    writeFileSync(join(f.directory, "release-shell"), "");
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    await moveTrim("todo");
    await moveTrim("done");
    await vi.waitFor(() => expect(existsSync(dependency)).toBe(false));
  }, 20_000);
});

/**
 * The M1 demo's journey (VC-563), with only the provider wire scripted: an
 * operator registers a git repository whose `origin` is a local bare remote,
 * creates a Ticket and starts a Session over the built CLI; the agent writes a
 * file, commits and pushes from its Ticket worktree, then runs `volli session
 * done` from inside the Session against this host. The client that started
 * it disconnects mid-turn, and a fresh CLI reads the finished Session.
 *
 * The runtime paths are the source boot's (`headlessRuntimePaths` over
 * `apps/hostd/dist`), so the agent's `volli` is `apps/hostd/dev-bin/volli`
 * and the socket reaches it through the Session environment alone.
 */
describe("M1 headless smoke (VC-563)", () => {
  it("registers, starts, survives a client disconnect mid-turn, pushes and signals done", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostd-m1-"));
    roots.push(root);
    // The service user's HOME: git identity, Pi's directory and the Ticket
    // worktrees under ~/.volli/worktrees, as on the box.
    vi.stubEnv("HOME", root);
    vi.stubEnv("VOLLI_WORKTREE_HOME_DIR", root);
    writeFileSync(
      join(root, ".gitconfig"),
      "[user]\n\tname = Volli Box\n\temail = box@example.test\n[init]\n\tdefaultBranch = main\n",
    );
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, HOME: root },
      }).trim();
    const remote = join(root, "remote.git");
    const repository = join(root, "repos", "demo");
    mkdirSync(repository, { recursive: true });
    git(root, "init", "--quiet", "--bare", remote);
    git(repository, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repository, "README.md"), "# Demo\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "--quiet", "-m", "Initial commit");
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "--quiet", "-u", "origin", "main");

    const midTurn = join(root, "mid-turn");
    const release = join(root, "release");
    const script = scriptedProvider([
      { tool: { name: "write", args: { path: "GREETING.md", content: "Hello from the box\n" } } },
      {
        tool: {
          name: "bash",
          args: {
            command: `printf turning > '${midTurn}'; while ! test -f '${release}'; do sleep 0.05; done`,
          },
        },
      },
      {
        tool: {
          name: "bash",
          args: {
            command:
              "git add GREETING.md && git commit --quiet -m 'Add greeting' && git push --quiet origin HEAD",
          },
        },
      },
      {
        tool: { name: "bash", args: { command: "volli session done --reason 'Greeting pushed'" } },
      },
      { text: "Pushed the greeting and signalled done." },
    ]);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { mode: 0o700 });
    const socketPath = join(dataDir, "volli.sock");
    const operator = "m1-operator";
    const operatorsFile = join(root, "operators");
    writeFileSync(
      operatorsFile,
      `ops ${process.getuid!()} sha256:${createHash("sha256").update(operator).digest("hex")} now\n`,
      { mode: 0o600 },
    );
    const host = await startHostd({
      dataDir,
      socketPath,
      operatorsFile,
      operatorsOwnerUid: process.getuid!(),
      version: "test",
      env: { HOME: root, PATH: process.env.PATH },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      runtime: {
        ...headlessRuntimePaths(join(repo, "apps/hostd/dist"), socketPath),
        modelAccess: {
          ...piOwnedModelAccess({ agentDir: join(root, "pi") }),
          models: script.models,
        },
      },
    });
    hosts.push(host);
    const cliEnv = {
      PATH: process.env.PATH,
      HOME: root,
      VOLLI_SOCKET: socketPath,
      VOLLI_OPERATOR_TOKEN: operator,
    };
    const cliArgs = (...argv: string[]) => [cliBundle, ...argv, "--json"];
    const cli = async (...argv: string[]) =>
      JSON.parse(
        (await exec(process.execPath, cliArgs(...argv), { cwd: root, env: cliEnv })).stdout,
      );

    const added = await cli("project", "add", repository, "--name", "Demo");
    expect(added).toMatchObject({ created: true, project: { prefix: "DE", baseBranch: "main" } });
    const { ticket } = await cli(
      "ticket",
      "create",
      "--title",
      "Add a greeting",
      "--project",
      added.project.prefix,
      "--status",
      "doing",
    );
    expect(ticket).toMatchObject({ id: "DE-1", usesWorktree: true });

    // The operator's shell, as SSH holds it: the CLI starts the Session and
    // the shell stays. Its whole process group hangs up mid-turn.
    const shell = spawn(
      "sh",
      [
        "-c",
        `"$0" "$@" && exec sleep 600`,
        process.execPath,
        ...cliArgs(
          "session",
          "start",
          ticket.id,
          "--model",
          "scripted-fixture/scripted",
          "--reasoning",
          "off",
          "--title",
          "Box demo",
          "-m",
          "Add a greeting, commit, push, then say done",
        ),
      ],
      { cwd: root, env: cliEnv, detached: true, stdio: ["ignore", "pipe", "inherit"] },
    );
    let startOutput = "";
    shell.stdout.on("data", (chunk: Buffer) => (startOutput += chunk.toString()));
    const exited = new Promise<NodeJS.Signals | number | null>((settle) =>
      shell.on("exit", (code, signal) => settle(signal ?? code)),
    );
    await vi.waitFor(() => expect(existsSync(midTurn)).toBe(true), { timeout: 10_000 });
    const started = JSON.parse(startOutput);
    expect(started.state).toBe("ready");
    expect(
      (await host.host.sessionEngine!.getSession({ sessionId: started.sessionId }))!.turnActive,
    ).toBe(true);
    process.kill(-shell.pid!, "SIGHUP");
    expect(await exited).toBe("SIGHUP");

    writeFileSync(release, "");
    await vi.waitFor(
      async () => expect((await cli("session", "answer", started.session)).state).toBe("completed"),
      { timeout: 15_000, interval: 100 },
    );
    expect(await cli("session", "answer", started.session)).toMatchObject({
      answer: "Pushed the greeting and signalled done.",
    });

    // The pushed ref: the Ticket's branch on the bare remote, at the commit
    // the agent made in its worktree under ~/.volli/worktrees.
    const { ticket: shown } = await cli("ticket", "show", ticket.id);
    expect(shown.worktreePath.startsWith(join(root, ".volli", "worktrees"))).toBe(true);
    const head = git(shown.worktreePath, "rev-parse", "HEAD");
    expect(git(remote, "rev-parse", `refs/heads/${shown.branch}`)).toBe(head);
    expect(git(remote, "show", `${head}:GREETING.md`)).toBe("Hello from the box");
    expect(git(remote, "log", "-1", "--format=%s", head)).toBe("Add greeting");
    const { events: board } = await cli("ticket", "events", ticket.id);
    expect(board.map(({ payload }: { payload: { kind: string } }) => payload.kind)).toEqual([
      "created",
      "session_started",
      "worktree_changed",
    ]);

    // Every tool the agent ran succeeded; `volli session done` answered from
    // inside the Session, over this host's socket, as that Session.
    const results = script.requests.at(-1)!.filter((message) => message.role === "toolResult");
    expect(results.map((message) => [message.toolName, message.isError])).toEqual([
      ["write", false],
      ["bash", false],
      ["bash", false],
      ["bash", false],
    ]);
    expect(JSON.stringify(results.at(-1)!.content)).toContain(`${started.session}  done`);

    // The ledger: each command has its receipt, the done signal's is this
    // Session's, and the one turn completed on this host's remote venue.
    const ledger = (
      await host.host.sessionEngine!.listEvents({ sessionId: started.sessionId })
    ).map(({ payload }) => payload);
    const receipts = new Map(
      ledger.flatMap((event) =>
        event.kind === "command.receipt.recorded" ? [[event.receipt.commandId, event.receipt]] : [],
      ),
    );
    const commands = ledger.flatMap((event) =>
      event.kind === "command.recorded" ? [event.command] : [],
    );
    expect(commands.map((command) => command.intent.kind)).toEqual([
      "session.create",
      "model.select",
      "executor.start",
      "message.submit",
      "session.signal",
    ]);
    for (const command of commands) expect(receipts.get(command.id)).toBeDefined();
    const signal = commands.find((command) => command.intent.kind === "session.signal")!;
    expect(signal.intent).toEqual({
      kind: "session.signal",
      signal: "done",
      reason: "Greeting pushed",
    });
    expect(receipts.get(signal.id)).toMatchObject({
      status: "completed",
      result: { kind: "session.signaled", sessionId: started.sessionId },
    });
    expect(ledger).toContainEqual({
      kind: "session.signaled",
      signal: "done",
      reason: "Greeting pushed",
    });
    expect(ledger.filter((event) => event.kind === "turn.started")).toHaveLength(1);
    expect(ledger.filter((event) => event.kind === "turn.completed")).toHaveLength(1);
    const opened = ledger.find((event) => event.kind === "attachment.opened");
    expect(opened).toMatchObject({ attachment: { venue: { id: socketPath, kind: "remote" } } });
    console.log(
      "VC-563 M1 smoke: CLI registration, Ticket worktree, push to the bare remote, in-Session done signal, fresh-CLI answer",
    );
  }, 40_000);

  it("boots from a workspace build: node apps/hostd/dist/hostd.cjs", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostd-source-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const hostd = join(repo, "apps/hostd/dist/hostd.cjs");
    const child = spawn(process.execPath, [hostd, "--data-dir", dataDir], {
      env: { PATH: process.env.PATH, HOME: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk: Buffer) => (log += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (log += chunk.toString()));
    const exited = new Promise<number | null>((settle) => child.on("exit", settle));
    try {
      await vi.waitFor(() => expect(log).toContain('"msg":"serving"'), { timeout: 15_000 });
      const status = await exec(process.execPath, [hostd, "status", "--data-dir", dataDir]);
      expect(JSON.parse(status.stdout)).toMatchObject({
        verdict: "serving",
        status: { capabilities: { sessions: "available" } },
      });
      // The launcher a source boot's Sessions find first on PATH.
      const listed = await exec(
        join(repo, "apps/hostd/dev-bin/volli"),
        ["project", "list", "--json"],
        {
          env: { PATH: process.env.PATH, HOME: root, VOLLI_SOCKET: join(dataDir, "volli.sock") },
        },
      );
      expect(JSON.parse(listed.stdout)).toEqual({ projects: [] });
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
    expect(
      log
        .trim()
        .split("\n")
        .every((line) => JSON.parse(line) !== null),
    ).toBe(true);
  }, 30_000);
});
