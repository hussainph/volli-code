/**
 * VC-111 — asserts the fixes the independent review demanded
 * (docs/plans/settings-redesign-review.md) actually landed in the prototype.
 *
 * Boot-checking the scratch only proves it renders. These are the behaviours
 * the review named, and several of them (the live region, the help button, the
 * duplicate aria-labels) are invisible in a screenshot.
 *
 *   Run (in another terminal):  pnpm lab
 *   Then:                       node apps/desktop/e2e/vc111-review-fixes.mjs
 *
 * MANUALLY-RUN, like lab-boot-check.mjs. Not wired into `vp test`.
 */
import { existsSync } from "node:fs";

import { chromium } from "playwright-core";

const PORT = process.env.VOLLI_LAB_PORT ?? "5174";
const LAB = `http://localhost:${PORT}/lab/#settings-redesign`;

function resolveBrowser() {
  const override = process.env.VOLLI_CHROME ?? process.env.CHROME_PATH;
  if (override) return override;
  let registry;
  try {
    registry = chromium.executablePath();
  } catch {
    registry = undefined;
  }
  if (registry && existsSync(registry)) return registry;
  const found = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].find((path) => existsSync(path));
  if (!found) throw new Error("no Chromium — set VOLLI_CHROME");
  return found;
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const thrown = [];
page.on("pageerror", (error) => thrown.push(error.message));

/**
 * Rail buttons are matched on a PREFIX, not exactly, because a category with
 * an `attention` state deliberately appends a visually-hidden suffix to its
 * accessible name — "About 2 problems". That is review §4.4's fix: the first
 * pass made the dot `aria-hidden` and thereby deleted the signal for screen
 * readers instead of relocating it. The name-pollution the original bug was
 * about came from an `aria-label` on a decorative dot; a real text suffix that
 * a sighted user also gets (as a dot) is information, and "About, 2 problems"
 * is a good name for that row.
 */
const nav = (name) =>
  page
    .locator("nav")
    .first()
    .getByRole("button", { name: new RegExp(`^${name}`) });
const surface = (name) =>
  page.getByRole("group", { name: "Prototype surface" }).getByRole("button", { name });

