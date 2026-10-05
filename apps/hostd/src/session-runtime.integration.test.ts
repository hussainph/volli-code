/** Real hostd, Pi, SQLite and socket; only the provider wire is scripted. */
import { execFile, execFileSync } from "node:child_process";
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
import { createAutomationEngine } from "@volli/host-core/automations/engine";
import { SqliteAutomationLedger } from "@volli/host-core/automations/sqlite-ledger";
import { isLiveHost, type LiveHostCore } from "@volli/host-core";
import { resetRetentionWatcherForTest } from "@volli/host-core/retention-runtime";
import {
  fileSecretKey,
  SecretStore,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
} from "@volli/host-core/secrets";
import { testProject, testTicket } from "@volli/host-core/db/test-helpers";
import { startHostd, type RunningHostd } from "./hostd";

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
beforeAll(() =>
  execFileSync("pnpm", ["--filter", "@volli/cli", "build"], { cwd: repo, stdio: "pipe" }),
);
afterEach(async () => {
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
  const restart = async () => {
    expect(await host.stop("restart proof")).toBe(true);
    const recovered = await launch();
    hosts.push(recovered);
    return recovered;
  };
  return { host, core, script, cli, directory, restart };
}

describe("Linux CLI scripted-provider proof (VC-622)", () => {
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
      expect(projection!.attachments[0]!.venue.kind).toBe("remote");
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
