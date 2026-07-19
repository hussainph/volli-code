/**
 * E2e probe: renderer board reflects a socket-driven move.
 *
 * With the board visible and a seeded ticket in Todo, a CLI `ticket move --to
 * doing` over the socket must move the card into the Doing column LIVE — no
 * reload — via the `volli:data-changed` broadcast (implementation contract:
 * socket-originated mutations broadcast an entity-scoped IPC event the renderer
 * stores apply). This is the "board updates as agents work it" guarantee.
 *
 * Consent is pre-answered "defer" via the test seam.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/agent-board-live-move-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import {
  createTicketViaBridge,
  makeShortScratch,
  runVolliShim,
  shimPathFor,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  columnHasCard,
  createRunner,
  goToBoard,
  launch,
  makeGitRepo,
  pathExists,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("brd");
const { attempt, summarize } = createRunner();

const PREFIX = "LV";

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

    const projectPath = await makeGitRepo(scratch, "brd-");
    await seedProjects(page, [
      { id: "brd-project", name: "Live Board Project", path: projectPath, prefix: PREFIX },
    ]);
    const { displayId } = await createTicketViaBridge(page, "Live Board Project", {
      title: "Live move ticket",
      status: "todo",
    });

    // Hydrate the board store with the new ticket, then land on the board.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);
    await goToBoard(page);

    await waitUntil(
      "shim + socket to exist",
      async () => (await pathExists(shimPath)) && (await pathExists(socketPath)),
    );

    // === 1. Precondition: the card starts in Todo ==========================
    await attempt(1, "seeded ticket renders in the Todo column", async () => {
      const inTodo = await waitUntil("card in Todo", () => columnHasCard(page, "Todo", displayId), {
        timeout: 8000,
      })
        .then(() => true)
        .catch(() => false);
      return { ok: inTodo, detail: `todo=${inTodo}` };
    });

    // === 2. A socket move lands the card in Doing LIVE, without a reload ====
    await attempt(2, "CLI move --to doing moves the card to Doing live (no reload)", async () => {
      const r = await runVolliShim(shimPath, ["ticket", "move", displayId, "--to", "doing"]);
      if (r.code !== 0)
        return { ok: false, detail: `CLI move failed code=${r.code} stderr=${r.stderr.trim()}` };

      // No page.reload(): the card must arrive in Doing via volli:data-changed.
      const inDoing = await waitUntil(
        "card to appear in Doing live",
        () => columnHasCard(page, "Doing", displayId),
        { timeout: 8000 },
      )
        .then(() => true)
        .catch(() => false);
      const leftTodo = !(await columnHasCard(page, "Todo", displayId));
      const ok = inDoing && leftTodo;
      return {
        ok,
        detail: `cliOut=${JSON.stringify(r.stdout.trim())} inDoing=${inDoing} leftTodo=${leftTodo}`,
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
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
