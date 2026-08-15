/**
 * Verifies that the production renderer build contains utilities used only by
 * the chat's markdown surface. Tailwind otherwise drops them without an error
 * when the components live outside its automatic source root — which is every
 * one of them, because that root is `src/renderer` and these are not under it.
 *
 * `globals.css` buys them back with two `@source` directives, and this gate
 * exists to prove both still work. Every selector below was checked by deleting
 * the directive it is filed under and rebuilding: it has to actually vanish, or
 * it is decoration. That test is what the set is for. It removed `.bg-muted/80`
 * (emitted only by `ai-elements/code-block.tsx`, which nothing imports — a gate
 * standing on dead code proves the build kept dead code) and `.list-disc` /
 * `.size-full`, which Streamdown's own markup re-emits and which therefore
 * survived the ai-elements directive being pulled.
 *
 * Run after `vp build`, when `dist/assets/*.css` is the stylesheet Electron
 * will actually load.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS = resolve(import.meta.dirname, "../dist/assets");
/** Selector → the source it is emitted from, so a failure names what broke. */
const REQUIRED_SELECTORS = {
  // @source "../../components/ai-elements" — one per component the chat renders.
  ".list-outside": "ai-elements/chat-markdown.tsx",
  ".overflow-y-hidden": "ai-elements/conversation.tsx",
  ".max-w-\\[95\\%\\]": "ai-elements/message.tsx",
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
