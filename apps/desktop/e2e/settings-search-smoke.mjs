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

  await must(1, "Settings opens on its category rail", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    const nav = settingsRail(page);
    await nav.waitFor();
    // The app-wide scope, explicitly: Settings reopens on its last page.
    await nav.getByRole("button", { name: "All projects", exact: true }).click();
    await nav.getByRole("button", { name: "All projects", pressed: true }).waitFor();
    return { ok: true };
  });

  const last = await auditSurface(page, "Settings", "All projects", 2);

  // Audit project overrides as well: moving their entry point must not remove
  // the searchability assertions previously exercised through Configure.
  await settingsRail(page).getByRole("button", { name: "Search Fixture", exact: true }).click();
  await settingsRail(page).getByRole("button", { name: "All projects", pressed: false }).waitFor();
  await auditSurface(page, "Project settings", "Project", last + 1);

  exitCode = summarize();
} finally {
  await closeAppBounded(app);
  await cleanup();
}

process.exit(exitCode);
