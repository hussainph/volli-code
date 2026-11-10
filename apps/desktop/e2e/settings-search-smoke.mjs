/**
 * Every row label on both settings surfaces is reachable from rail search
 * (VC-111).
 *
 * WHY THIS EXISTS. `PrefCategory.keywords` is hand-maintained, and a rail
 * search that silently fails to find a setting is worse than one that does not
 * exist: it teaches people the setting is not there. The category LABEL matches
 * for free; everything INSIDE a pane is findable only if some keyword covers
 * it, and nothing about adding a row reminds you to add one.
 *
 * So this drives the real surfaces. It opens every category, reads the label of
 * every section header, setting row and table column in it, types each one into
 * the rail's search field, and fails if the category it came from is not among
 * the results.
 *
 * It is a search-COVERAGE check, not a search-behaviour check: it does not care
 * how matching works, only that a word someone can see leads back to the page
 * it is on.
 *
 * Runs in CI's extended smoke tier. To run locally with a display + built app:
 *
 *   vp run --filter @volli/desktop build
 *   VOLLI_QUIET_WINDOWS=1 vp exec node apps/desktop/e2e/settings-search-smoke.mjs
 */
import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
} from "./lib/smoke-kit.mjs";
import {
  assertSettingsWindow,
  closeSettingsWindow,
  openSettingsWindow,
} from "./lib/settings-window.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-settings-search-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/**
 * The SETTINGS VOCABULARY of the open pane: section titles and setting-row
 * labels, read off the two `data-slot` markers the kit puts on them.
 *
 * The markers matter, because "every string on the page" is the wrong set and
 * the difference is not cosmetic. A model's name, a provider's name, an
 * orphaned worktree's path and a skill's slug are DATA — unbounded, arriving
 * from disk or an API — and no hand-maintained keyword list can cover them.
 * Requiring it would make this check permanently red and therefore ignored.
 * Those collections carry their own in-table search instead.
 *
 * What must be reachable is the vocabulary the app itself chose: the words a
 * designer typed, which are exactly the words someone half-remembers and goes
 * looking for.
 */
async function visibleRowLabels(page) {
  return page.evaluate(() => {
    const texts = new Set();
    const selector = '[data-slot="pref-section-title"], [data-slot="pref-row-label"]';
    for (const node of document.querySelectorAll(selector)) {
      if (node.closest("[hidden]") !== null) continue;
      // Provider names are catalogue data. Section TITLES remain searchable —
      // they sit in the header, outside these containers — but the unbounded
      // rows inside do not belong in rail keywords.
      //
      // Prefix match, so both halves are covered. An exact match on
      // `model-access-accounts` missed `-available`, and because that list only
      // renders once the catalogue has loaded, the check failed or passed
      // depending on timing. It was written off as a flake once; it was not.
      if (node.closest('[data-slot^="model-access-accounts"]') !== null) continue;
      const text = (node.textContent ?? "").trim();
      if (text.length >= 4 && text.length <= 40) texts.add(text);
    }
    return [...texts];
  });
}

/**
 * App settings and project overrides share one shell: one rail, named "Settings
 * categories", whose header is the scope switch ("All projects" or the
 * project). `scope` is the word a search result prints for that half —
 * "All projects" or "Project" — so a label found only in the other scope's
 * page of the same name does not count.
 */
const settingsRail = (page) => page.getByRole("navigation", { name: "Settings categories" });

/**
 * The inner text of every rail button below the scope switch: category rows
 * with the search empty, result rows while it holds a query.
 */
const railNames = (page) =>
  settingsRail(page).evaluate((nav) =>
    [...nav.querySelectorAll("button")]
      .filter((button) => button.closest('[aria-label="Settings scope"]') === null)
      .map((button) => (button.innerText ?? "").trim())
      .filter(Boolean),
  );

/** Opens one category and returns every label it shows. */
async function labelsFor(page, category) {
  const nav = settingsRail(page);
  await nav.getByRole("searchbox").fill("");
  await nav.getByRole("button", { name: category, exact: true }).click();
  return visibleRowLabels(page);
}

/**
 * Types `label` into rail search and reports whether `category` survives it.
 * A result row reads "<match>\n<scope> · <category>".
 */
async function reachable(page, scope, category, label) {
  await settingsRail(page).getByRole("searchbox").fill(label);
  const found = (await railNames(page)).map((row) => row.split("\n").at(-1)?.trim());
  return found.includes(`${scope} · ${category}`);
}

