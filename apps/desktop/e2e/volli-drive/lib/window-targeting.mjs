/** Native-window targeting for acceptance drivers; sheets remain in their owning window. */
import assert from "node:assert/strict";
import { waitUntil } from "../../lib/smoke-kit.mjs";

const WINDOW_COMMANDS = new Set(["snapshot", "find", "act", "wait", "screenshot"]);

/**
 * Keep each snapshot/action/wait on the chosen page. Main is the supervisor's
 * bound workbench, not an index guessed from Electron's current window order.
 * Settings is discovered again by its entry URL whenever a flow enters it.
 */
export function windowTargeting(request) {
  let window = "main";
  return {
    call(command, args = {}) {
      if (command === "restart" || command === "native-reopen") window = "main";
      // Preserve the supervisor's default-main wire shape for existing callers.
      return request(
        command,
        WINDOW_COMMANDS.has(command) && window !== "main"
          ? { ...args, window: args.window ?? window }
          : args,
      );
    },
    useMainWindow() {
      window = "main";
    },
    async useSettingsWindow() {
      let settings;
      await waitUntil(
        "the native Settings renderer to open",
        async () => {
          const matches = (await request("windows")).filter((candidate) => {
            try {
              return new URL(candidate.url).hash === "#settings";
            } catch {
              return false;
            }
          });
          assert.ok(matches.length <= 1, "More than one native Settings renderer is open");
          settings = matches[0];
          return settings !== undefined;
        },
        { timeout: 30_000, interval: 100 },
      );
      window = settings.name;
      return settings;
    },
  };
}
