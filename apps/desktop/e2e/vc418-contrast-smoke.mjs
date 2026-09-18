#!/usr/bin/env node
/** Built default-canvas controls: node apps/desktop/e2e/vc418-contrast-smoke.mjs [--baseline]. */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  REPO,
  makeGitRepo,
  makeScratch,
  launch,
  assertProfileIsolated,
  assertBuiltRendererLoaded,
  seedProjects,
  waitUntil,
  closeAppBounded,
} from "./lib/smoke-kit.mjs";

const baseline = process.argv.includes("--baseline");
const parent = join(REPO, "evidence", "vc418");
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(join(parent, baseline ? "baseline-" : "post-"));
process.env.VOLLI_SMOKE_DIR = join(root, "profile");
const { scratch, userDataDir, dbPath } = await makeScratch("vc418-");
const home = join(scratch, "home");
await fs.mkdir(home, { recursive: true });
const projectPath = await makeGitRepo(scratch, "canvas-project-");
const result = {
  ticket: "VC-418",
  baseline,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(),
  evidence: root,
  modes: [],
};
let app;
const linear = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const luminance = (c) => {
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
};
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
try {
  app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, "pi"),
      VOLLI_AGENT_HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  });
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await waitUntil("bootstrap bridge", () => page.evaluate(() => !!window.api?.data?.bootstrap));
  await seedProjects(page, [
    { id: "vc418", name: "VC418 Canvas", path: projectPath, prefix: "VC" },
  ]);
  const button = page.getByRole("button", { name: "New ticket", exact: true });
  await button.waitFor({ state: "visible" });
  if (!(await button.isEnabled())) throw new Error("New ticket must be enabled");

  const read = () =>
    button.evaluate((b) => {
      const cs = getComputedStyle(b);
      // Chromium parses all emitted CSS color syntaxes (including oklab color-mix).
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const parse = (value) => {
        if (!CSS.supports("color", value)) throw new Error(`Not a color: ${value}`);
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data, (n) => n / 255);
      };
      // Playwright serializes this callback: helpers must stay inside the browser realm.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
      // Find an opaque ancestor, then composite inward in paint order. Reject
      // an intervening gradient rather than silently treating it as solid paper.
      const layers = [];
      for (let node = b.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none")
          throw new Error("Unsupported gradient behind control");
        const color = parse(style.backgroundColor);
        layers.push(color);
        if (color[3] === 1) break;
      }
      if (layers.at(-1)?.[3] !== 1) throw new Error("No opaque surface behind control");
      const surface = layers.toReversed().reduce((bg, fg) => over(fg, bg), [0, 0, 0, 1]);
      const fill = over(parse(cs.backgroundColor), surface);
      const foreground = over(parse(cs.color), fill);
      const ringCss = cs.getPropertyValue("--tw-ring-color").trim();
      const ring = ringCss ? over(parse(ringCss), surface) : null;
      const offsetCss = cs.getPropertyValue("--tw-ring-offset-color").trim();
      return {
        fill,
        foreground,
        surface,
        ring,
        offset: offsetCss ? parse(offsetCss) : null,
        css: {
          fill: cs.backgroundColor,
          foreground: cs.color,
          ring: ringCss,
          boxShadow: cs.boxShadow,
          ringShadow: cs.getPropertyValue("--tw-ring-shadow"),
          offsetWidth: cs.getPropertyValue("--tw-ring-offset-width"),
          fontSize: cs.fontSize,
        },
        focusVisible: b.matches(":focus-visible"),
        hovered: b.matches(":hover"),
        opacity: cs.opacity,
      };
    });

  for (const mode of ["light", "dark"]) {
    // Persist through the same API as Settings, then reload to hydrate the store.
    await page.evaluate(async (appearance) => {
      const response = await window.api.theme.setGlobalAppearance(appearance);
      if (!response.ok) throw new Error(response.error);
    }, mode);
    await page.reload();
    await button.waitFor({ state: "visible" });
    await waitUntil(`${mode} theme`, () =>
      page.evaluate((m) => document.documentElement.classList.contains(m), mode),
    );
    await page.mouse.move(0, 0);
    await button.evaluate((b) => b.blur());
    await page.waitForTimeout(250); // settle the declared 150ms CSS transition
    const rest = await read();
    await button.hover();
    await page.waitForTimeout(250);
    const hover = await read();
    if (!hover.hovered) throw new Error("Hover did not land on the control");
    await page.mouse.move(0, 0);
    await button.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(250);
    const focus = await read();
    const checks = {
      textRest: contrast(rest.foreground, rest.fill),
      textHover: contrast(hover.foreground, hover.fill),
      ring: focus.ring ? contrast(focus.ring, focus.surface) : 0,
      ringOffset:
        focus.ring && focus.offset && parseFloat(focus.css.offsetWidth) > 0
          ? contrast(focus.ring, focus.offset)
          : null,
      visibleFocus:
        focus.focusVisible &&
        focus.opacity === "1" &&
        focus.css.boxShadow.includes("2px") &&
        focus.css.ringShadow.includes("2px"),
    };
    checks.pass =
      checks.textRest >= 4.5 &&
      checks.textHover >= 4.5 &&
      checks.ring >= 3 &&
      (checks.ringOffset === null || checks.ringOffset >= 3) &&
      checks.visibleFocus;
    await page.screenshot({ path: join(root, `${mode}-focus.png`) });
    result.modes.push({ mode, rest, hover, focus, checks });
  }
  result.ok = result.modes.every((mode) => mode.checks.pass);
  if (!result.ok && !baseline) process.exitCode = 1;
} catch (error) {
  result.ok = false;
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(join(root, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (app) await closeAppBounded(app);
}
