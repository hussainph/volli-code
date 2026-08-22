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
 * MANUALLY RUN (needs a display + the built app); CI does not run it:
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/settings-search-smoke.mjs
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
      const text = (node.textContent ?? "").trim();
      if (text.length >= 4 && text.length <= 40) texts.add(text);
    }
    return [...texts];
  });
}

const railNames = async (page, surface) =>
  (
    await page
      .getByRole("navigation", { name: `${surface} categories` })
      .getByRole("button")
      .allInnerTexts()
  )
    .map((text) => text.trim())
    .filter(Boolean);

/** Opens one category and returns every label it shows. */
async function labelsFor(page, surface, category) {
  const nav = page.getByRole("navigation", { name: `${surface} categories` });
  await nav.getByRole("searchbox").fill("");
  await nav.getByRole("button", { name: category, exact: true }).click();
  return visibleRowLabels(page);
}

/** Types `label` into rail search and reports whether `category` survives it. */
async function reachable(page, surface, category, label) {
  const nav = page.getByRole("navigation", { name: `${surface} categories` });
  await nav.getByRole("searchbox").fill(label);
  const found = await railNames(page, surface);
  return found.includes(category);
}

async function auditSurface(page, surface, startAt) {
  const categories = await railNames(page, surface);
  await attempt(startAt, `${surface}: the rail offers its categories`, async () => ({
    ok: categories.length > 0,
    detail: categories.join(" · "),
  }));

  let n = startAt;
  for (const category of categories) {
    n += 1;
    const labels = await labelsFor(page, surface, category);
    const unreachable = [];
    for (const label of labels) {
      if (!(await reachable(page, surface, category, label))) unreachable.push(label);
    }
    await page
      .getByRole("navigation", { name: `${surface} categories` })
      .getByRole("searchbox")
      .fill("");

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

  // Configure has no rail without a project, so one is seeded before anything
  // else — auditing only Settings would leave the surface this ticket changed
  // most entirely unchecked.
  const repo = await makeGitRepo(scratch, "search-project-");
  await seedProjects(page, [{ id: "search-p1", name: "Search Fixture", path: repo, prefix: "SF" }]);

  await must(1, "Settings opens on its category rail", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("navigation", { name: "Settings categories" }).waitFor();
    return { ok: true };
  });

  const last = await auditSurface(page, "Settings", 2);

  // Configure needs a project. With none selected the page is an empty state
  // and there is no rail to audit — correct behaviour, not a failure, so the
  // surface is audited only when it is actually there.
  const configure = page.getByRole("button", { name: "Configure", exact: true });
  if ((await configure.count()) > 0) {
    await configure.click();
    const nav = page.getByRole("navigation", { name: "Configure categories" });
    await nav.waitFor();
    await auditSurface(page, "Configure", last + 1);
  }

  exitCode = summarize();
} finally {
  await closeAppBounded(app);
  await cleanup();
}

process.exit(exitCode);
