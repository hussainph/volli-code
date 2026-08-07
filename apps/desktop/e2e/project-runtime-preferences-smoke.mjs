/**
 * E2e proof: one project's model list is genuinely ITS OWN — Configure → Runtime
 * writes the project's `projects.runtime_preferences` column (migration 019),
 * that column survives a full app restart, app-wide Settings is untouched by it,
 * and switching back to Inherit REMOVES the key rather than storing a marker.
 *
 * The global-scope twin of this is `harness-settings-persistence-smoke.mjs`,
 * which proves the same round trip for the app-wide `app_state` row. This one
 * exists because the two scopes are separate storage with separate failure
 * modes, and the interesting claims are the ones only a second scope can make:
 *
 *   1. a fresh project starts on **Inherit**, with no stored key at all — the
 *      absence of a row, not a stored "inherit";
 *   2. **Custom pins what was inherited**: the flip writes the project's column
 *      with the very preferences that were already on screen, so the mode change
 *      alone changes nothing the user can see;
 *   3. a model enabled at project scope lands in the PROJECT's column and NOT in
 *      the global `app_state` row — the isolation the column exists for;
 *   4. all of it survives a relaunch, read back through the real UI (mode reads
 *      Custom, the switch reads checked) and not just out of the table;
 *   5. app-wide Settings still shows that model disabled, on the same launch;
 *   6. **Inherit clears the column** — the key is gone, not set to something —
 *      and that erasure survives a relaunch too.
 *
 * The durable half is read straight out of SQLite with `node:sqlite` rather than
 * through the app: `runtime_preferences` is deliberately absent from the boot
 * payload (`db/projects-repo.ts` — only the catalog interprets it), so unlike
 * the global row there is no `window.api` reader to borrow. Reading the file is
 * the only way to assert on the bytes rather than on the UI that drew them.
 *
 * Needs a REAL `opencode` binary discoverable off the login-shell PATH, with at
 * least one provider it can list models for. If the catalog reports itself
 * unavailable this probe reports that and stops rather than fabricating a pass —
 * the same honesty `harness-settings-persistence-smoke.mjs` keeps.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/project-runtime-preferences-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app + a real `opencode` install);
 * NOT wired into `vp test`.
 */
import { DatabaseSync } from "node:sqlite";

import {
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("project-runtime-prefs-");
const { attempt, summarize } = createRunner();

const ADAPTER_ID = "opencode";
/** `main/runtime-catalog.ts`'s `preferenceKey("opencode")` — the GLOBAL row, which must stay untouched. */
const GLOBAL_PREFERENCE_KEY = "volli:runtime-preferences:opencode";
const PROJECT_NAME = "Runtime Scope";

// ---- readers ---------------------------------------------------------------

/**
 * This project's stored record for one adapter, straight out of the file.
 * `null` when the column is NULL or holds no key for the adapter — the two ways
 * "inherits the global record" is spelled, and both must read the same here.
 */
function readProjectRecord(projectId) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT runtime_preferences FROM projects WHERE id = ?").get(projectId);
    const raw = row?.runtime_preferences ?? null;
    if (raw === null) return null;
    const records = JSON.parse(raw);
    return records[ADAPTER_ID] ?? null;
  } finally {
    db.close();
  }
}

/** The raw `app_state` value for `key`, parsed — `null` when the row is absent. */
async function readAppState(page, key) {
  const boot = await page.evaluate(() => window.api.data.bootstrap());
  if (!boot.ok) throw new Error(`bootstrap: ${boot.error}`);
  const raw = boot.data.appState[key];
  return raw ? JSON.parse(raw) : null;
}

/** `{providerId, modelId}` refs enabled in a stored record, as `"providerId/modelId"` strings. */
function enabledRefs(stored) {
  return new Set(
    (stored?.preferences?.enabledModels ?? []).map((e) => `${e.providerId}/${e.modelId}`),
  );
}

/** One segmented control's button for `choice` (`data-choice` on the segment). */
const segment = (page, testId, choice) =>
  page.getByTestId(testId).locator(`[data-choice="${choice}"]`);

/** Which segment of the scope control is pressed — "inherit", "custom", or null. */
async function scopeMode(page) {
  for (const choice of ["inherit", "custom"]) {
    const pressed = await segment(page, "project-runtime-models-mode", choice)
      .getAttribute("aria-pressed")
      .catch(() => null);
    if (pressed === "true") return choice;
  }
  return null;
}

// ---- navigation ------------------------------------------------------------

