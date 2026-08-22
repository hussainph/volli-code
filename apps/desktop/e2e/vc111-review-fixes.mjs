/**
 * VC-111 — asserts the prototype still satisfies (a) the independent review's
 * findings and (b) the component pass that followed it.
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

/** Rail names carry an sr-only attention suffix, so match on a prefix. */
const nav = (name) =>
  page
    .locator("nav")
    .first()
    .getByRole("button", { name: new RegExp(`^${name}`) });
const surface = (name) =>
  page.getByRole("group", { name: "Prototype surface" }).getByRole("button", { name });

await page.goto(LAB, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

console.log("\n── the independent review ──");

/* §2.1 — orphaned-worktree cleanup still has a home */
await nav("Storage").click();
await page.waitForTimeout(400);
check(
  "§2.1 orphan cleanup has a home",
  (await page.getByRole("button", { name: /^Delete ~\/.volli\/worktrees/ }).count()) === 2,
  "Settings → Storage",
);

/* §1.5 — the retention field refuses a value that would delete sooner */
const ttl = page.locator("#ttl");
await ttl.fill("0");
await ttl.blur();
await page.waitForTimeout(300);
check("§1.5 retention refuses < 1 day inline", (await page.locator("#ttl-error").count()) > 0);
check("§1.5 refusal marks the field invalid", (await ttl.getAttribute("aria-invalid")) === "true");

/* §4.1 — "Saved" is absent until something saved */
await ttl.fill("21");
await page.waitForTimeout(200);
const savedBefore = await page.getByText("Saved", { exact: true }).count();
await ttl.blur();
await page.waitForTimeout(400);
check(
  "§4.1 'Saved' absent before a save, present after",
  savedBefore === 0 && (await page.getByText("Saved", { exact: true }).count()) === 1,
);

/* §2.2 — reasoning survives */
await nav("Models").click();
await page.waitForTimeout(400);
check(
  "§2.2 reasoning level survives",
  (await page.getByRole("combobox", { name: "Reasoning level" }).count()) === 3,
);

/* §2.5 — the catalogue filters on provider, not just name */
const modelSearch = page.getByLabel("Search models");
await modelSearch.fill("xAI");
await page.waitForTimeout(300);
const xaiRows = await page.locator('[data-testid^="visibility-"]').count();
await modelSearch.fill("");
await page.waitForTimeout(200);
check(
  "§2.5 catalogue searches provider as well as name",
  xaiRows === 1 && (await page.locator('[data-testid^="visibility-"]').count()) === 10,
  `xAI=${xaiRows}`,
);

/* §2.11 — testIds the existing suite depends on */
check(
  "§2.11 default-model-* testIds kept",
  (await page.locator('[data-testid="default-model-global"]').count()) === 1 &&
    (await page.locator('[data-testid="default-model-utility"]').count()) === 1,
);

/* §1.4 — About keeps per-fault remedies */
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
  "§4.4 attention state is in the accessible name",
  (await page
    .locator("nav")
    .first()
    .getByRole("button", { name: /About 2 problems/ })
    .count()) === 1,
);

/* §4.3 — the disclosure exposes its state */
const details = page.getByRole("button", { name: "Details" });
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