await page.goto(LAB, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

/* — review §2.1: orphaned-worktree cleanup must still exist — */
await nav("Storage").click();
await page.waitForTimeout(400);
check(
  "§2.1 orphan cleanup has a home",
  (await page.getByRole("button", { name: "Delete worktree" }).count()) > 0,
  "Settings → Storage",
);
check(
  "§2.1 orphan rescan action",
  (await page.getByRole("button", { name: "Rescan orphaned worktrees" }).count()) > 0,
);

/* — review §1.5: the retention field must refuse a bad value — */
const ttl = page.locator("#ttl");
await ttl.fill("0");
await ttl.blur();
await page.waitForTimeout(300);
check(
  "§1.5 retention refuses < 1 day inline",
  (await page.locator("#ttl-error").count()) > 0,
  await page
    .locator("#ttl-error")
    .innerText()
    .catch(() => ""),
);
check("§1.5 refusal marks the field invalid", (await ttl.getAttribute("aria-invalid")) === "true");

/* — review §4.1: "Saved" must NOT be in the tree until something saved — */
await ttl.fill("21");
await page.waitForTimeout(200);
const savedBefore = await page.getByText("Saved", { exact: true }).count();
await ttl.blur();
await page.waitForTimeout(400);
const savedAfter = await page.getByText("Saved", { exact: true }).count();
check(
  "§4.1 'Saved' is absent before a save and present after",
  savedBefore === 0 && savedAfter === 1,
  `before=${savedBefore} after=${savedAfter}`,
);

/* — review §2.2: the reasoning control must still exist — */
await nav("Models").click();
await page.waitForTimeout(400);
check(
  "§2.2 reasoning level survives",
  (await page.getByRole("combobox", { name: "Reasoning level" }).count()) === 3,
);

/* — review §2.5: the catalog filter must match on provider, not just name — */
const modelSearch = page.getByLabel("Search models");
await modelSearch.fill("xAI");
await page.waitForTimeout(300);
const xaiRows = await page.locator('[data-testid^="visibility-"]').count();
await modelSearch.fill("");
await page.waitForTimeout(200);
const allRows = await page.locator('[data-testid^="visibility-"]').count();
check(
  "§2.5 catalog searches provider as well as name",
  xaiRows === 1 && allRows === 6,
  `xAI=${xaiRows} all=${allRows}`,
);

/* — review §2.11: testIds survive for the existing test suite — */
check(
  "§2.11 default-model-* testIds kept",
  (await page.locator('[data-testid="default-model-global"]').count()) === 1 &&
    (await page.locator('[data-testid="default-model-utility"]').count()) === 1,
);

/* — review §4.5: the help button must not activate the labelled control — */
const compaction = page.locator('[data-testid="auto-compaction"]').getByRole("switch");
const beforeHelp = await compaction.getAttribute("aria-checked");
await page
  .getByRole("button", { name: /Naming new chats/ })
  .first()
  .click();
await page.waitForTimeout(300);
const utilityRow = page.locator('[data-testid="default-model-utility"]');
check(
  "§4.5 help button is a sibling of the label, not inside it",
  (await utilityRow.locator("label button").count()) === 0,
  `switch untouched: ${beforeHelp === (await compaction.getAttribute("aria-checked"))}`,
);

/* — review §1.4: About keeps per-fault remedies rather than one button — */
await nav("About").click();
await page.waitForTimeout(400);
check(
  "§1.4 About lists faults with their own remedies",
  (await page.getByRole("button", { name: "Fix", exact: true }).count()) === 1 &&
    (await page.getByRole("button", { name: "Reveal", exact: true }).count()) === 1,
);
check(
  "§1.4.1 the legacy path is shown, not hidden",
  (await page.getByText("/usr/local/bin/volli").count()) > 0,
);
check(
  "§6.12 harness inventory keeps command + origin",
  (await page.getByText("my-harness").count()) > 0,
);

/* — review §4.3: the disclosure must expose its state — */
const details = page.getByRole("button", { name: "Details" });
check(
  "§4.4 attention state is in the accessible name, not deleted",
  (await page
    .locator("nav")
    .first()
    .getByRole("button", { name: /About 2 problems/ })
    .count()) === 1,
);
check(
  "§4.3 disclosure has aria-expanded",
  (await details.getAttribute("aria-expanded")) === "false",
);
await details.click();
await page.waitForTimeout(300);
check(
  "§4.3 aria-expanded flips",
  (await page.getByRole("button", { name: "Hide details" }).getAttribute("aria-expanded")) ===
    "true",
);

/* — review §1.2a: app-scope terminal rows are never hidden — */
await nav("Appearance").click();
await page.waitForTimeout(400);
check(
  "§1.2a terminal font + size are always present at app scope",
  (await page.getByText("Ghostty config").count()) === 1 &&
    (await page.getByText("Volli overlay").count()) === 1,
);
check(
  "§2.8 canvas keeps vibrancy and grain",
  (await page.getByText("Vibrancy").count()) === 1 && (await page.getByText("Grain").count()) === 1,
);
check(
  "§1.2c overrides are named, not counted",
  (await page.getByRole("button", { name: "acme-api" }).count()) === 1,
);

/* — review §4.2: every inherit control needs its own name — */
await surface("Configure").click();
await page.waitForTimeout(600);
await nav("Appearance").click();
await page.waitForTimeout(400);
const scopeNames = ["Appearance scope", "Canvas scope", "Terminal theme scope"];
const found = [];
for (const name of scopeNames) {
  found.push(await page.getByRole("group", { name, exact: true }).count());
}
check(
  "§4.2 inherit controls have distinct accessible names",
  found.every((n) => n === 1),
  found.join("/"),
);
check(
  "§1.6 no group is named the generic 'Scope'",
  (await page.getByRole("group", { name: "Scope", exact: true }).count()) === 0,
);

/* — review §1.1: precedence must be published — */
await nav("Sessions").click();
await page.waitForTimeout(400);
check(
  "§1.1 model precedence is stated",
  (await page.getByText(/own composer, then this project/).count()) > 0,
);

/* — review §2.6: the worktreeinclude trap is gone — */
await nav("Worktrees").click();
await page.waitForTimeout(400);
check(
  "§2.6 copy set is read-only until explicitly created",
  (await page.locator("textarea").count()) === 0 &&
    (await page.getByRole("button", { name: /Create .worktreeinclude/ }).count()) === 1,
);

/* — review §1.5: base branch refuses an unknown ref — */
const base = page.locator("#base");
await base.fill("mian");
await base.blur();
await page.waitForTimeout(300);
check(
  "§1.5 base branch refuses an unknown ref inline",
  (await page.locator("#base-error").count()) > 0,
  await page
    .locator("#base-error")
    .innerText()
    .catch(() => ""),
);

/* — review §2.4: empty and no-results are different strings — */
await nav("Skills").click();
await page.waitForTimeout(400);
await page.getByLabel("Search skills").fill("zzzz");
await page.waitForTimeout(300);
check(
  "§2.4 no-results copy is distinct from empty copy",
  (await page.getByText("No skills match.").count()) === 1,
);

check("no uncaught errors", thrown.length === 0, thrown.join("; "));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
