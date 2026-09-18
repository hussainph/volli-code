/** VC-322 built-app observational release probe; artifacts stay in the workspace.
 * Run after pnpm build: node apps/desktop/e2e/vc322-accessibility-smoke.mjs
 * No provider calls, credentials, live profile, clipboard, or VoiceOver automation.
 */
import { promises as fs } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  launch,
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  seedProjects,
  makeGitRepo,
  startTerminalSession,
  closeAppBounded,
} from "./lib/smoke-kit.mjs";
const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "evidence/vc322",
);
const gateFixes = process.argv.includes("--gate-fixes");
await fs.mkdir(output, { recursive: true });
const scratch = await fs.mkdtemp(join(output, "run-"));
const userDataDir = join(scratch, "user-data");
await fs.mkdir(userDataDir);
const project = await makeGitRepo(scratch, "project-");
const app = await launch({
  dbPath: join(scratch, "volli.db"),
  userDataDir,
  extraEnv: { HOME: join(scratch, "home"), VOLLI_AGENT_HOME: join(scratch, "home") },
});
const page = await app.firstWindow();
page.setDefaultTimeout(8000);
const report = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--short"], { encoding: "utf8" }),
  checks: [],
  observations: [],
};
const active = () =>
  page.evaluate(() => {
    const e = document.activeElement,
      s = getComputedStyle(e);
    return {
      tag: e.tagName,
      role: e.getAttribute("role"),
      label: e.getAttribute("aria-label"),
      text: e.textContent?.slice(0, 100),
      placeholder: e.getAttribute("placeholder"),
      focusVisible: e.matches(":focus-visible"),
      outline: s.outline,
      boxShadow: s.boxShadow,
      border: s.border,
      background: s.backgroundColor,
      dialog: !!e.closest("[role=dialog]"),
    };
  });
