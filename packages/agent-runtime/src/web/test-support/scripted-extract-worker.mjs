// A stand-in extraction worker whose behaviour the URL scripts, so a test can
// drive every way a worker answers, hangs, fails or dies without needing a
// hostile document that happens to do it. Every answer names this thread, which
// is how a test tells a reused worker from a fresh one. The empty transfer
// lists are Node's second argument, not a browser target origin. Test support only.
import { parentPort, threadId } from "node:worker_threads";

parentPort.on("message", ({ url }) => {
  const document = { text: String(threadId), extracted: false, truncated: false };
  switch (new URL(url).pathname) {
    case "/hang":
      // Synchronous, like a real parse: only terminating the thread ends it.
      for (;;);
    case "/fail":
      parentPort.postMessage({ type: "failed" }, []);
      return;
    case "/exit":
      process.exit(3);
    case "/crash":
      throw new Error("an uncaught failure inside the worker");
    case "/die-later":
      parentPort.postMessage({ type: "done", document }, []);
      setTimeout(() => process.exit(0), 10);
      return;
    default:
      parentPort.postMessage({ type: "done", document }, []);
  }
});
