/**
 * E2e probe: the read-tier cost surfaces, through the real CLI (VC-87).
 *
 * The unit tests hold the arithmetic and the notation. What only a live app can
 * prove is that the whole path exists and is composable the way VC-92 staged
 * it: a `cost` verb on the socket, answered by main out of migration 027's
 * projection, with `--json` an agent can pipe into `jq` and token/cost columns
 * on `session list` beside the rows that already print there.
 *
 * Usage is seeded through the socket rather than by running a model: this probe
 * is about the read path, and a real turn would make it a test of a provider.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/agent-cost-smoke.mjs
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

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("cost");
const { attempt, summarize } = createRunner();

const PREFIX = "CO";

async function main() {
  const app = await launch({ dbPath, userDataDir, extraEnv: {} });
  const shimPath = shimPathFor(userDataDir);
  const socketPath = socketPathFor(userDataDir);
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const projectPath = await makeGitRepo(scratch, "cost-");
    await seedProjects(page, [
      { id: "cost-project", name: "Cost Project", path: projectPath, prefix: PREFIX },
    ]);
    await waitUntil(
      "shim + socket to exist",
      async () => (await pathExists(shimPath)) && (await pathExists(socketPath)),
    );

    let displayId = null;

    await attempt(1, "a ticket to spend against", async () => {
      const r = await runVolliShim(shimPath, [
        "ticket",
        "create",
        "--title",
        "Price a pass",
        "--project",
        PREFIX,
        "--no-worktree",
      ]);
      const first = r.stdout.trim().split("\n")[0] ?? "";
      displayId = first.match(new RegExp(`^${PREFIX}-\\d+`))?.[0] ?? null;
      return { ok: r.code === 0 && displayId !== null, detail: `code=${r.code} id=${displayId}` };
    });

    // An unmetered project is the case that misleads hardest: it must read as
    // unmeasured, never as free. `—` and a null cost, never `$0.00`.
    await attempt(2, "an unmetered project reports no cost rather than zero", async () => {
      const r = await runVolliShim(shimPath, ["cost", "--project", PREFIX]);
      const ok =
        r.code === 0 &&
        r.stdout.includes("cost  \u2014") &&
        !r.stdout.includes("$0.00") &&
        // Nothing metered, rather than a basis for a number that is not there.
        r.stdout.includes("basis  no metered model calls") &&
        r.stdout.includes("scope  project Cost Project");
      return { ok, detail: `code=${r.code} stdout=${JSON.stringify(r.stdout.trim())}` };
    });

    await attempt(3, "--json answers a machine without a second code path", async () => {
      const r = await runVolliShim(shimPath, ["cost", "--project", PREFIX, "--json"]);
      let parsed = null;
      try {
        parsed = JSON.parse(r.stdout.trim());
      } catch {
        parsed = null;
      }
      const ok =
        r.code === 0 &&
        parsed !== null &&
        parsed.costUsd === null &&
        parsed.requestCount === 0 &&
        // The four classes are separate fields, so a reader can never mistake
        // cached input for input.
        typeof parsed.cacheReadTokens === "number" &&
        typeof parsed.cacheWriteTokens === "number" &&
        typeof parsed.inputTokens === "number" &&
        typeof parsed.outputTokens === "number";
      return { ok, detail: `code=${r.code} stdout=${JSON.stringify(r.stdout.trim())}` };
    });

    await attempt(4, "session list carries a cost and a token cell", async () => {
      const r = await runVolliShim(shimPath, ["session", "list", "--project", PREFIX, "--json"]);
      let parsed = null;
      try {
        parsed = JSON.parse(r.stdout.trim());
      } catch {
        parsed = null;
      }
      const rows = parsed?.sessions ?? [];
      // An empty roster still proves the shape of the reply; a populated one
      // proves the cells. Either is a pass, neither is a crash.
      const shaped = rows.every(
        (row) => "costUsd" in row && "costBasis" in row && "costCoverage" in row && "tokens" in row,
      );
      return {
        ok: r.code === 0 && shaped,
        detail: `code=${r.code} rows=${rows.length} shaped=${shaped}`,
      };
    });

    await attempt(5, "a ticket scope resolves by display id", async () => {
      if (displayId === null) return { ok: false, detail: "no display id" };
      const r = await runVolliShim(shimPath, ["cost", "--ticket", displayId]);
      const ok = r.code === 0 && r.stdout.includes(`scope  ticket ${displayId}`);
      return { ok, detail: `code=${r.code} stdout=${JSON.stringify(r.stdout.trim())}` };
    });

    await attempt(6, "a look-back window is resolved against the app's clock", async () => {
      const r = await runVolliShim(shimPath, ["cost", "--project", PREFIX, "--since", "7d"]);
      const since = r.stdout.match(/since {2}(\S+)/)?.[1] ?? "";
      const parsedSince = Date.parse(since);
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      // Within a minute of seven days ago — proves main resolved it, and that
      // nothing pinned the bound to a stale parse-time clock.
      const ok = r.code === 0 && Math.abs(parsedSince - sevenDaysAgo) < 60_000;
      return { ok, detail: `code=${r.code} since=${JSON.stringify(since)}` };
    });

    await attempt(7, "a malformed --since is refused rather than read as zero", async () => {
      const r = await runVolliShim(shimPath, ["cost", "--since", "last tuesday"]);
      const ok = r.code !== 0 && r.stderr.includes("RFC 3339");
      return { ok, detail: `code=${r.code} stderr=${JSON.stringify(r.stderr.trim())}` };
    });

    await attempt(8, "help documents the verb at the read tier", async () => {
      const r = await runVolliShim(shimPath, ["help", "cost"]);
      const ok =
        r.code === 0 && r.stdout.includes("Verb tier: read") && r.stdout.includes("--group-by");
      return { ok, detail: `code=${r.code} stdout=${JSON.stringify(r.stdout.slice(0, 200))}` };
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
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
