/**
 * Smoke-only boot observation. Installed before main starts boot work, because
 * Playwright drains the child pipes before launch() returns to a smoke. This
 * seam is in main (not Electron's default-app-only -r loader) so packaged
 * launches observe the same real readiness/failure signals.
 */
import type { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Main's two boot lines (component `desktop`, VC-699), as the structured log's
 * terminal sink prints them: `[component] msg`. The capture turns that sink on
 * in any build (`startDesktopLog`'s `terminal`), so packaged launches print them too.
 */
export const WRAPPER_FAILURE_MESSAGE = "failed to generate harness wrappers";
export const WRAPPER_READY_MESSAGE = "harness runtime ready";
const WRAPPER_FAILURE_MARKER = `[desktop] ${WRAPPER_FAILURE_MESSAGE}`;
export const WRAPPER_READY_MARKER = `[desktop] ${WRAPPER_READY_MESSAGE}`;

type CaptureStream = Pick<NodeJS.WritableStream, "write">;
type WriteCallback = (error?: Error | null) => void;

interface CaptureInput {
  directory: string;
  app: Pick<EventEmitter, "once" | "off">;
  stdout: CaptureStream;
  stderr: CaptureStream;
  initialPath: string | undefined;
}

export function installBootCapture({
  directory,
  app,
  stdout,
  stderr,
  initialPath,
}: CaptureInput): () => void {
  writeFileSync(join(directory, "initial-path.txt"), initialPath ?? "");
  let windowCreated = false;
  const noteWindow = (): void => {
    windowCreated = true;
  };
  app.once("browser-window-created", noteWindow);
  const restore: (() => void)[] = [];
  for (const [name, stream] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ] as const) {
    const fullPath = join(directory, `${name}.log`);
    const postWindowPath = join(directory, `post-window-${name}.log`);
    writeFileSync(fullPath, "");
    writeFileSync(postWindowPath, "");
    const originalWrite = stream.write;
    stream.write = function (
      chunk: string | Uint8Array,
      ...args: [encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback]
    ): boolean {
      const encoding = typeof args[0] === "string" ? args[0] : undefined;
      appendFileSync(fullPath, chunk, encoding);
      if (windowCreated) appendFileSync(postWindowPath, chunk, encoding);
      return Reflect.apply(originalWrite, this, [chunk, ...args]) as boolean;
    };
    restore.push(() => {
      stream.write = originalWrite;
    });
  }
  return () => {
    app.off("browser-window-created", noteWindow);
    for (const restoreStream of restore) restoreStream();
  };
}

/** Whether this launch is a smoke's captured boot, whose log lines must reach the terminal. */
export function isSmokeBootCapture(environment: NodeJS.ProcessEnv): boolean {
  return environment["VOLLI_BARE_PATH_CAPTURE_DIR"] !== undefined;
}

/** Unset in ordinary launches: no stream patching or filesystem work at all. */
export function installSmokeBootCapture(
  environment: NodeJS.ProcessEnv,
  app: CaptureInput["app"],
  stdout: CaptureStream,
  stderr: CaptureStream,
): void {
  const directory = environment["VOLLI_BARE_PATH_CAPTURE_DIR"];
  if (directory === undefined) return;
  installBootCapture({ directory, app, stdout, stderr, initialPath: environment["PATH"] });
}

export interface BootCapture {
  initialPath: string;
  stdout: string;
  stderr: string;
  postWindowStdout: string;
  postWindowStderr: string;
}

export function readBootCapture(directory: string): BootCapture {
  return {
    initialPath: readFileSync(join(directory, "initial-path.txt"), "utf8"),
    stdout: readFileSync(join(directory, "stdout.log"), "utf8"),
    stderr: readFileSync(join(directory, "stderr.log"), "utf8"),
    postWindowStdout: readFileSync(join(directory, "post-window-stdout.log"), "utf8"),
    postWindowStderr: readFileSync(join(directory, "post-window-stderr.log"), "utf8"),
  };
}

export function wrapperGenerationOutcome({
  stdout,
  stderr,
}: Pick<BootCapture, "stdout" | "stderr">):
  | { kind: "failed"; offending: string }
  | { kind: "ready" }
  | null {
  const offending = stderr.split("\n").find((line) => line.includes(WRAPPER_FAILURE_MARKER));
  if (offending !== undefined) return { kind: "failed", offending };
  return `${stdout}\n${stderr}`.includes(WRAPPER_READY_MARKER) ? { kind: "ready" } : null;
}