async function auditSurface(page, surface, scope, startAt) {
  const categories = await railNames(page);
  await attempt(startAt, `${surface}: the rail offers its categories`, async () => ({
    ok: categories.length > 0,
    detail: categories.join(" · "),
  }));

  let n = startAt;
  for (const category of categories) {
    n += 1;
    const labels = await labelsFor(page, category);
    const unreachable = [];
    for (const label of labels) {
      if (!(await reachable(page, scope, category, label))) unreachable.push(label);
    }
    await settingsRail(page).getByRole("searchbox").fill("");

    await attempt(n, `${surface} → ${category}: every visible label finds this page`, async () => ({
      ok: unreachable.length === 0,
      detail:
        unreachable.length === 0
          ? `${labels.length} labels`
          : `unreachable: ${unreachable.join(" · ")}`,
    }));
  }
  return n;
}

const app = await launch({ dbPath, userDataDir });
let exitCode = 1;

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await assertProfileIsolated(app, userDataDir);
  assertBuiltRendererLoaded(page);

  // Seed a real project so both file-backed inventories and overrides are audited.
  const repo = await makeGitRepo(scratch, "search-project-");
  await seedProjects(page, [{ id: "search-p1", name: "Search Fixture", path: repo, prefix: "SF" }]);

  let settingsPage = null;
  await must(1, "Settings opens in its own native window on its category rail", async () => {
    settingsPage = await openSettingsWindow(app, page);
    const evidence = await assertSettingsWindow(app, page, settingsPage);
    const nav = settingsRail(settingsPage);
    await nav.waitFor();
    // The app-wide scope, explicitly: Settings reopens on its last page.
    await nav.getByRole("button", { name: "All projects", exact: true }).click();
    await nav.getByRole("button", { name: "All projects", pressed: true }).waitFor();
    return {
      ok: evidence.nativeSettingsCount === 1 && !evidence.mainHasSettingsDialog,
      detail: `nativeWindow=${evidence.nativeWindowId} windows=${evidence.nativeWindowCount} mainDialog=${evidence.mainHasSettingsDialog}`,
    };
  });
  if (settingsPage === null) throw new Error("Settings never opened");

  const last = await auditSurface(settingsPage, "Settings", "All projects", 2);

  // Audit project overrides as well: moving their entry point must not remove
  // the searchability assertions previously exercised through Configure.
  await settingsRail(settingsPage)
    .getByRole("button", { name: "Search Fixture", exact: true })
    .click();
  await settingsRail(settingsPage)
    .getByRole("button", { name: "All projects", pressed: false })
    .waitFor();
  const lastProject = await auditSurface(settingsPage, "Project settings", "Project", last + 1);

  // ---- the native window's own contract -----------------------------------
  const opened = await assertSettingsWindow(app, page, settingsPage);
  await attempt(
    lastProject + 1,
    "a second Settings entry reuses the one native window (nonmodal)",
    async () => {
      const before = opened;
      settingsPage = await openSettingsWindow(app, page);
      const after = await assertSettingsWindow(app, page, settingsPage);
      return {
        ok:
          after.nativeWindowId === before.nativeWindowId &&
          after.nativeSettingsCount === 1 &&
          after.nativeWindowCount === before.nativeWindowCount &&
          !after.mainHasSettingsDialog &&
          !page.isClosed(),
        detail: `before=${before.nativeWindowId} after=${after.nativeWindowId} windows=${after.nativeWindowCount} mainAlive=${!page.isClosed()}`,
      };
    },
  );

  await attempt(lastProject + 2, "Escape does not close the nonmodal Settings window", async () => {
    await settingsPage.keyboard.press("Escape");
    // One frame is enough for a close handler to tear the page down.
    await settingsPage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(true))),
    );
    const evidence = await assertSettingsWindow(app, page, settingsPage);
    return {
      ok: !settingsPage.isClosed() && evidence.nativeSettingsCount === 1,
      detail: `closed=${settingsPage.isClosed()} nativeWindow=${evidence.nativeWindowId}`,
    };
  });

  await must(
    lastProject + 3,
    "closing Settings leaves the workbench; reopening creates one new window",
    async () => {
      const before = await assertSettingsWindow(app, page, settingsPage);
      await closeSettingsWindow(app, settingsPage);
      const workbenchAlive = !page.isClosed();
      const mainDialog = (await page.locator("[data-settings-panel]").count()) > 0;

      settingsPage = await openSettingsWindow(app, page);
      const after = await assertSettingsWindow(app, page, settingsPage);
      return {
        ok:
          workbenchAlive &&
          !mainDialog &&
          after.nativeSettingsCount === 1 &&
          after.nativeWindowCount === before.nativeWindowCount &&
          after.nativeWindowId !== before.nativeWindowId &&
          !after.mainHasSettingsDialog,
        detail: `old=${before.nativeWindowId} new=${after.nativeWindowId} windows=${after.nativeWindowCount} workbenchAlive=${workbenchAlive}`,
      };
    },
  );

  exitCode = summarize();
} finally {
  await closeAppBounded(app);
  await cleanup();
}

process.exit(exitCode);
