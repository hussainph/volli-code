/**
 * E2e proof: the Session PATH contract is one contract, not a claim inferred
 * from two separately tested adoption paths. A terminal Session gets an
 * interactive login shell on a tty; a structured Session asks the Agent
 * Runtime in main to execute a command from main's adopted PATH. A3 says the
 * latter catches up after the first window, but only this probe observes both
 * executors resolve the same commands in one live app.
 *
 * The controlled profile makes that distinction material. Its `.zprofile`
 * contributes one fake command and a deliberately malformed literal `~/` PATH
 * entry; its `.zshrc` contributes another fake command. The malformed entry
 * once discarded every good directory, and the interactive-only command is
 * what a non-interactive adoption pass cannot see. The probe waits for
 * `volli identify` to say the interactive pass is no longer pending before it
 * starts comparing, so it cannot pass by racing the very recovery it guards.
 *
 * A FAILURE here is a finding about the Session-environment chain, not a bug in
 * this probe. Do not patch `src/` to make it pass: report the disagreeing paths
 * and investigate the adoption or executor boundary that produced them.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/session-env-parity-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real
 * `~/.pi/agent/auth.json` for one Agent Runtime tool call); NOT wired into
 * `vp test`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { identifyRequest, makeShortScratch, requestOverSocket } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  ensurePiAuthInto,
  launch,
  makeGitRepo,
  PI_TURN_BUDGET_MS,
  seedDefaultModel,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const MALFORMED_PATH_ENTRY = "~/some/dir";
const PROFILE_TOOLS = [
  { name: "volli-a4-login-tool", profile: "login" },
  { name: "volli-a4-interactive-tool", profile: "interactive" },
];

// The agent socket lives under `<userData>/volli.sock`; makeShortScratch keeps
// that Unix-domain path below macOS's sun_path limit while retaining smoke-kit
// isolation and cleanup semantics.
const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("env-parity");
const fakeHome = join(scratch, "home");
const zdotDir = join(scratch, "zdot");
const { attempt, must, summarize } = createRunner();

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function writeProfile() {
  const loginBin = join(scratch, "profile-login-bin");
  const interactiveBin = join(scratch, "profile-interactive-bin");
  const bins = [loginBin, interactiveBin];

  await Promise.all(bins.map((dir) => fs.mkdir(dir, { recursive: true })));
  await Promise.all(
    PROFILE_TOOLS.map(async (tool, index) => {
      const file = join(bins[index], tool.name);
      await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await fs.chmod(file, 0o755);
      tool.path = file;
    }),
  );

  await fs.mkdir(zdotDir, { recursive: true });
  // The tilde stays literal because it is single-quoted. It is deliberately
  // malformed for an adopted PATH, but P1 must still survive its presence.
  await fs.writeFile(
    join(zdotDir, ".zprofile"),
    [
      "# A4 controlled login profile",
      `export PATH=${shellQuote(loginBin)}:"$PATH":${shellQuote(MALFORMED_PATH_ENTRY)}`,
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    join(zdotDir, ".zshrc"),
    [
      "# A4 controlled interactive profile",
      `export PATH=${shellQuote(interactiveBin)}:"$PATH"`,
      "",
    ].join("\n"),
  );

  return { loginBin, interactiveBin };
}

function commandThatWritesPaths(resultPath) {
  return PROFILE_TOOLS.map(
    (tool, index) =>
      `command -v ${tool.name} ${index === 0 ? ">" : ">>"} ${shellQuote(resultPath)}`,
  ).join(" && ");
}

async function readResolvedPaths(resultPath) {
  let text;
  try {
    text = await fs.readFile(resultPath, "utf8");
  } catch {
    return null;
  }
  const paths = text.split("\n");
  if (paths.at(-1) === "") paths.pop();
  return paths.length === PROFILE_TOOLS.length ? paths : null;
}

async function waitForInteractiveEnv(socketPath, cwd) {
  let latest = null;
  const env = await waitUntil(
    "the interactive PATH adoption pass to settle",
    async () => {
      const response = await requestOverSocket(socketPath, identifyRequest(cwd)).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      latest = response;
      const report = response?.ok === true ? response.data?.env : null;
      return report?.interactiveProvenance !== undefined &&
        report.interactiveProvenance !== "pending"
        ? report
        : null;
    },
    { timeout: 15_000 },
  ).catch((error) => {
    const suffix = latest === null ? "no identify response" : JSON.stringify(latest).slice(0, 500);
    throw new Error(`${error.message}; last identify=${suffix}`);
  });
  return env;
}

async function chooseLowCostModel(page) {
  const choice = await page.evaluate(async () => {
    const inspected = await window.api.sessionRpc.request({
      procedure: "modelAccess.inspect",
      input: {},
    });
    if (!inspected.ok) return { ok: false, error: inspected };
    const available = (inspected.data.models ?? []).filter((model) => model.state === "available");
    const model =
      available.find((candidate) => candidate.reasoningLevels.includes("low")) ?? available[0];
    if (model === undefined) return { ok: false, error: { message: "no available model" } };
    const reasoningLevel = model.reasoningLevels.includes("low")
      ? "low"
      : (model.reasoningLevels[0] ?? null);
    if (reasoningLevel === null) {
      return {
        ok: false,
        error: { message: `no reasoning level for ${model.providerId}/${model.modelId}` },
      };
    }
    return {
      ok: true,
      selection: {
        providerId: model.providerId,
        modelId: model.modelId,
        reasoningLevel,
      },
    };
  });
  if (!choice.ok) throw new Error(`could not choose a model: ${JSON.stringify(choice.error)}`);
  return choice.selection;
}

async function createStructuredSession(page, projectId) {
  const started = await page.evaluate(async (pid) => {
    const created = await window.api.sessionRpc.request({
      procedure: "sessions.create",
      input: {
        operationId: crypto.randomUUID(),
        projectId: pid,
        ticketId: null,
        title: "Session environment parity smoke",
      },
    });
    if (!created.ok) return { ok: false, step: "create", error: created.error };
    const attached = await window.api.sessionRpc.request({
      procedure: "sessions.attach",
      input: { operationId: crypto.randomUUID(), sessionId: created.data.sessionId },
    });
    if (!attached.ok) return { ok: false, step: "attach", error: attached.error };
    return {
      ok: attached.data.state === "ready",
      sessionId: created.data.sessionId,
      state: attached.data.state,
    };
  }, projectId);
  if (!started.ok)
    throw new Error(
      `structured Session ${started.step ?? "attach"} failed: ${JSON.stringify(started)}`,
    );
  return started.sessionId;
}

async function startPtySession(page, projectId, cwd) {
  const created = await page.evaluate(
    ({ workspaceId, projectPath }) =>
      window.api.terminal.create({
        workspaceId,
        cwd: projectPath,
        cols: 80,
        rows: 24,
      }),
    { workspaceId: projectId, projectPath: cwd },
  );
  if (!created.ok) throw new Error(`terminal.create failed: ${created.error}`);
  return created.sessionId;
}

async function submitStructuredProbe(page, sessionId, command) {
  const prompt = [
    "This is a mechanical Session-environment probe.",
    "Use the bash tool now and execute this command exactly once, verbatim.",
    "Do not use any other tool and do not write the output by another means.",
    "Do not answer until the command has completed.",
    "",
    "```sh",
    command,
    "```",
  ].join("\n");
  const submitted = await page.evaluate(
    async ({ id, text }) =>
      window.api.sessionRpc.request({
        procedure: "session.command",
        input: {
          commandId: crypto.randomUUID(),
          sessionId: id,
          command: {
            kind: "message.submit",
            message: {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text }],
            },
            delivery: "queue",
          },
        },
      }),
    { id: sessionId, text: prompt },
  );
  if (!submitted.ok)
    throw new Error(`structured probe submit failed: ${JSON.stringify(submitted)}`);
  if (submitted.data.receipt?.status === "rejected") {
    throw new Error(`structured probe was rejected: ${JSON.stringify(submitted.data.receipt)}`);
  }
}

async function completedStructuredBash(page, sessionId) {
  return page.evaluate(async (id) => {
    const snapshot = await window.api.sessionRpc.request({
      procedure: "session.snapshot",
      input: { sessionId: id },
    });
    if (!snapshot.ok) return { ok: false, error: snapshot.error };
    const parts = snapshot.data.frames.flatMap((frame) => frame.transcript?.message?.parts ?? []);
    const bash = parts.find((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "output-available" || part.preliminary) {
        return false;
      }
      const command = part.input?.command;
      const nativeToolName = part.toolMetadata?.["volli.activity"]?.nativeToolName;
      return (
        nativeToolName === "bash" &&
        typeof command === "string" &&
        ["volli-a4-login-tool", "volli-a4-interactive-tool"].every((tool) =>
          command.includes(`command -v ${tool}`),
        )
      );
    });
    return bash === undefined
      ? { ok: false, activities: parts.filter((part) => part.type === "dynamic-tool").length }
      : { ok: true, command: bash.input.command };
  }, sessionId);
}

async function main() {
  const { loginBin, interactiveBin } = await writeProfile();
  await ensurePiAuthInto(fakeHome);

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      HOME: fakeHome,
      PATH: BARE_PATH,
      SHELL: "/bin/zsh",
      ZDOTDIR: zdotDir,
    },
  });
  let page;
  let ptySessionId = null;
  try {
    await assertProfileIsolated(app, userDataDir);
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const projectPath = await makeGitRepo(scratch, "env-parity-project-");
    await seedProjects(page, [
      {
        id: "session-env-parity-project",
        name: "Session Env Parity",
        path: projectPath,
        prefix: "EP",
      },
    ]);
    const project = await page.evaluate(async () => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return null;
      return (
        boot.data.projects.find((candidate) => candidate.name === "Session Env Parity") ?? null
      );
    });
    if (project === null) throw new Error("seeded project is missing after import");

    const socketPath = join(await fs.realpath(userDataDir), "volli.sock");
    let envReport = null;
    await must(
      1,
      "the interactive adoption pass finished and retained both controlled profile directories",
      async () => {
        envReport = await waitForInteractiveEnv(socketPath, projectPath);
        const entries = envReport.path.split(":");
        const ok =
          envReport.interactiveProvenance === "adopted" &&
          entries.includes(loginBin) &&
          entries.includes(interactiveBin) &&
          !entries.includes(MALFORMED_PATH_ENTRY);
        return {
          ok,
          detail:
            `interactive=${envReport.interactiveProvenance} login=${entries.includes(loginBin)} ` +
            `interactiveDir=${entries.includes(interactiveBin)} malformedKept=${entries.includes(MALFORMED_PATH_ENTRY)}`,
        };
      },
    );

    const modelPin = await chooseLowCostModel(page);
    let selectedModel = null;
    await must(2, "a low-cost model is selected for the structured Session", async () => {
      selectedModel = await seedDefaultModel(page, modelPin);
      return { ok: selectedModel !== null, detail: JSON.stringify(selectedModel) };
    });

    const ptyResultPath = join(projectPath, ".volli-env-parity-pty.txt");
    const ptyCommand = commandThatWritesPaths(ptyResultPath);
    let ptyPaths = null;
    await must(3, "a terminal PTY Session resolves both controlled tools", async () => {
      ptySessionId = await startPtySession(page, project.id, projectPath);
      await page.evaluate(({ id, command }) => window.api.terminal.write(id, `${command}\n`), {
        id: ptySessionId,
        command: ptyCommand,
      });
      ptyPaths = await waitUntil(
        "the PTY command -v output",
        () => readResolvedPaths(ptyResultPath),
        { timeout: 20_000 },
      );
      const expected = PROFILE_TOOLS.map((tool) => tool.path);
      return {
        ok: JSON.stringify(ptyPaths) === JSON.stringify(expected),
        detail: `session=${ptySessionId} paths=${JSON.stringify(ptyPaths)}`,
      };
    });

    const structuredResultPath = join(projectPath, ".volli-env-parity-structured.txt");
    const structuredCommand = commandThatWritesPaths(structuredResultPath);
    let structuredPaths = null;
    let structuredSessionId = null;
    await must(
      4,
      "an Agent Runtime Session resolves both controlled tools through bash",
      async () => {
        structuredSessionId = await createStructuredSession(page, project.id);
        await submitStructuredProbe(page, structuredSessionId, structuredCommand);
        const evidence = await waitUntil(
          "the Agent Runtime bash command -v output",
          async () => {
            const paths = await readResolvedPaths(structuredResultPath);
            if (paths === null) return null;
            const bash = await completedStructuredBash(page, structuredSessionId);
            return bash.ok ? { paths, command: bash.command } : null;
          },
          { timeout: PI_TURN_BUDGET_MS, interval: 250 },
        );
        structuredPaths = evidence.paths;
        const expected = PROFILE_TOOLS.map((tool) => tool.path);
        return {
          ok: JSON.stringify(structuredPaths) === JSON.stringify(expected),
          detail:
            `session=${structuredSessionId} paths=${JSON.stringify(structuredPaths)} ` +
            `command=${JSON.stringify(evidence.command)}`,
        };
      },
    );

    await attempt(5, "the PTY and Agent Runtime resolve the same absolute paths", async () => ({
      ok: JSON.stringify(ptyPaths) === JSON.stringify(structuredPaths),
      detail: `pty=${JSON.stringify(ptyPaths)} structured=${JSON.stringify(structuredPaths)}`,
    }));
  } finally {
    if (page !== undefined && ptySessionId !== null) {
      await page.evaluate((id) => window.api.terminal.kill(id), ptySessionId).catch(() => {});
    }
    await app.close().catch(() => {});
  }
  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup().catch(() => {});
}
process.exit(code);