async function check(name, fn) {
  try {
    const detail = await fn();
    report.checks.push({ name, ...detail });
    console.log(JSON.stringify(report.checks.at(-1)));
  } catch (e) {
    report.checks.push({ name, pass: false, error: e.message });
    console.log(name, e.message);
    await page.keyboard.press("Escape");
  }
}
async function tabTour(name, count = 45) {
  const steps = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    steps.push(await active());
  }
  report.observations.push({ name, steps });
}
try {
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await assertProfileIsolated(app, userDataDir);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
  );
  await seedProjects(page, [
    { id: "a11y-project", name: "Accessibility release", path: project, prefix: "AX" },
  ]);
  await page.evaluate(async () => {
    const b = await window.api.data.bootstrap();
    const p = b.data.projects[0];
    for (const [title, status] of [
      ["Keyboard ticket", "todo"],
      ["Second ticket", "doing"],
    ])
      await window.api.tickets.create({
        projectId: p.id,
        title,
        status,
        priority: "medium",
        description: "# Release body\n\nKeyboard and contrast fixture.",
      });
  });
  await page.reload();
  await page.getByRole("button", { name: "New ticket", exact: true }).waitFor();
  await page.screenshot({ path: join(output, "board.png") });
  await fs.writeFile(join(output, "board-ax.txt"), await page.locator("body").ariaSnapshot());
  await tabTour("board keyboard focus");
  await check("New ticket keyboard entry, trapped focus, Escape and focus return", async () => {
    const trigger = page.getByRole("button", { name: "New ticket", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    const entered = await active();
    const inside = [];
    for (let i = 0; i < 18; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(200);
      inside.push(await active());
    }
    report.observations.push({ name: "dialog tab path before Escape", inside });
    await page.getByPlaceholder("Ticket title").focus();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.waitForTimeout(250);
    const returned = await trigger.evaluate((e) => e === document.activeElement);
    return {
      pass: entered.dialog && inside.every((e) => e.dialog) && returned,
      entered,
      returned,
      after: await active(),
      inside,
    };
  });
  await check("Command palette Escape returns keyboard focus", async () => {
    const trigger = page.getByRole("button", { name: "New ticket", exact: true });
    await trigger.focus();
    await page.keyboard.press("Meta+K");
    await page.getByRole("dialog").waitFor();
    const entered = await active();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.waitForTimeout(250);
    const returned = await trigger.evaluate((e) => e === document.activeElement);
    return { pass: entered.dialog && returned, entered, returned, after: await active() };
  });
  await check("Board card Enter opens ticket; Escape returns to card", async () => {
    const card = page
      .locator('[data-board-ticket-slot] > [role="button"]')
      .filter({ hasText: "AX-1" })
      .first();
    await card.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("tablist", { name: "Ticket tabs" }).waitFor();
    const opened = await active();
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Board", exact: true }).waitFor();
    await page.waitForTimeout(250);
    return {
      pass: await card.evaluate((e) => e === document.activeElement),
      opened,
      after: await active(),
    };
  });
  await check("List row keyboard open and return", async () => {
    await page.getByRole("button", { name: "List view", exact: true }).click();
    await fs.writeFile(join(output, "list-ax.txt"), await page.locator("body").ariaSnapshot());
    const row = page.locator('[data-ticket-id="AX-1"]').first();
    await row.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("tablist", { name: "Ticket tabs" }).waitFor();
    await page.screenshot({ path: join(output, "ticket.png") });
    await fs.writeFile(join(output, "ticket-ax.txt"), await page.locator("body").ariaSnapshot());
    await page.locator('h1[role="button"]').focus();
    await page.waitForTimeout(200);
    report.observations.push({ name: "ticket title focus", state: await active() });
    await tabTour("ticket body comments and rail", 12);
    await page.keyboard.press("Control+Shift+M");
    await page.keyboard.press("Tab");
    report.observations.push({
      name: "Monaco Tab escape after Control+Shift+M",
      after: await active(),
    });
    await page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab").first().focus();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "List view", exact: true }).waitFor();
    await page.waitForTimeout(250);
    return { pass: await row.evaluate((e) => e === document.activeElement), after: await active() };
  });
  // Native theme is the app's source of truth in auto mode. No custom canvases.
  for (const mode of ["dark", "light"]) {
    await app.evaluate(({ nativeTheme }, m) => {
      nativeTheme.themeSource = m;
    }, mode);
    await page.waitForFunction((m) => document.documentElement.classList.contains(m), mode);
    await page.getByRole("button", { name: "New ticket", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement),
        names = [
          "background",
          "card",
          "popover",
          "foreground",
          "muted-foreground",
          "primary",
          "primary-foreground",
          "primary-text",
          "ring",
          "border",
          "destructive",
          "positive",
          "attention",
          "info",
        ];
      // Runs in the renderer, not the Node process that owns this probe.
      // eslint-disable-next-line unicorn/consistent-function-scoping
      const rgb = (value) => {
        const e = document.createElement("span");
        e.style.color = value;
        document.body.append(e);
        const c = getComputedStyle(e).color;
        e.remove();
        return c;
      };
      return Object.fromEntries(names.map((n) => [n, rgb(root.getPropertyValue("--" + n))]));
    });
    report.observations.push({ name: `${mode} default canvas tokens`, tokens });
    report.observations.push({
      name: `${mode} dialog controls`,
      controls: await page
        .getByRole("dialog")
        .locator("button,input,textarea")
        .evaluateAll((es) =>
          es.map((e) => {
            const s = getComputedStyle(e);
            return {
              text: e.textContent,
              label: e.getAttribute("aria-label"),
              color: s.color,
              background: s.backgroundColor,
              fontSize: s.fontSize,
              disabled: e.disabled,
            };
          }),
        ),
    });
    await page.screenshot({ path: join(output, `${mode}-dialog.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion });
    await page.getByRole("button", { name: "New ticket", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    report.observations.push({
      name: `motion ${reducedMotion}`,
      matches: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      animations: await page.evaluate(() =>
        document.getAnimations().map((a) => ({
          target: a.effect?.target?.outerHTML.slice(0, 250),
          timing: a.effect?.getTiming(),
          keyframes: a.effect?.getKeyframes(),
          state: a.playState,
        })),
      ),
      styles: await page.getByRole("dialog").evaluate((e) => {
        const s = getComputedStyle(e);
        return { animation: s.animation, transition: s.transition };
      }),
    });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  for (const zoom of [1.25, 1.5, 2]) {
    await app.evaluate(
      ({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z),
      zoom,
    );
    await page.getByRole("button", { name: "New ticket", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    const bounds = await page.getByRole("dialog").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        viewport: [innerWidth, innerHeight],
        scrollWidth: e.scrollWidth,
        clientWidth: e.clientWidth,
      };
    });
    await page.screenshot({ path: join(output, `zoom-${zoom}.png`) });
    report.checks.push({
      name: `BrowserWindow zoom ${zoom} dialog fits`,
      pass:
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= bounds.viewport[0] + 1 &&
        bounds.y + bounds.height <= bounds.viewport[1] + 1,
      bounds,
    });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  for (let step = 0; step < 5; step++) {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("volli:ui-zoom-command", "in"),
    );
    await page.waitForTimeout(250);
    const scale = await page.evaluate(
      async () =>
        JSON.parse((await window.api.data.bootstrap()).data.appState["volli:ui"]).state.uiScale,
    );
    if (step >= 1) {
      await page.screenshot({ path: join(output, `app-zoom-step-${step}.png`) });
      report.observations.push({ name: "native app zoom command", step, scale });
    }
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("volli:ui-zoom-command", "reset"),
  );
  await check("Terminal keyboard boundary", async () => {
    await startTerminalSession(page);
    const input = page.locator(".xterm-helper-textarea").last();
    await input.waitFor({ state: "attached" });
    await input.focus();
    await page.keyboard.type("printf 'VC322-TERMINAL-OUTPUT\\n'");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    const steps = [];
    for (const key of ["Tab", "Shift+Tab", "Escape", "Meta+Alt+Enter", "Meta+Alt+Enter"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(200);
      steps.push({ key, active: await active() });
    }
    // VC-344 deliberately preserves PTY Tab bytes by default. Test the
    // advertised focus-navigation mode, rather than calling raw Tab a trap.
    await input.focus();
    await page.keyboard.press("Control+Shift+M");
    const navigation = [];
    for (const key of ["Tab", "Shift+Tab"]) {
      await input.focus();
      await page.keyboard.press(key);
      await page.waitForTimeout(200);
      navigation.push({
        key,
        outsideTerminal: await page.evaluate(
          () => !document.activeElement?.closest("[data-terminal-renderer]"),
        ),
        active: await active(),
      });
    }
    const semantics = await page
      .locator("[data-terminal-renderer]")
      .last()
      .evaluate((e) => ({
        role: e.getAttribute("role"),
        label: e.getAttribute("aria-label"),
        tree: e.outerHTML.slice(0, 1200),
        screenReaderLayer: !!e.querySelector(".xterm-accessibility"),
      }));
    await fs.writeFile(join(output, "terminal-ax.txt"), await page.locator("body").ariaSnapshot());
    return {
      pass:
        navigation.every((step) => step.outsideTerminal) &&
        semantics.role === "region" &&
        Boolean(semantics.label) &&
        semantics.screenReaderLayer,
      steps,
      navigation,
      semantics,
    };
  });
} finally {
  await fs.writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await closeAppBounded(app);
}
// The broader release findings are observational and deliberately remain red.
// Only opt-in fix regression checks determine this probe's process exit code.
if (gateFixes) {
  const dialogs = report.checks.slice(0, 2);
  const title = report.observations.find((item) => item.name === "ticket title focus")?.state;
  if (
    dialogs.length !== 2 ||
    dialogs.some((item) => !item.pass) ||
    !title?.focusVisible ||
    !title.boxShadow.includes("2px")
  )
    process.exitCode = 1;
}
