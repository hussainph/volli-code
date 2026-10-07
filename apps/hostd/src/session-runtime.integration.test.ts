/** Real hostd, Pi, SQLite and socket; only the provider wire is scripted. */
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
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
import { insertProject, insertTicket, listRunsForTicket } from "@volli/host-core/db";
import { createAutomationEngine, SqliteAutomationLedger } from "@volli/host-core/automations";
import { isLiveHost, type LiveHostCore } from "@volli/host-core";
import {
  fileSecretKey,
  SecretStore,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
} from "@volli/host-core/secrets";
import {
  fileGitCredentialStore,
  GIT_CREDENTIALS_FILE,
  shellWord,
} from "@volli/host-core/session-runtime";
import { resetRetentionWatcherForTest, testProject, testTicket } from "@volli/host-core/testing";
import { startHostd, type RunningHostd } from "./hostd";
import { headlessRuntimePaths } from "./runtime-paths";
import { hostdVenue } from "./venue";

/** The live host a fixture booted; every proof here needs its database. */
function live(running: RunningHostd): LiveHostCore {
  if (!isLiveHost(running.host)) throw new Error(running.host.database.error);
  return running.host;
}

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const cliBundle = join(repo, "packages/cli/dist/volli.cjs");
const roots: string[] = [];
const hosts: RunningHostd[] = [];
// Building the fixture is not a Session/quit deadline. Keep the compiler
// bounded, but allow shared-machine contention before timing runtime proofs.
// hostd is built too: the source-boot case runs apps/hostd/dist/hostd.cjs.
beforeAll(
  () =>
    execFileSync("pnpm", ["--filter", "@volli/hostd", "--filter", "@volli/cli", "build"], {
      cwd: repo,
      stdio: "pipe",
      timeout: 120_000,
    }),
  125_000,
);
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const host of hosts.splice(0)) await host.stop("test done");
  // The retention watch is a process singleton; each host here is a new process's.
  resetRetentionWatcherForTest();
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
  let socketPath = join(dataDir, "volli.sock");
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
  const core = live(host);
  insertProject(core.database.db, testProject({ id: "p", path: directory, ticketPrefix: "VC" }));
  insertTicket(
    core.database.db,
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
  const restart = async (movedSocket?: string) => {
    expect(await host.stop("restart proof")).toBe(true);
    if (movedSocket !== undefined) socketPath = movedSocket;
    const recovered = await launch();
    hosts.push(recovered);
    return recovered;
  };
  return { host, core, script, cli, directory, restart };
}