/* §1.2a / §2.8 — nothing scope-hidden, canvas intact */
await nav("Appearance").click();
await page.waitForTimeout(400);
check(
  "§1.2a terminal config files always present",
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

console.log("\n── the component pass ──");

/* Pills: Segmented survives in exactly one place on Settings. */
const settingsSegmented = await page
  .locator("main, [role='group']")
  .first()
  .evaluate(
    () => document.querySelectorAll("[data-testid='appearance-mode'] [role='group']").length,
  )
  .catch(() => 0);
check(
  "one Segmented on Settings → Appearance (Light/Dark/Auto)",
  (await page.getByRole("group", { name: "Appearance mode" }).count()) === 1,
  `mode groups=${settingsSegmented}`,
);
check(
  "diff layout is a Select, not two more pills",
  (await page.getByRole("combobox", { name: /Diff layout/ }).count()) === 1 ||
    (await page.locator("#diff").count()) === 1,
);

/* Web search provider became a Select. */
await nav("Web Search").click();
await page.waitForTimeout(400);
check(
  "web search provider is a Select, not four pills",
  (await page.locator("#provider").count()) === 1 &&
    (await page.getByRole("group", { name: "Web search provider" }).count()) === 0,
);

/* InfoHint replaces prose, and is reachable by keyboard. */
const hint = page.getByRole("button", { name: "About Web search" });
check("sections explain via an (i), not a paragraph", (await hint.count()) === 1);
await hint.focus();
await page.waitForTimeout(300);
check(
  "the (i) opens on focus (keyboard-reachable)",
  (await page.getByText(/Applies to every project/).count()) > 0,
);

/* Tables: bounded height, sticky header, real semantics. */
await nav("Models").click();
await page.waitForTimeout(400);
const table = page.getByRole("table", { name: "Model catalog" });
check("the catalogue is a real <table>", (await table.count()) === 1);
check(
  "provider is a column, not a badge on every row",
  (await page.getByRole("columnheader", { name: "Provider" }).count()) === 1,
);
const bounded = await table.locator("xpath=ancestor::div[contains(@style,'max-height')]").count();
check("the table is height-capped so the page stays navigable", bounded === 1);

console.log("\n── Configure ──");

await surface("Configure").click();
await page.waitForTimeout(600);
await nav("Skills").click();
await page.waitForTimeout(500);

check(
  "skills are a table with a Source column",
  (await page.getByRole("table", { name: /Skills available/ }).count()) === 1 &&
    (await page.getByRole("columnheader", { name: "Source" }).count()) === 1,
);

/* The pill reduction, measured: one filter replaces N repeated pills. */
const sourceFilter = page.getByRole("combobox", { name: "Filter by source" });
check("one Source filter replaces a pill per row", (await sourceFilter.count()) === 1);
await sourceFilter.click();
await page.waitForTimeout(300);
await page.getByRole("option", { name: "This project" }).click();
await page.waitForTimeout(400);
const projectRows = await page.locator('[data-testid^="skill-"]').count();
check("the Source filter actually filters", projectRows === 2, `${projectRows} project skills`);
await sourceFilter.click();
await page.waitForTimeout(300);
await page.getByRole("option", { name: "All sources" }).click();
await page.waitForTimeout(400);

check(
  "§2.4 no-results copy is distinct from empty copy",
  await (async () => {
    await page.getByLabel("Search skills").fill("zzzz");
    await page.waitForTimeout(300);
    const has = (await page.getByText("No skills match.").count()) === 1;
    await page.getByLabel("Search skills").fill("");
    await page.waitForTimeout(200);
    return has;
  })(),
);

/* The skill switch names its own scope. */
check(
  "the skill switch says which scope it writes",
  (await page.getByRole("switch", { name: "Enable tdd in this project" }).count()) === 1,
);

/* New command — a designed feature, not a dead button. */
await nav("Commands").click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "New command" }).click();
await page.waitForTimeout(500);
check("New command opens a real form", (await page.getByRole("dialog").count()) === 1);
const create = page.getByRole("button", { name: "Create" });
check("Create is disabled until the form is valid", await create.isDisabled());
await page.locator("#cmd-name").fill("Ship It!");
await page.waitForTimeout(300);
check(
  "the command name is validated against the loader's rule",
  (await page.locator("#cmd-name-error").count()) === 1,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

/* Add server — the transport fork. */
await nav("MCP").click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "Add server" }).click();
await page.waitForTimeout(500);
check(
  "Add server asks for a command when local",
  (await page.locator("#mcp-command").count()) === 1,
);
await page.getByRole("combobox", { name: /Transport/ }).click();
await page.waitForTimeout(300);
await page.getByRole("option", { name: "Remote URL" }).click();
await page.waitForTimeout(400);
check(
  "…and swaps to a URL when remote, rather than showing both",
  (await page.locator("#mcp-url").count()) === 1 &&
    (await page.locator("#mcp-command").count()) === 0,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

/* OverrideControl: zero pills, revert only when there is something to revert. */
await nav("Sessions").click();
await page.waitForTimeout(400);
check(
  "no Inherit/Custom pills anywhere",
  (await page.getByRole("group", { name: /scope/i }).count()) === 0,
);
check(
  "an overridden row offers a revert naming the app-wide value",
  (await page
    .getByRole("button", { name: /Reset Model to the app-wide value, claude-opus-4\.6/ })
    .count()) === 1,
);
check(
  "an inheriting row offers no revert",
  (await page.getByRole("button", { name: /Reset Harness/ }).count()) === 0,
);
check(
  "the overridden row is marked for screen readers too",
  (await page.getByText("(overridden for this project)").count()) === 1,
);

/* §1.1 — precedence is published, now as a hint. */
const sessionHint = page.getByRole("button", { name: "About New sessions" });
await sessionHint.focus();
await page.waitForTimeout(300);
check(
  "§1.1 precedence is stated in the (i)",
  (await page.getByText(/own composer first, then this project/).count()) > 0,
);

/* Revert restores inheritance. */
await page.getByRole("button", { name: /Reset Model to the app-wide value/ }).click();
await page.waitForTimeout(400);
check(
  "revert clears the override",
  (await page.getByRole("button", { name: /Reset Model/ }).count()) === 0 &&
    (await page.getByText("(overridden for this project)").count()) === 0,
);

/* §2.6 — the .worktreeinclude trap stays gone. */
await nav("Worktrees").click();
await page.waitForTimeout(400);
check(
  "§2.6 copy set is read-only until explicitly created",
  (await page.locator("textarea").count()) === 0 &&
    (await page.getByRole("button", { name: /Create .worktreeinclude/ }).count()) === 1,
);
const base = page.locator("#base");
await base.fill("mian");
await base.blur();
await page.waitForTimeout(300);
check("§1.5 base branch refuses an unknown ref", (await page.locator("#base-error").count()) > 0);

check("no uncaught errors", thrown.length === 0, thrown.join("; "));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
