/**
 * VC-344: built xterm terminal AX + keyboard regression, not DOM-text evidence.
 * Run after pnpm build:
 *   node apps/desktop/e2e/terminal-a11y-smoke.mjs evidence/vc344/fixed [--mac-ax]
 * --baseline records the same assertions without failing on known regressions.
 * --mac-ax queries THIS app's main PID through native AX (permission needed).
 * Never toggles VoiceOver or reads the user's profile/credentials. Scratch lives
 * under the evidence directory. Spoken VoiceOver wording remains a human check.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertBuiltRendererLoaded,
  launch,
  makeGitRepo,
  sleep,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";
import { seedProject } from "./lib/vc291-harness.mjs";

const args = process.argv.slice(2);
const baseline = args.includes("--baseline");
const macAx = args.includes("--mac-ax");
const evidence = resolve(args.find((x) => !x.startsWith("--")) ?? "evidence/vc344/fixed");
await fs.mkdir(evidence, { recursive: true });
const scratch = await fs.mkdtemp(join(evidence, "scratch-"));
const home = join(scratch, "home");
const tmp = join(scratch, "tmp");
await Promise.all([fs.mkdir(home), fs.mkdir(tmp)]);
const nativeProbe = join(scratch, "terminal-ax");
if (macAx) {
  execFileSync(
    "swiftc",
    [
      "-module-cache-path",
      join(scratch, "swift-cache"),
      resolve("apps/desktop/e2e/lib/terminal-ax.swift"),
      "-o",
      nativeProbe,
    ],
    { env: { ...process.env, HOME: home, TMPDIR: tmp } },
  );
}
const project = await makeGitRepo(scratch, "project-");
const marker = "VC344-OUTPUT-READABLE";
const seed = join(scratch, "seed-output.sh");
// Literal marker never occurs in typed input: only parsed PTY output can pass.
const octal = [...marker].map((c) => `\\${c.codePointAt(0).toString(8).padStart(3, "0")}`).join("");
await fs.writeFile(seed, `#!/bin/sh\nprintf '\\033[2J\\033[H\\033[1;36m${octal}\\033[0m\\n'\n`);
const record = {
  ticket: "VC-344",
  baseline,
  marker,
  startedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  os: execFileSync("sw_vers", [], { encoding: "utf8" }).trim(),
  checks: [],
};
function check(name, ok, detail = {}) {
  record.checks.push({ name, ok, ...detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} ${JSON.stringify(detail)}`);
}
const app = await launch({
  dbPath: join(scratch, "volli.db"),
  userDataDir: join(scratch, "profile"),
  extraEnv: {
    HOME: home,
    ZDOTDIR: home,
    TMPDIR: tmp,
    VOLLI_AGENT_HOME: home,
    // Native AX needs a normal window, not smoke-kit's accessory/offscreen one.
    VOLLI_QUIET_WINDOWS: macAx ? "0" : "1",
  },
});
let page;
try {
  await app.evaluate(({ app: electronApp }) => electronApp.setAccessibilitySupportEnabled(true));
  record.appPid = app.process().pid;
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await seedProject(page, { id: "vc344-project", name: "Terminal Accessibility", path: project });
  await startTerminalSession(page);
  const hosts = page.locator("[data-terminal-renderer]:visible");
  const host = hosts.first();
  await host.locator(".xterm-rows").waitFor();
  await sleep(1800);
  await host.click();
  await page.keyboard.type(`sh '${seed}'`);
  await page.keyboard.press("Enter");
  await waitUntil("seeded PTY output", async () =>
    (await host.locator(".xterm-rows").textContent()).includes(marker),
  );
  const ax = await page.context().newCDPSession(page);
  await ax.send("Accessibility.enable");
  const board = page.getByRole("tab", { name: "Board", exact: true });
  const terminalTab = page.getByRole("tab", { name: /^Terminal/ }).first();
  const active = () =>
    page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      name: document.activeElement?.getAttribute("aria-label"),
      inside: Boolean(document.activeElement?.closest("[data-terminal-renderer]")),
    }));

  async function macDump(label, expected) {
    try {
      const dump = execFileSync(nativeProbe, [String(record.appPid)], {
        encoding: "utf8",
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
      });
      await fs.writeFile(join(evidence, `mac-ax-${label}.json`), dump);
      const native = JSON.parse(dump);
      const chrome = native.nodes.some((node) =>
        /Home|Board|terminal focus/.test(`${node.AXTitle ?? ""} ${node.AXDescription ?? ""}`),
      );
      check(`mac-AX-${label}`, native.trusted && chrome && dump.includes(marker) === expected, {
        trusted: native.trusted,
        nodes: native.nodes.length,
        exposesChrome: chrome,
        containsMarker: dump.includes(marker),
      });
    } catch (error) {
      check(`mac-AX-${label}`, false, { unavailable: String(error.message) });
    }
  }

  async function capture(label, expected = true) {
    await sleep(1200); // xterm debounces accessible rows for up to one second.
    const tree = await ax.send("Accessibility.getFullAXTree");
    await fs.writeFile(join(evidence, `chromium-ax-${label}.json`), JSON.stringify(tree, null, 2));
    const exposed = tree.nodes.filter((node) => !node.ignored);
    const containsMarker = exposed.some((node) =>
      String(node.name?.value ?? node.value?.value ?? "").includes(marker),
    );
    check(`AX-${label}`, containsMarker === expected, {
      containsMarker,
      exposedNodes: exposed.length,
    });
    if (expected) {
      const semantics = await host.evaluate((element) => {
        const input = element.querySelector("textarea");
        return {
          role: element.getAttribute("role"),
          name: element.getAttribute("aria-label"),
          inputLabel: input?.getAttribute("aria-label"),
          inputLabelledBy: input?.getAttribute("aria-labelledby"),
          inputDescription: input?.getAttribute("aria-description"),
          tabIndex: input?.tabIndex,
          accessibleRows: element.querySelectorAll(".xterm-accessibility-tree [role=listitem]")
            .length,
        };
      });
      check(
        `input-name-${label}`,
        exposed.some(
          (node) => node.role?.value === "textbox" && node.name?.value === semantics.name,
        ),
        { expectedName: semantics.name },
      );
      check(
        `semantics-${label}`,
        semantics.role === "region" &&
          Boolean(semantics.name) &&
          semantics.accessibleRows > 0 &&
          semantics.inputDescription?.includes("Control+Shift+M"),
        semantics,
      );
    }
    if (macAx) await macDump(label, expected);
  }

  // Blur without switching the tab: terminal output must remain readable.
  await board.focus();
  check("before-focus-is-chrome", !(await active()).inside);
  await capture("before-focus");
  await host.click();
  await capture("after-focus");
  for (const key of ["Tab", "Shift+Tab"]) {
    await host.click();
    const walk = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(key);
      walk.push(await active());
    }
    check(
      `normal-${key}-stays-in-PTY`,
      walk.every((x) => x.inside),
      { walk },
    );
  }
  // Raw PTY capture: default Tab/Shift-Tab must send their bytes. Navigation
  // must send nothing; the final x terminates the five-byte read.
  await host.click();
  await page.keyboard.press("Control+c");
  const raw = join(scratch, "raw-byte");
  const ready = join(scratch, "raw-ready");
  await page.keyboard.type(
    `stty -echo -icanon; touch '${ready}'; dd bs=1 count=5 of='${raw}' 2>/dev/null; stty sane`,
  );
  await page.keyboard.press("Enter");
  await waitUntil("raw reader", () =>
    fs
      .stat(ready)
      .then(() => true)
      .catch(() => false),
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Control+Shift+M");
  await page.keyboard.press("Tab");
  check("navigation-Tab-exits", !(await active()).inside, await active());
  await page.keyboard.press("Shift+Tab");
  check("navigation-ShiftTab-reenters", (await active()).inside, await active());
  await host.locator("textarea").focus();
  await page.keyboard.press("Shift+Tab");
  check("navigation-ShiftTab-exits", !(await active()).inside, await active());
  await page.keyboard.press("Tab");
  check("navigation-Tab-reenters", (await active()).inside, await active());
  await host.locator("textarea").focus();
  await page.keyboard.press("Control+Shift+M");
  await page.keyboard.type("x");
  await waitUntil("raw byte received", () =>
    fs
      .readFile(raw)
      .then((b) => b.length >= 5)
      .catch(() => false),
  );
  const byte = await fs.readFile(raw);
  check("navigation-does-not-write-PTY", byte.toString("hex") === "091b5b5a78", {
    hex: byte.toString("hex"),
  });
  await page.keyboard.press("Control+c");

  await host.click();
  await page.keyboard.press("Alt+Meta+Enter");
  await capture("terminal-focus");
  await page.keyboard.press("Alt+Meta+Enter");
  await board.click();
  await capture("hidden", false);
  await terminalTab.click();
  await capture("hide-show");
  await host.click();
  await page.keyboard.press("Meta+d");
  await waitUntil("two visible terminals", async () => (await hosts.count()) === 2);
  await capture("split");
  const names = await hosts.evaluateAll((elements) =>
    elements.map((el) => el.getAttribute("aria-label")),
  );
  check("split-has-distinct-names", names.every(Boolean) && new Set(names).size === 2, { names });
  // Verify traversal and activation in BOTH split panes, not only the root.
  if (!baseline) {
    for (let i = 0; i < 2; i++) {
      const pane = hosts.nth(i);
      await pane.locator("textarea").focus();
      await page.keyboard.press("Control+Shift+M");
      for (const key of ["Tab", "Shift+Tab"]) {
        await pane.locator("textarea").focus();
        await page.keyboard.press(key);
        check(`split-${i}-${key}-exits`, !(await active()).inside, await active());
      }
      await pane.locator("textarea").focus();
      await page.keyboard.press("Control+Shift+M");
    }
  }
} catch (error) {
  record.fatal = String(error.stack ?? error);
  console.error(record.fatal);
} finally {
  await page?.screenshot({ path: join(evidence, "final.png") }).catch(() => {});
  await app.close();
  record.finishedAt = new Date().toISOString();
  await fs.writeFile(join(evidence, "record.json"), JSON.stringify(record, null, 2));
}
console.log(`evidence: ${evidence}`);
process.exitCode =
  record.fatal || (!baseline && record.checks.some((result) => !result.ok)) ? 1 : 0;
