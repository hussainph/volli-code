/**
 * Harness mode's shell recorder (VC-703).
 *
 * In a `volli-drive` instance a click on an external link, "Reveal in Finder"
 * or "Move to Trash" must not reach the owner's browser, Finder or Trash. In
 * harness mode Electron's `shell` methods that hand something to the OS are
 * replaced by recorders: each request is appended to
 * `<VOLLI_HARNESS_DIR>/external-requests.jsonl` (evidence a driver can assert
 * on) and nothing is opened, revealed or trashed. Every caller in main reaches
 * these through the `shell` object at call time (index.ts's window handlers,
 * client-capabilities.ts, ipc.ts, data-ipc.ts), so one replacement covers all
 * of them, including `window.open` and in-window navigation to external URLs,
 * which index.ts denies and forwards to `shell.openExternal`.
 *
 * Fail closed: a method that cannot be replaced refuses the boot.
 */
import { appendFileSync } from "node:fs";

/** Marks a recorder, so the live `shell` can be checked without calling it. */
export const HARNESS_RECORDER: unique symbol = Symbol.for("volli.harness.shellRecorder") as never;
/** Survives bundling, so volli-drive can tell a recording build before launch. */
export const HARNESS_RECORDER_MARKER = "volli-harness-shell-recorder:v1";
/** Where requests are appended, inside the harness directory. */
export const HARNESS_EXTERNAL_REQUESTS_FILE = "external-requests.jsonl";

/** What each recorder returns: the shape a caller of the real method expects. */
const RESULTS = {
  openExternal: () => Promise.resolve(),
  // `openPath` resolves to an error message, "" on success.
  openPath: () => Promise.resolve(""),
  showItemInFolder: () => undefined,
  trashItem: () => Promise.resolve(),
} as const;

export const RECORDED_SHELL_METHODS = Object.keys(RESULTS) as (keyof typeof RESULTS)[];

export function isRecorder(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[HARNESS_RECORDER] === true
  );
}

/** Replaces the OS-reaching `shell` methods. Throws when one did not take. */
export function installShellRecorder(
  shell: object,
  file: string,
  now: () => number = Date.now,
): string[] {
  const record = shell as Record<string, unknown>;
  const failed: string[] = [];
  for (const method of RECORDED_SHELL_METHODS) {
    const recorder = Object.assign(
      (...args: unknown[]): unknown => {
        try {
          appendFileSync(
            file,
            `${JSON.stringify({ method, args: args.filter((a) => typeof a === "string"), at: now() })}\n`,
          );
        } catch {
          // Evidence is best effort; opening nothing is not.
        }
        return RESULTS[method]();
      },
      { [HARNESS_RECORDER]: true },
    );
    try {
      Object.defineProperty(record, method, {
        value: recorder,
        writable: false,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Recorded below.
    }
    if (!isRecorder(record[method])) failed.push(method);
  }
  if (failed.length > 0) {
    throw new Error(
      `Harness mode could not record shell.${failed.join(", shell.")}; refusing to start.`,
    );
  }
  return [...RECORDED_SHELL_METHODS];
}