describe("Linux CLI scripted-provider proof (VC-622)", () => {
  it.each(["same", "moved"] as const)(
    "recovers pre-UUID socket-path attachments after upgrade with a %s socket",
    async (socket) => {
      const f = await fixture();
      const originalSocket = f.host.status().socketPath;
      const legacyVenue = { id: originalSocket, kind: "remote" as const };
      const workerVenue = { id: "12926fc7-0d26-4f1b-aad9-19acd3ecb55c", kind: "remote" as const };
      const seeded: Array<{ sessionId: string; attachmentId: string; adapterId: string }> = [];
      for (const [name, adapterId, venue] of [
        ["legacy-terminal", "terminal", legacyVenue],
        ["legacy-pi", "pi", legacyVenue],
        ["worker", "terminal", workerVenue],
      ] as const) {
        const provenance = {
          source: { kind: "system" as const, id: "hostd", detail: null },
          venue,
        };
        const created = await f.core.sessionEngine.createSession({
          commandId: `${name}-create`,
          projectId: "p",
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: name,
          provenance,
        });
        const sessionId = created.session.id;
        const attachmentId = `${name}-attachment`;
        await f.core.sessionEngine.observe({
          id: `${name}-attach`,
          kind: "attachment.opened",
          sessionId,
          occurredAt: Date.now(),
          provenance,
          attachment: {
            id: attachmentId,
            sessionId,
            adapterId,
            venue,
            continuity: "fresh",
            native: null,
            authority: null,
          },
        });
        if (adapterId === "pi") {
          await f.core.sessionEngine.observe({
            id: `${name}-turn`,
            kind: "turn.started",
            sessionId,
            attachmentId,
            turnId: "lost-turn",
            occurredAt: Date.now(),
            provenance,
          });
          await f.core.sessionEngine.observe({
            id: `${name}-permission`,
            kind: "interaction.opened",
            sessionId,
            occurredAt: Date.now(),
            provenance: { source: { kind: "adapter", id: "pi", detail: null }, venue },
            interaction: {
              id: "lost-permission",
              attachmentId,
              kind: "permission",
              title: "Allow?",
              detail: null,
              options: [],
              multiple: false,
              native: { id: "lost-prompt", detail: null },
            },
          });
        }
        seeded.push({ sessionId, attachmentId, adapterId });
      }
      // A real pre-UUID data directory has not minted a host id yet.
      f.core.database.db.prepare("DELETE FROM host_identity").run();
      const rebooted = await f.restart(socket === "moved" ? `${originalSocket}.moved` : undefined);
      const recovered = live(rebooted);
      expect(rebooted.status().socketPath).toBe(
        socket === "same" ? originalSocket : `${originalSocket}.moved`,
      );
      expect(hostdVenue(recovered.database.db).id).not.toBe(originalSocket);
      for (const { sessionId, attachmentId, adapterId } of seeded) {
        const projection = await recovered.sessionEngine.getSession({ sessionId });
        const worker = attachmentId === "worker-attachment";
        expect(projection!.attachments).toEqual([
          expect.objectContaining({
            id: attachmentId,
            status: worker ? "open" : "closed",
            venue: worker ? workerVenue : legacyVenue,
          }),
        ]);
        if (adapterId === "pi") {
          expect(projection!.turnActive).toBe(false);
          expect(projection!.interactions.active).toEqual([]);
          const events = await recovered.sessionEngine.listEvents({ sessionId });
          expect(events.map(({ payload }) => payload)).toContainEqual(
            expect.objectContaining({
              kind: "interaction.cancelled",
              interactionId: "lost-permission",
              reason: "abandoned",
            }),
          );
        }
      }
    },
    20_000,
  );

  it("recovers its own durable attachment when the agent socket moves", async () => {
    const f = await fixture();
    const originalSocket = f.host.status().socketPath;
    const venue = hostdVenue(f.core.database.db);
    const provenance = { source: { kind: "system" as const, id: "hostd", detail: null }, venue };
    const created = await f.core.sessionEngine.createSession({
      commandId: "socket-move-create",
      projectId: "p",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Socket move",
      provenance,
    });
    await f.core.sessionEngine.observe({
      id: "socket-move-attach",
      kind: "attachment.opened",
      sessionId: created.session.id,
      occurredAt: Date.now(),
      provenance,
      attachment: {
        id: "socket-move-attachment",
        sessionId: created.session.id,
        adapterId: "terminal",
        venue,
        continuity: "fresh",
        native: null,
        authority: null,
      },
    });
    const rebooted = await f.restart(`${originalSocket}.moved`);
    const recovered = live(rebooted);
    expect(rebooted.status().socketPath).not.toBe(originalSocket);
    expect(hostdVenue(recovered.database.db)).toEqual(venue);
    const projection = await recovered.sessionEngine.getSession({ sessionId: created.session.id });
    expect(projection!.attachments).toEqual([
      expect.objectContaining({
        id: "socket-move-attachment",
        status: "closed",
        venue,
      }),
    ]);
  }, 20_000);

  it("starts over the built CLI, runs a real tool, completes and exposes its answer", async () => {
    const f = await fixture();
    const completed = Promise.withResolvers<void>();
    const unsubscribe = f.core.sessionWakeBus.subscribe(({ event }) => {
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
      const projection = await f.core.sessionEngine.getSession({
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
      const events = await f.core.sessionEngine.listEvents({ sessionId: started.sessionId });
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
      expect(projection!.attachments[0]!.venue).toEqual(hostdVenue(f.core.database.db));
      console.log(
        "VC-622 Linux CLI proof: Session birth, actual write tool, turn.completed, CLI answer",
      );
      const rebooted = await f.restart();
      expect(await f.cli("session", "answer", started.session)).toMatchObject({
        state: "completed",
      });
      const restored = await live(rebooted).sessionEngine.getSession({
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
    const db = f.core.database.db;
    // The board's own CRUD door is the desktop's; the ledger is what the runner reads.
    const engine = createAutomationEngine({
      ledger: new SqliteAutomationLedger(db),
      now: Date.now,
      nextId: randomUUID,
    });
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
          (await f.core.sessionEngine.getSession({ sessionId: run!.sessionId }))!.lastTurnOutcome,
        ).toBe("completed");
      },
      { timeout: 10_000 },
    );
    const run = listRunsForTicket(db, "t")[0]!;
    expect(
      (await f.core.sessionEngine.getSession({ sessionId: run.sessionId }))!.latestTurnOrigin,
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
    // A neighbouring finished ticket shares the checkout. Moving it must not
    // interrupt the working Session and thereby hide the activity being judged.
    insertTicket(
      f.core.database.db,
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
      (await f.core.sessionEngine.getSession({ sessionId: started.sessionId }))!.turnActive,
    ).toBe(true);
    const moveTrim = (status: string) => f.cli("ticket", "move", "VC-2", "--to", status);
    // Every Done move enrols exactly one detached trim with the host, before
    // its reply; awaiting that enrolment is awaiting the trim's own verdict.
    const trims = vi.spyOn(f.core.detachedWork, "track");
    const finishTrim = async () => {
      const enrolled = trims.mock.calls.length;
      await moveTrim("done");
      expect(trims).toHaveBeenCalledTimes(enrolled + 1);
      await trims.mock.calls[enrolled]![0];
    };
    await finishTrim();
    // The trim has settled while the gated turn remains active.
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
      (await f.core.sessionEngine.getSession({ sessionId: started.sessionId }))!.turnActive,
    ).toBe(false);
    await moveTrim("todo");
    await finishTrim();
    // Settled with the shell alive between turns: still refused.
    expect(existsSync(dependency)).toBe(true);
    writeFileSync(join(f.directory, "release-shell"), "");
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    await moveTrim("todo");
    await finishTrim();
    expect(existsSync(dependency)).toBe(false);
  }, 20_000);
});

/** Runs the CLI it is given, then stays, as a login shell does after a command. */
const OPERATOR_SHELL = `const run = require("node:child_process").spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit" });
if (run.status !== 0) process.exit(run.status ?? 1);
setInterval(() => {}, 1 << 30);`;

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
      { tool: { name: "bash", args: { command: "volli session done --reason pushed" } } },
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
      process.execPath,
      [
        "-e",
        OPERATOR_SHELL,
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
      (await live(host).sessionEngine.getSession({ sessionId: started.sessionId }))!.turnActive,
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
      await live(host).sessionEngine.listEvents({ sessionId: started.sessionId })
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
      reason: "pushed",
    });
    expect(receipts.get(signal.id)).toMatchObject({
      status: "completed",
      result: { kind: "session.signaled", sessionId: started.sessionId },
    });
    expect(ledger).toContainEqual({
      kind: "session.signaled",
      signal: "done",
      reason: "pushed",
    });
    expect(ledger.filter((event) => event.kind === "turn.started")).toHaveLength(1);
    expect(ledger.filter((event) => event.kind === "turn.completed")).toHaveLength(1);
    const opened = ledger.find((event) => event.kind === "attachment.opened");
    // The venue is this host's persisted identity (VC-627), not its socket path.
    expect(opened).toMatchObject({
      attachment: { venue: hostdVenue(live(host).database.db) },
    });
    expect(hostdVenue(live(host).database.db).kind).toBe("remote");

    // VC-661: the operator reads the latest signal back over the CLI, in both
    // formats, without an operator token — reads need only the socket; only
    // writes ask for the operator. Nothing sends a token here: the variable
    // is absent and no token file exists under this fixture HOME.
    const readEnv = {
      PATH: cliEnv.PATH,
      HOME: cliEnv.HOME,
      VOLLI_SOCKET: cliEnv.VOLLI_SOCKET,
    };
    const cliReadJson = async (...argv: string[]) =>
      JSON.parse(
        (await exec(process.execPath, [cliBundle, ...argv, "--json"], { cwd: root, env: readEnv }))
          .stdout,
      );
    const cliReadHuman = async (...argv: string[]) =>
      (await exec(process.execPath, [cliBundle, ...argv], { cwd: root, env: readEnv })).stdout;
    const shownJson = await cliReadJson("session", "show", started.session);
    expect(shownJson.signal).toMatchObject({
      kind: "done",
      reason: "pushed",
      at: expect.any(Number),
      ageMs: expect.any(Number),
    });
    const signalEvent = (
      await live(host).sessionEngine.listEvents({ sessionId: started.sessionId })
    ).find((event) => event.payload.kind === "session.signaled")!;
    expect(shownJson.signal.at).toBe(signalEvent.occurredAt);
    const answeredJson = await cliReadJson("session", "answer", started.session);
    expect(answeredJson.signal).toMatchObject({
      kind: "done",
      reason: "pushed",
      at: shownJson.signal.at,
      ageMs: expect.any(Number),
    });
    expect(shownJson.signal.ageMs).toBeGreaterThanOrEqual(0);
    expect(answeredJson.signal.ageMs).toBeGreaterThanOrEqual(shownJson.signal.ageMs);
    const signalLine = /signal  done · \d+[smh] ago/;
    const shownHuman = await cliReadHuman("session", "show", started.session);
    const answeredHuman = await cliReadHuman("session", "answer", started.session);
    expect(shownHuman).toMatch(signalLine);
    expect(answeredHuman).toMatch(signalLine);
    expect(shownHuman).toContain("signal reason:\n  | pushed\n");
    expect(answeredHuman).toContain("signal reason:\n  | pushed\n");
    console.log(`VC-661 session show --json .signal: ${JSON.stringify(shownJson.signal)}`);
    console.log(`VC-661 session show (human):\n${shownHuman.trimEnd()}`);
    console.log(`VC-661 session answer (human):\n${answeredHuman.trimEnd()}`);
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

// ---- VC-713: a real Session pushes its Ticket branch through VC-702's helper ----
//
// In this file rather than its own: it runs the same built hostd and CLI this
// file's `beforeAll` builds, and two files each rebuilding `dist/` at once
// would delete it from under each other.

const TOKEN = "ghp_SESSIONPUSHPROOF0123456789abcdef";

/** Same prerequisites as git-credential.test.ts's HTTPS push proof. */
function pushProofTools(): { backend: string } | null {
  if (spawnSync("openssl", ["version"]).status !== 0) return null;
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (execPath.status !== 0) return null;
  const backend = join(execPath.stdout.trim(), "git-http-backend");
  return existsSync(backend) ? { backend } : null;
}
const tools = pushProofTools();

/** No machine git configuration, credential helpers, prompts or identity. */
function isolated(root: string): Record<string, string> {
  const home = join(root, "home");
  mkdirSync(home);
  const global = join(root, "gitconfig");
  writeFileSync(global, "");
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    VOLLI_WORKTREE_HOME_DIR: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: global,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Volli Box",
    GIT_AUTHOR_EMAIL: "box@example.invalid",
    GIT_COMMITTER_NAME: "Volli Box",
    GIT_COMMITTER_EMAIL: "box@example.invalid",
    VOLLI_EXPERIMENTAL: "cloud",
  };
}

/** git-http-backend over loopback HTTPS, with a throwaway cert and Basic auth. */
async function httpsRemote(root: string, env: NodeJS.ProcessEnv, backend: string) {
  const serverRoot = join(root, "server");
  mkdirSync(serverRoot);
  const bare = join(serverRoot, "repo.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare], { env });
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { env, stdio: "pipe" },
  );
  const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
  let authenticated = 0;
  const server: Server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (request, response) => {
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="session-proof"' }).end();
        return;
      }
      authenticated++;
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      const cgi = spawn(backend, [], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: serverRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: "x-access-token",
          REMOTE_ADDR: "127.0.0.1",
          REQUEST_METHOD: request.method ?? "GET",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          ...(request.headers["content-length"] === undefined
            ? {}
            : { CONTENT_LENGTH: request.headers["content-length"] }),
          HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
          GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        },
      });
      request.pipe(cgi.stdin);
      const chunks: Buffer[] = [];
      cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      cgi.on("close", () => {
        const output = Buffer.concat(chunks);
        const split = output.indexOf("\r\n\r\n");
        const head = output.subarray(0, split).toString("latin1").split("\r\n");
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of head) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
          else headers[name] = value;
        }
        response.writeHead(status, headers).end(output.subarray(split + 4));
      });
    },
  );
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/repo.git`,
    host: `127.0.0.1:${port}`,
    bare,
    authenticated: () => authenticated,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

describe.skipIf(tools === null)("Session HTTPS branch push (VC-713)", () => {
  let root: string | undefined;
  let host: RunningHostd | undefined;
  let remote: Awaited<ReturnType<typeof httpsRemote>> | undefined;
  afterEach(async () => {
    try {
      if (host !== undefined) await host.stop("push proof done");
      if (remote !== undefined) await remote.close();
      resetRetentionWatcherForTest();
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pushes its own worktree branch using this host's stored credential, without leaking it", async () => {
    root = mkdtempSync(join(tmpdir(), "hostd-session-push-"));
    const env = isolated(root);
    // Worktree git inherits process.env. Remove ambient git overrides,
    // proxies and shell startup hooks, then isolate the host; the scripted
    // bash command reinstates the config isolation that Pi filters out.
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("GIT_") ||
        /^(https?|all|no)_proxy$/i.test(key) ||
        key === "BASH_ENV" ||
        key === "ENV"
      )
        vi.stubEnv(key, undefined);
    }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    remote = await httpsRemote(root, env, tools!.backend);
    expect(git(remote.bare, "for-each-ref", "--format=%(refname)")).toBe("");
    const repository = join(root, "project");
    mkdirSync(repository);
    git(repository, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repository, "README.md"), "# HTTPS Session proof\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "--quiet", "-m", "Initial commit");
    git(repository, "remote", "add", "origin", remote.url);
    git(repository, "config", "http.sslVerify", "false");
    git(repository, "config", "user.name", "Volli Box");
    git(repository, "config", "user.email", "box@example.invalid");
    const helpers = spawnSync("git", ["config", "--get-all", "credential.helper"], {
      cwd: repository,
      env,
      encoding: "utf8",
    });
    expect(helpers.status).toBe(1);
    expect(helpers.stdout).toBe("");

    const dataDir = join(root, "data");
    mkdirSync(dataDir, { mode: 0o700 });
    // Exactly the store populated by HostSignIns.setGitCredential, not a
    // repository credential or an environment variable containing the token.
    await fileGitCredentialStore(join(dataDir, GIT_CREDENTIALS_FILE)).set(remote.host, {
      username: "x-access-token",
      password: TOKEN,
    });
    const helper = `!${[process.execPath, join(repo, "apps/hostd/dist/hostd.cjs"), "git-credential", "--data-dir", dataDir].map(shellWord).join(" ")}`;
    const script = scriptedProvider([
      {
        tool: { name: "write", args: { path: "GREETING.md", content: "Pushed by the Session\n" } },
      },
      {
        tool: {
          name: "bash",
          args: {
            command: [
              `test "$HOME" = ${shellWord(env.HOME!)}`,
              // Pi deliberately strips ambient GIT_* variables. Install only
              // the scratch-config isolation inside bash, leaving the helper
              // GIT_CONFIG_COUNT/KEY/VALUE supplied by the runtime untouched.
              `export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=${shellWord(env.GIT_CONFIG_GLOBAL!)} GIT_TERMINAL_PROMPT=0`,
              "git config --show-scope --get-all credential.helper",
              "git add GREETING.md",
              "git commit --quiet -m 'Session HTTPS push'",
              "git push origin HEAD",
              "printf 'SESSION_PUSH_SUCCEEDED\\n'",
            ].join(" && "),
          },
        },
      },
      { text: "Pushed the Ticket branch over HTTPS." },
    ]);
    const socketPath = join(dataDir, "volli.sock");
    const operator = "push-proof-operator";
    const operatorsFile = join(root, "operators");
    writeFileSync(
      operatorsFile,
      `ops ${process.getuid!()} sha256:${createHash("sha256").update(operator).digest("hex")} now\n`,
      { mode: 0o600 },
    );
    host = await startHostd({
      dataDir,
      socketPath,
      operatorsFile,
      operatorsOwnerUid: process.getuid!(),
      version: "test",
      env,
      gitCredentialHelper: helper,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      runtime: {
        binDir: join(repo, "packages/cli/dist"),
        venue: { id: socketPath, kind: "remote" },
        gitCredentialHelper: helper,
        modelAccess: {
          ...piOwnedModelAccess({ agentDir: join(root, "pi") }),
          models: script.models,
        },
      },
    });
    if (!isLiveHost(host.host)) throw new Error(host.host.database.error);
    const core = host.host;
    const cli = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [cliBundle, ...args, "--json"], {
            cwd: repository,
            env: { ...env, VOLLI_SOCKET: socketPath, VOLLI_OPERATOR_TOKEN: operator },
          })
        ).stdout,
      );
    const added = await cli("project", "add", repository, "--name", "Push Proof");
    expect(added.created).toBe(true);
    const { ticket } = await cli(
      "ticket",
      "create",
      "--title",
      "Push greeting",
      "--project",
      added.project.prefix,
      "--status",
      "doing",
    );
    expect(ticket.usesWorktree).toBe(true);
    const started = await cli(
      "session",
      "start",
      ticket.id,
      "--model",
      "scripted-fixture/scripted",
      "--reasoning",
      "off",
      "--title",
      "Authenticated push",
      "-m",
      "Commit and push the greeting",
    );
    expect(started.state).toBe("ready");
    await vi.waitFor(
      async () => expect((await cli("session", "answer", started.session)).state).toBe("completed"),
      { timeout: 15_000, interval: 100 },
    );
    const results = script.requests.at(-1)!.filter((message) => message.role === "toolResult");
    expect(
      results.map((message) => [message.toolName, message.isError]),
      JSON.stringify(results),
    ).toEqual([
      ["write", false],
      ["bash", false],
    ]);
    expect(JSON.stringify(results)).toContain(`command\\t${helper}`);
    expect(JSON.stringify(results)).toContain("SESSION_PUSH_SUCCEEDED");
    const projection = await core.sessionEngine.getSession({ sessionId: started.sessionId });
    expect(projection!.lastTurnOutcome).toBe("completed");
    const { ticket: shown } = await cli("ticket", "show", ticket.id);
    expect(shown.worktreePath.startsWith(join(env.HOME!, ".volli", "worktrees"))).toBe(true);
    expect(shown.worktreePath).not.toBe(repository);
    expect(git(shown.worktreePath, "branch", "--show-current")).toBe(shown.branch);
    const head = git(shown.worktreePath, "rev-parse", "HEAD");
    expect(head).not.toBe(git(repository, "rev-parse", "HEAD"));
    expect(git(remote.bare, "rev-parse", `refs/heads/${shown.branch}`)).toBe(head);
    expect(git(remote.bare, "show", `${head}:GREETING.md`)).toBe("Pushed by the Session");
    expect(git(remote.bare, "log", "-1", "--format=%s", head)).toBe("Session HTTPS push");
    expect(remote.authenticated()).toBeGreaterThan(0);

    expect(JSON.stringify(script.requests)).not.toContain(TOKEN);
    const transcript = await cli("session", "peek", started.session, "--lines", "100");
    expect(transcript.transcript.length).toBeGreaterThan(0);
    expect(JSON.stringify(transcript)).not.toContain(TOKEN);
    const events = await core.sessionEngine.listEvents({ sessionId: started.sessionId });
    expect(events.filter(({ payload }) => payload.kind === "turn.completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(readFileSync(join(repository, ".git", "config"), "utf8")).not.toContain(TOKEN);
    expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")).toBe("");
  }, 40_000);
});
