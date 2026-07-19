/**
 * E2e token bench: measures the `volli` CLI's output cost against a live app.
 *
 * An inefficient CLI burns the user's token budget, so the token-lean help +
 * output surface is a tested contract, not an aspiration. This probe drives the
 * REAL generated `volli` shim through the canonical agent workflow and every
 * help surface, reporting bytes + estimated tokens (chars / 4) per command, and
 * asserts the spec's ceilings:
 *   - `volli help` (bare reference)         ≤ 700 est tokens
 *   - any `volli help <command>`            ≤ 225 est tokens
 *   - the whole workflow's combined output  ≤ 2,500 est tokens
 *
 * Run:
 *   vp run --filter @volli/desktop build
 *   node apps/desktop/e2e/agent-cli-token-bench.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { makeShortScratch, runVolliShim, shimPathFor, socketPathFor } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  pathExists,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("cli-bench");
const { attempt, summarize } = createRunner();

const PREFIX = "TB";
const BARE_HELP_CEILING = 700;
const PER_COMMAND_CEILING = 225;
const WORKFLOW_CEILING = 2500;

/** Every command whose `volli help <command>` detail must stay within the per-command ceiling. */
const COMMANDS = [
  "identify",
  "board",
  "ticket list",
  "ticket show",
  "ticket events",
  "ticket brief",
  "project list",
  "label list",
  "ticket create",
  "ticket update",
  "ticket move",
  "ticket comment",
  "ticket archive",
  "session list",
  "session peek",
  "session done",
  "session blocked",
  "notify",
  "app launch",
  "help",
];

/** chars / 4 — the same cheap token estimate the CLI's unit budget test uses. */
const estTokens = (text) => Math.round(text.length / 4);

/** Combined stdout+stderr byte length of one shim result. */
const size = (r) => (r.stdout ?? "").length + (r.stderr ?? "").length;

async function main() {
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_AGENT_CONSENT_CHOICE: "defer" },
  });
  const shimPath = shimPathFor(userDataDir);
  const socketPath = socketPathFor(userDataDir);
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const projectPath = await makeGitRepo(scratch, "bench-");
    await seedProjects(page, [
      { id: "bench-project", name: "Bench Project", path: projectPath, prefix: PREFIX },
    ]);
    await waitUntil(
      "shim + socket to exist",
      async () => (await pathExists(shimPath)) && (await pathExists(socketPath)),
    );

    const run = (args, extraEnv) => runVolliShim(shimPath, args, extraEnv);

    // === Help surfaces =======================================================
    await attempt(1, `volli help (bare reference) ≤ ${BARE_HELP_CEILING} est tokens`, async () => {
      const r = await run(["help"]);
      const tokens = estTokens(r.stdout);
      console.log(`  volli help: ${r.stdout.length} bytes / ${tokens} est tokens`);
      return {
        ok: r.code === 0 && tokens <= BARE_HELP_CEILING,
        detail: `code=${r.code} bytes=${r.stdout.length} tokens=${tokens}`,
      };
    });

    await attempt(2, `every volli help <command> ≤ ${PER_COMMAND_CEILING} est tokens`, async () => {
      let worstName = null;
      let worst = 0;
      for (const command of COMMANDS) {
        const r = await run(["help", ...command.split(" ")]);
        const tokens = estTokens(r.stdout);
        console.log(`  help ${command}: ${r.stdout.length} bytes / ${tokens} est tokens`);
        if (r.code !== 0) return { ok: false, detail: `help ${command} exited ${r.code}` };
        if (tokens > worst) {
          worst = tokens;
          worstName = command;
        }
      }
      return {
        ok: worst <= PER_COMMAND_CEILING,
        detail: `worst=${worstName} (${worst} est tokens)`,
      };
    });

    // === Canonical agent workflow ============================================
    let displayId = null;
    let workflowTokens = 0;
    const record = (label, r) => {
      const tokens = estTokens((r.stdout ?? "") + (r.stderr ?? ""));
      workflowTokens += tokens;
      console.log(`  ${label}: ${size(r)} bytes / ${tokens} est tokens (exit ${r.code})`);
    };

    await attempt(3, "canonical workflow runs end-to-end (exit 0 through the writes)", async () => {
      const identify = await run(["identify", "--project", PREFIX]);
      record("identify", identify);

      const board0 = await run(["board", "--project", PREFIX]);
      record("board", board0);

      const create = await run([
        "ticket",
        "create",
        "--title",
        "Bench ticket",
        "--body",
        "Initial body.",
        "--priority",
        "high",
        "--label",
        "bug",
        "--label",
        "security",
        "--project",
        PREFIX,
        "--no-worktree",
      ]);
      record("ticket create", create);
      displayId =
        (create.stdout.trim().split("\n")[0] ?? "").match(new RegExp(`^${PREFIX}-\\d+`))?.[0] ??
        null;
      if (displayId === null) {
        return {
          ok: false,
          detail: `create produced no display id: ${JSON.stringify(create.stdout)}`,
        };
      }

      const show = await run(["ticket", "show", displayId, "--events", "5", "--comments", "5"]);
      record("ticket show", show);

      const append = await run(["ticket", "update", displayId, "--append", "## Findings"]);
      record("ticket update --append", append);

      const edit = await run(["ticket", "update", displayId, "--edit", "Initial", "Revised"]);
      record("ticket update --edit", edit);

      const comment = await run(["ticket", "comment", displayId, "-m", "Ready for review"]);
      record("ticket comment -m", comment);

      const move1 = await run(["ticket", "move", displayId, "--to", "doing"]);
      record("ticket move --to doing", move1);

      const move2 = await run(["ticket", "move", displayId, "--to", "needs-review"]);
      record("ticket move --to needs-review", move2);

      const events = await run(["ticket", "events", displayId]);
      record("ticket events", events);

      const sessions = await run(["session", "list", "--project", PREFIX]);
      record("session list", sessions);

      // `session done` needs a Volli session; with none present it emits a short,
      // single-line error — still representative of the signal's token cost.
      const done = await run(["session", "done", "--reason", "Tests pass"]);
      record("session done", done);

      const writesOk = [create, append, edit, comment, move1, move2].every((r) => r.code === 0);
      return {
        ok: writesOk,
        detail: `create/append/edit/comment/move all exit 0 = ${writesOk}; workflow=${workflowTokens} est tokens`,
      };
    });

    await attempt(4, `workflow combined output ≤ ${WORKFLOW_CEILING} est tokens`, async () => {
      console.log(`  workflow total: ${workflowTokens} est tokens`);
      return {
        ok: workflowTokens <= WORKFLOW_CEILING,
        detail: `total=${workflowTokens} est tokens (ceiling ${WORKFLOW_CEILING})`,
      };
    });
  } finally {
    await app.close();
  }
  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nBENCH ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
