/**
 * Smoke-only main preload: persist output BEFORE the app entry runs. Playwright
 * drains the child's pipes during launch(), so listeners installed on the
 * returned process cannot recover a readiness (or failure) line already read.
 * This observes boot only: no PATH mutation, generated files or synthetic ready.
 */
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const WRAPPER_FAILURE_MARKER = "[volli] failed to generate harness wrappers";
const WRAPPER_READY_MARKER = "[volli] harness runtime ready";

function installBootCapture({ directory, app, stdout, stderr, initialPath }) {
  writeFileSync(join(directory, "initial-path.txt"), initialPath ?? "");
  let windowCreated = false;
  app.once("browser-window-created", () => {
    windowCreated = true;
  });
  const restore = [];
  for (const [name, stream] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    const fullPath = join(directory, `${name}.log`);
    const postWindowPath = join(directory, `post-window-${name}.log`);
    writeFileSync(fullPath, "");
    writeFileSync(postWindowPath, "");
    const originalWrite = stream.write;
    stream.write = function (chunk, ...args) {
      const encoding = typeof args[0] === "string" ? args[0] : undefined;
      appendFileSync(fullPath, chunk, encoding);
      if (windowCreated) appendFileSync(postWindowPath, chunk, encoding);
      return originalWrite.call(this, chunk, ...args);
    };
    restore.push(() => {
      stream.write = originalWrite;
    });
  }
  return () => {
    for (const restoreStream of restore) restoreStream();
  };
}

function readBootCapture(directory) {
  return {
    initialPath: readFileSync(join(directory, "initial-path.txt"), "utf8"),
    stdout: readFileSync(join(directory, "stdout.log"), "utf8"),
    stderr: readFileSync(join(directory, "stderr.log"), "utf8"),
    postWindowStdout: readFileSync(join(directory, "post-window-stdout.log"), "utf8"),
    postWindowStderr: readFileSync(join(directory, "post-window-stderr.log"), "utf8"),
  };
}

function wrapperGenerationOutcome({ stdout, stderr }) {
  const offending = stderr.split("\n").find((line) => line.includes(WRAPPER_FAILURE_MARKER));
  if (offending !== undefined) return { kind: "failed", offending };
  return `${stdout}\n${stderr}`.includes(WRAPPER_READY_MARKER) ? { kind: "ready" } : null;
}

module.exports = {
  installBootCapture,
  readBootCapture,
  wrapperGenerationOutcome,
  WRAPPER_READY_MARKER,
};

if (process.env.VOLLI_BARE_PATH_CAPTURE_DIR !== undefined) {
  installBootCapture({
    directory: process.env.VOLLI_BARE_PATH_CAPTURE_DIR,
    app: require("electron").app,
    stdout: process.stdout,
    stderr: process.stderr,
    initialPath: process.env.PATH,
  });
}
