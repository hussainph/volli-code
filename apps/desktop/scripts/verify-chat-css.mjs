/**
 * Verifies that the production renderer build contains utilities used only by
 * the chat's markdown surface. Tailwind drops a class it cannot find in a
 * scanned source, and it does so without an error — the failure is a component
 * that renders unstyled, not a build that stops.
 *
 * TWO DIFFERENT REACHES ARE UNDER TEST HERE, which is why the entries are filed
 * by source rather than listed flat. The chat primitives now live at
 * `renderer/src/components/ui/ai-elements/`, INSIDE the automatic source root
 * `globals.css` establishes from its own directory — they used to sit at
 * `src/components/ai-elements/` and needed an `@source` of their own, and these
 * entries are what proves the automatic scan really replaced it rather than
 * appearing to. Streamdown's own markup is still bought back explicitly,
 * because `node_modules` is never scanned automatically.
 *
 * Every selector below was checked by removing the reach it is filed under and
 * rebuilding: it has to actually vanish, or it is decoration. That test is what
 * the set is for. It removed `.bg-muted/80` (emitted only by
 * `ai-elements/code-block.tsx`, which nothing imported — a gate standing on
 * dead code proves the build kept dead code) and `.list-disc` / `.size-full`,
 * which Streamdown's own markup re-emits and which therefore survived the
 * ai-elements source being pulled.
 *
 * Run after `vp build`, when `dist/assets/*.css` is the stylesheet Electron
 * will actually load.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS = resolve(import.meta.dirname, "../dist/assets");
/** Selector → the source it is emitted from, so a failure names what broke. */
const REQUIRED_SELECTORS = {
  // Tailwind's automatic scan under globals.css — one per component the chat
  // renders.
  ".list-outside": "ui/ai-elements/chat-markdown.tsx",
  ".overflow-y-hidden": "ui/ai-elements/conversation.tsx",
  ".max-w-\\[95\\%\\]": "ui/ai-elements/message.tsx",
  // The composer footer's 8px lid, and the one entry here whose absence is
  // INVISIBLE rather than broken: without it the addon's own `[.border-t]:pt-4`
  // wins on specificity and the control band silently doubles its top padding,
  // which reads as a slightly roomy composer rather than as a missing
  // stylesheet. Checked the way the rest were — commenting the directive out
  // makes it vanish from `dist/assets/*.css`.
  ".\\[\\.border-t\\]\\:pt-2": "ai-elements/prompt-input.tsx",
  // @source "../../../node_modules/streamdown/dist/*.js" — nothing this app
  // owns emits `wrap-anywhere`, so its absence means that directive stopped
  // reaching Streamdown's own markup.
  ".wrap-anywhere": "streamdown/dist",
};

const stylesheets = readdirSync(ASSETS)
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(resolve(ASSETS, name), "utf8"));

const builtCss = stylesheets.join("\n");
const absent = Object.entries(REQUIRED_SELECTORS)
  .filter(([selector]) => !builtCss.includes(selector))
  .map(([selector, source]) => `${selector} (${source})`);

if (absent.length > 0) {
  throw new Error(`Chat Tailwind utilities missing from production CSS: ${absent.join(", ")}`);
}
