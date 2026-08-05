/**
 * E2e proof: an OpenCode model's enabled/disabled setting survives a full app
 * restart on the SAME profile — the durable `app_state` row
 * (`volli:runtime-preferences:opencode`, `main/runtime-catalog.ts`) actually
 * round-trips through SQLite rather than just living in renderer memory for
 * the life of one process.
 *
 * This drives the real Settings UI (Settings → Harness Runtimes → OpenCode),
 * toggles one model's `Switch` the way a person would, then quits and
 * relaunches Electron on the same `--user-data-dir` + `VOLLI_DB_PATH` and
 * checks three independent things at once:
 *   1. the raw `app_state` row itself (via `window.api.data.bootstrap()`,
 *      same reader `canvas-theming-smoke.mjs`'s `storedTheme()` uses) —
 *      proves SQLite actually held it;
 *   2. the model browser reaches its "loaded" state again on the second
 *      launch — proves discovery + the stored preferences merge cleanly on a
 *      cold boot, not just that the bytes are sitting in the table;
 *   3. the same model's `Switch` renders checked in the UI after restart —
 *      proves the full read path (app_state → `runtimeCatalog.inspect` →
 *      React state) draws the persisted value, not just that a lower layer
 *      has it.
 *
 * Which model gets toggled is identified two ways at once and cross-checked:
 * the aria-label text Playwright clicks through (a human-readable model
 * label) AND the `{providerId, modelId}` ref recovered from the app_state
 * diff right after the click (before vs. after `enabledModels`) — so the
 * restart assertion never has to reconstruct a provider/model identity by
 * scraping the model-browser DOM.
 *
 * Needs a REAL `opencode` binary discoverable off the login-shell PATH, with
 * at least one provider it can list models for — there is no fake OpenCode
 * HTTP server in this repo's e2e kit (see `session-rpc-transport-smoke.mjs`
 * check 5, which tolerates "OpenCode unavailable" for the same reason). If
 * the catalog reports itself unavailable, this probe reports that and stops
 * rather than fabricating a pass.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/harness-settings-persistence-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app + a real `opencode` install);
 * NOT wired into `vp test`.
 */
import { createRunner, launch, makeScratch, sleep, waitUntil } from "./lib/smoke-kit.mjs";

const { userDataDir, dbPath, cleanup } = await makeScratch("harness-settings-persistence-");
const { attempt, summarize } = createRunner();

/** `main/runtime-catalog.ts`'s `preferenceKey("opencode")` — the durable row this proves round-trips. */
const PREFERENCE_KEY = "volli:runtime-preferences:opencode";

/**
 * Settings → Harness Runtimes → OpenCode, then poll for the model browser to
 * settle: either it reports itself unavailable (with why), or at least one
 * model `Switch` is rendered. Mirrors `session-rpc-transport-smoke.mjs`
 * check 5's tolerance for a machine with no real OpenCode discovery.
 */
async function openOpenCodeModels(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Harness Runtimes", exact: true }).click();
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();
  return waitUntil("the OpenCode section to settle", async () => {
    if ((await page.getByText("Checking the local runtime…").count()) > 0) return false;
    if ((await page.getByText("OpenCode unavailable").count()) > 0) {
      const reason = await page
        .locator("p.mt-1.text-xs.text-muted-foreground")
        .first()
        .textContent()
        .catch(() => null);
      return { unavailable: true, reason };
    }
    const switchCount = await page.getByRole("switch").count();
    return switchCount > 0 ? { unavailable: false, switchCount } : false;
  });
}

/** The raw `app_state` value for `key`, parsed — `null` when the row is absent. */
async function readAppState(page, key) {
  const boot = await page.evaluate(() => window.api.data.bootstrap());
  if (!boot.ok) throw new Error(`bootstrap: ${boot.error}`);
  const raw = boot.data.appState[key];
  return raw ? JSON.parse(raw) : null;
}

/** `{providerId, modelId}` refs enabled in a stored preferences record, as `"providerId/modelId"` strings. */
function enabledRefs(stored) {
  return new Set(
    (stored?.preferences?.enabledModels ?? []).map((e) => `${e.providerId}/${e.modelId}`),
  );
}

async function main() {
  let app = await launch({ dbPath, userDataDir });
  try {
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    let settled;
    await attempt(1, "the OpenCode model browser loads with real data", async () => {
      settled = await openOpenCodeModels(page);
      if (settled.unavailable) {
        return { ok: false, detail: `OpenCode unavailable: ${settled.reason ?? "unknown reason"}` };
      }
      return {
        ok: settled.switchCount > 0,
        detail: `${settled.switchCount} model switches rendered`,
      };
    });

    if (!settled || settled.unavailable || settled.switchCount === 0) {
      console.log(
        "\nOpenCode's model catalog is unavailable on this machine — cannot prove settings" +
          " persistence against real data. Stopping rather than faking it.",
      );
      return summarize();
    }

    // Pick a model that starts OFF (a fresh scratch profile enables none), so
    // the toggle direction is unambiguous, and identify it two independent
    // ways: the aria-label Playwright clicked through, and the exact
    // {providerId, modelId} ref the app_state diff reveals after the save.
    let model = null;
    await attempt(2, "toggle one model's enabled switch on", async () => {
      const offSwitches = page.getByRole("switch", { name: /^Show .+ in chat$/ });
      const offCount = await offSwitches.count();
      if (offCount === 0) {
        return { ok: false, detail: "every model is already enabled — nothing to toggle on" };
      }
      const before = enabledRefs(await readAppState(page, PREFERENCE_KEY));
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

      const after = enabledRefs(await readAppState(page, PREFERENCE_KEY));
      const added = [...after].filter((ref) => !before.has(ref));
      if (added.length !== 1) {
        return {
          ok: false,
          detail: `expected exactly one newly-enabled ref, got ${JSON.stringify(added)}`,
        };
      }
      model = { label: modelLabel, ref: added[0] };
      return { ok: true, detail: `toggled "${modelLabel}" on (${model.ref})` };
    });

    if (model === null) {
      console.log("\nCould not toggle a model on — cannot prove persistence. Stopping.");
      return summarize();
    }

    // Give the write (already awaited by the click above via onSave→save→load)
    // a moment of slack before quitting — the same caution
    // composer-draft-smoke.mjs takes before a relaunch check.
    await sleep(500);
    await app.close();

    app = await launch({ dbPath, userDataDir });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await attempt(3, "the durable app_state row round-tripped across restart", async () => {
      const stored = await readAppState(page, PREFERENCE_KEY);
      const found = enabledRefs(stored).has(model.ref);
      return {
        ok: found,
        detail: found
          ? `${PREFERENCE_KEY} still lists ${model.ref} after restart`
          : `stored=${JSON.stringify(stored)}`,
      };
    });

    let settledAgain;
    await attempt(4, "the model browser reaches its loaded state again after restart", async () => {
      settledAgain = await openOpenCodeModels(page);
      return {
        ok: settledAgain.unavailable !== true && settledAgain.switchCount > 0,
        detail: settledAgain.unavailable
          ? `OpenCode unavailable: ${settledAgain.reason ?? "unknown reason"}`
          : `${settledAgain.switchCount} model switches rendered`,
      };
    });

    await attempt(
      5,
      "the toggled model's switch shows enabled in the UI after restart",
      async () => {
        const checked = await page
          .getByRole("switch", { name: `Hide ${model.label} in chat` })
          .count();
        return {
          ok: checked > 0,
          detail:
            checked > 0 ? `"${model.label}" renders checked` : `"${model.label}" renders unchecked`,
        };
      },
    );
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