/** Configure → Runtime → OpenCode, for whichever project is selected. */
async function openProjectRuntime(page) {
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Configure categories" })
    .getByRole("button", { name: "Runtime", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Harnesses" })
    .getByRole("button", { name: "OpenCode", exact: true })
    .click();
  return settleModels(page, { scoped: true });
}

/** Settings → Harness Runtimes → OpenCode: the app-wide pane, which must stay unchanged. */
async function openGlobalRuntime(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Harness Runtimes", exact: true }).click();
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();
  return settleModels(page, { scoped: false });
}

/**
 * Poll for the Models section to reach a state that says something: the runtime
 * reports itself unavailable (with why), the project is inheriting (no grid at
 * all — that is the point of Inherit), or the grid is up with switches in it.
 */
async function settleModels(page, { scoped }) {
  if (scoped) await page.getByTestId("project-runtime-models-mode").waitFor();
  return waitUntil("the Models section to settle", async () => {
    if ((await page.getByText("Checking the local runtime…").count()) > 0) return false;
    if ((await page.getByText("OpenCode unavailable").count()) > 0) {
      const reason = await page
        .locator("p.mt-1.text-xs.text-muted-foreground")
        .first()
        .textContent()
        .catch(() => null);
      return { unavailable: true, reason };
    }
    if (scoped && (await page.getByTestId("project-runtime-models-inherit").count()) > 0) {
      return { unavailable: false, mode: "inherit", switchCount: 0 };
    }
    const switchCount = await page.getByRole("switch").count();
    return switchCount > 0 ? { unavailable: false, mode: "custom", switchCount } : false;
  });
}

// ---- run -------------------------------------------------------------------

async function main() {
  const repo = await makeGitRepo(scratch, "runtime-scope-");
  let app = await launch({ dbPath, userDataDir });
  let projectId = null;
  let model = null;

  try {
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await seedProjects(page, [
      { id: "seed-runtime-scope", name: PROJECT_NAME, path: repo, prefix: "RS" },
    ]);
    const { byName } = await readSeededProjects(page);
    projectId = byName[PROJECT_NAME]?.id ?? null;
    if (projectId === null) throw new Error(`project "${PROJECT_NAME}" was never imported`);

    let settled;
    await attempt(
      1,
      "a fresh project opens Configure → Runtime on Inherit, storing nothing",
      async () => {
        settled = await openProjectRuntime(page);
        if (settled.unavailable) {
          return {
            ok: false,
            detail: `OpenCode unavailable: ${settled.reason ?? "unknown reason"}`,
          };
        }
        const mode = await scopeMode(page);
        const stored = readProjectRecord(projectId);
        return {
          ok: mode === "inherit" && settled.mode === "inherit" && stored === null,
          detail: `mode=${mode} body=${settled.mode} storedColumn=${JSON.stringify(stored)}`,
        };
      },
    );

    if (!settled || settled.unavailable) {
      console.log(
        "\nOpenCode's model catalog is unavailable on this machine — cannot prove per-project" +
          " runtime preferences against real data. Stopping rather than faking it.",
      );
      return summarize();
    }

    // Custom must PIN what was inherited: the column gains a record holding the
    // exact preferences already on screen, so the flip changes what the choice
    // means and not what it shows.
    await attempt(2, "Custom pins the inherited list into this project's column", async () => {
      const inheritedGlobal = enabledRefs(await readAppState(page, GLOBAL_PREFERENCE_KEY));
      await segment(page, "project-runtime-models-mode", "custom").click();
      const stored = await waitUntil("the project column to take a record", () =>
        readProjectRecord(projectId),
      ).catch(() => null);
      if (stored === null) return { ok: false, detail: "the project column stayed empty" };
      const pinned = enabledRefs(stored);
      const same =
        pinned.size === inheritedGlobal.size && [...pinned].every((r) => inheritedGlobal.has(r));
      const mode = await scopeMode(page);
      const pill = await page.getByText("Set by this project").count();
      return {
        ok: same && mode === "custom" && pill > 0,
        detail: `mode=${mode} pill=${pill} pinned=[${[...pinned]}] inherited=[${[...inheritedGlobal]}]`,
      };
    });

    await attempt(3, "the models grid renders under Custom", async () => {
      const grid = await settleModels(page, { scoped: true });
      return {
        ok: grid.unavailable !== true && grid.switchCount > 0,
        detail: grid.unavailable
          ? `OpenCode unavailable: ${grid.reason ?? "unknown reason"}`
          : `${grid.switchCount} model switches rendered`,
      };
    });

    // Identify the toggled model two independent ways at once, as the global
    // smoke does: the aria-label Playwright clicked through, and the exact
    // {providerId, modelId} ref the stored-column diff reveals after the save.
    await attempt(4, "enabling a model writes the PROJECT column, not the global row", async () => {
      const offSwitches = page.getByRole("switch", { name: /^Show .+ in chat$/ });
      if ((await offSwitches.count()) === 0) {
        return { ok: false, detail: "every model is already enabled — nothing to toggle on" };
      }
      const before = enabledRefs(readProjectRecord(projectId));
      const globalBefore = enabledRefs(await readAppState(page, GLOBAL_PREFERENCE_KEY));
      const offSwitch = offSwitches.first();
      const label = await offSwitch.getAttribute("aria-label");
      const modelLabel = label.replace(/^Show /, "").replace(/ in chat$/, "");
      await offSwitch.click();
      const flipped = await waitUntil(
        `"${modelLabel}" switch to flip to checked`,
        async () =>
          (await page.getByRole("switch", { name: `Hide ${modelLabel} in chat` }).count()) > 0,
      ).catch(() => false);
      if (!flipped) return { ok: false, detail: `"${modelLabel}" never flipped to checked` };

      const added = [...enabledRefs(readProjectRecord(projectId))].filter((r) => !before.has(r));
      const globalAfter = enabledRefs(await readAppState(page, GLOBAL_PREFERENCE_KEY));
      const globalUntouched =
        globalAfter.size === globalBefore.size &&
        [...globalAfter].every((r) => globalBefore.has(r));
      if (added.length !== 1) {
        return {
          ok: false,
          detail: `expected one newly-enabled ref, got ${JSON.stringify(added)}`,
        };
      }
      model = { label: modelLabel, ref: added[0] };
      return {
        ok: globalUntouched,
        detail: `project gained ${model.ref}; global row ${globalUntouched ? "untouched" : `CHANGED to [${[...globalAfter]}]`}`,
      };
    });

    if (model === null) {
      console.log("\nCould not enable a model at project scope — cannot prove the rest. Stopping.");
      return summarize();
    }

    await attempt(5, "app-wide Settings still shows that model disabled", async () => {
      const global = await openGlobalRuntime(page);
      if (global.unavailable) {
        return { ok: false, detail: `OpenCode unavailable: ${global.reason ?? "unknown reason"}` };
      }
      const enabledHere = await page
        .getByRole("switch", { name: `Hide ${model.label} in chat` })
        .count();
      const scopeControl = await page.getByTestId("project-runtime-models-mode").count();
      return {
        ok: enabledHere === 0 && scopeControl === 0,
        detail:
          `"${model.label}" ${enabledHere === 0 ? "renders unchecked" : "LEAKED as checked"};` +
          ` scope control on the app-wide pane: ${scopeControl}`,
      };
    });

    // The write is already awaited by the click above (onSave → save → load);
    // the same slack composer-draft-smoke.mjs takes before a relaunch check.
    await sleep(500);
    await app.close();

    app = await launch({ dbPath, userDataDir });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);

    await attempt(6, "the project's column round-tripped across restart", async () => {
      const stored = readProjectRecord(projectId);
      const found = enabledRefs(stored).has(model.ref);
      return {
        ok: found,
        detail: found
          ? `projects.runtime_preferences still lists ${model.ref}`
          : `stored=${JSON.stringify(stored)}`,
      };
    });

    await attempt(7, "Configure → Runtime reopens on Custom with the model checked", async () => {
      const reopened = await openProjectRuntime(page);
      if (reopened.unavailable) {
        return { ok: false, detail: `OpenCode unavailable: ${reopened.reason ?? "unknown"}` };
      }
      const mode = await scopeMode(page);
      const checked = await page
        .getByRole("switch", { name: `Hide ${model.label} in chat` })
        .count();
      const pill = await page.getByText("Set by this project").count();
      return {
        ok: mode === "custom" && checked > 0 && pill > 0,
        detail: `mode=${mode} pill=${pill} "${model.label}" ${checked > 0 ? "checked" : "UNCHECKED"}`,
      };
    });

    await attempt(8, "Inherit clears the column rather than storing a marker", async () => {
      await segment(page, "project-runtime-models-mode", "inherit").click();
      const cleared = await waitUntil("the project column to empty", async () =>
        readProjectRecord(projectId) === null ? "cleared" : null,
      ).catch(() => null);
      const note = await page.getByTestId("project-runtime-models-inherit").count();
      const mode = await scopeMode(page);
      const switches = await page.getByRole("switch").count();
      return {
        ok: cleared === "cleared" && mode === "inherit" && note > 0 && switches === 0,
        detail:
          `column=${cleared ?? JSON.stringify(readProjectRecord(projectId))} mode=${mode}` +
          ` note=${note} switchesLeft=${switches}`,
      };
    });

    await sleep(500);
    await app.close();

    app = await launch({ dbPath, userDataDir });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);

    await attempt(9, "the project follows app-wide again after restart", async () => {
      const reopened = await openProjectRuntime(page);
      if (reopened.unavailable) {
        return { ok: false, detail: `OpenCode unavailable: ${reopened.reason ?? "unknown"}` };
      }
      const mode = await scopeMode(page);
      const stored = readProjectRecord(projectId);
      return {
        ok: mode === "inherit" && reopened.mode === "inherit" && stored === null,
        detail: `mode=${mode} body=${reopened.mode} storedColumn=${JSON.stringify(stored)}`,
      };
    });
  } finally {
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
