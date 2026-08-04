/**
 * Verifies that the production renderer build contains utilities used only by
 * the chat's shared markdown components. Tailwind otherwise drops them without
 * an error when the components live outside its automatic source root.
 *
 * Run after `vp build`, when `dist/assets/*.css` is the stylesheet Electron
 * will actually load.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS = resolve(import.meta.dirname, "../dist/assets");
const REQUIRED_SELECTORS = [
  ".list-disc",
  ".list-outside",
  ".size-full",
  ".overflow-y-hidden",
  ".bg-muted\\/80",
];

const stylesheets = readdirSync(ASSETS)
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(resolve(ASSETS, name), "utf8"));

const builtCss = stylesheets.join("\n");
const absent = REQUIRED_SELECTORS.filter((selector) => !builtCss.includes(selector));

if (absent.length > 0) {
  throw new Error(`Chat Tailwind utilities missing from production CSS: ${absent.join(", ")}`);
}
