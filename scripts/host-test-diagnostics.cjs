// Test-only Node preload. Observe the fork from its parent as well as the
// nested worker threads: a fatal V8 CHECK cannot run a JS exit hook.
// No monkey-patching, error handlers that consume failures, timers or signals.
const { channel } = require("node:diagnostics_channel");
const { errorMonitor } = require("node:events");
const { appendFileSync, mkdirSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { isMainThread, threadId } = require("node:worker_threads");

const directory = process.env.VOLLI_HOST_TEST_DIAGNOSTICS;
if (directory && process.cwd() === resolve(__dirname, "../packages/host-core")) {
  install(resolve(directory));
}

function install(root) {
  mkdirSync(root, { recursive: true });
  const output = join(root, `events-${process.pid}-${threadId}.jsonl`);
  const active = new Map();
  // Keep real measurements even in suites that stub clocks or memory APIs.
  const now = Date.now.bind(Date);
  const memoryUsage = process.memoryUsage.bind(process);
  const availableMemory = process.availableMemory.bind(process);
  // Do not enable full Node reports: even excludeEnv/excludeNetwork leave
  // commandLine and other non-allowlisted metadata. CI retains native stderr
  // instead. Never collect argv, environment, workerData, heap dumps or cores.
  const testEvents = new Set([
    "test-start",
    "test-finished",
    "restore-crash-checkpoint",
    "restore-crash-terminate",
    "restore-crash-terminated",
    "restore-crash-cleanup",
    "restore-cancel-request",
  ]);
  const errorFields = (error) => ({
    errorCode:
      typeof error?.code === "string" && /^(?:ERR_[A-Z_]+|E[A-Z0-9]+)$/u.test(error.code)
        ? error.code
        : undefined,
    errorName: ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(
      error?.name,
    )
      ? error.name
      : undefined,
  });

  function record(event, fields = {}) {
    try {
      appendFileSync(
        output,
        `${JSON.stringify({
          at: now(),
          pid: process.pid,
          ppid: process.ppid,
          threadId,
          event,
          active: [...active.values()],
          memory: (() => {
            const { rss, heapTotal, heapUsed, external, arrayBuffers } = memoryUsage();
            return { rss, heapTotal, heapUsed, external, arrayBuffers };
          })(),
          availableMemory: availableMemory(),
          ...fields,
        })}\n`,
      );
    } catch (error) {
      // An observer must neither mask the original failure nor create one.
      process.stderr.write(`[host-test-diagnostics] write failed: ${error.code ?? "unknown"}\n`);
    }
  }

  function cgroup() {
    const result = {};
    for (const name of ["memory.current", "memory.peak", "memory.max", "memory.events"]) {
      try {
        result[name] = readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim();
      } catch (error) {
        result[name] = { unavailable: error.code };
      }
    }
    return result;
  }

  record("process-start", {
    isMainThread,
    versions: {
      node: process.versions.node,
      v8: process.versions.v8,
      uv: process.versions.uv,
      modules: process.versions.modules,
      napi: process.versions.napi,
    },
    platform: process.platform,
    arch: process.arch,
    cgroup: cgroup(),
  });
  channel("volli.host-core.test").subscribe((message) => {
    if (!message || !testEvents.has(message.event)) return;
    const text = (value) => (typeof value === "string" ? value.slice(0, 1024) : undefined);
    const event = message.event;
    const id = text(message.id);
    const file = text(message.file);
    const name = text(message.name);
    const workerThreadId = Number.isInteger(message.workerThreadId)
      ? message.workerThreadId
      : undefined;
    if (event === "test-start") active.set(id, { id, file, name });
    record(event, { id, file, name, workerThreadId });
    if (event === "test-finished") active.delete(id);
  });
  channel("child_process").subscribe(({ process: child }) => {
    let pid;
    child.once("spawn", () => {
      pid = child.pid;
      record("child-start", { childPid: pid });
    });
    child.on(errorMonitor, (error) => {
      record("child-error", { childPid: pid, ...errorFields(error) });
    });
    child.once("exit", (code, signal) => {
      record("child-exit", { childPid: pid, code, signal, killed: child.killed });
    });
  });
  channel("worker_threads").subscribe(({ worker }) => {
    const workerThreadId = worker.threadId;
    record("worker-start", { workerThreadId, resourceLimits: worker.resourceLimits });
    worker.once("online", () => record("worker-online", { workerThreadId }));
    worker.on(errorMonitor, (error) => {
      record("worker-error", { workerThreadId, ...errorFields(error) });
    });
    worker.once("exit", (code) => record("worker-exit", { workerThreadId, code }));
  });
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    record("uncaught-exception", { origin, ...errorFields(error) });
  });
  process.once("exit", (code) => record("process-exit", { code, cgroup: cgroup() }));
}
