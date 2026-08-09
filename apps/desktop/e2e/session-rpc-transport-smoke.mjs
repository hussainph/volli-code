/**
 * E2e probe: the renderer's Session RPC transport, end to end.
 *
 * Every unit test on either side of this edge mocks the other one — the link's
 * tests hand it a fake `window.api`, the bridge's tests hand it a fake
 * `ipcMain`. Neither can see the seam they meet at: a channel declared in the
 * contract but never handled, a preload door that never reached
 * `contextBridge`, a procedure the allow-list spells differently from the
 * router. All of those pass both suites and fail on launch.
 *
 * So this asserts the chain from inside the real app: the door exists, a routed
 * procedure reaches the router and comes back with its verdict, and a lab-only
 * one is refused. Those three are the whole point — the allow-list, the preload
 * door, and the router agreeing on every name they share.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/session-rpc-transport-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { createRunner, launch, makeScratch } from "./lib/smoke-kit.mjs";

const { userDataDir, dbPath, cleanup } = await makeScratch("session-rpc-");
const { attempt, summarize } = createRunner();

async function main() {
  const app = await launch({ dbPath, userDataDir });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await attempt(1, "the preload exposes the Session RPC door", async () => {
      const shape = await page.evaluate(() => {
        const door = window.api?.sessionRpc;
        return door === undefined
          ? null
          : Object.fromEntries(
              ["request", "onEvent", "cancel"].map((name) => [name, typeof door[name]]),
            );
      });
      const wrong = Object.entries(shape ?? {}).filter(([, kind]) => kind !== "function");
      return {
        ok: shape !== null && wrong.length === 0,
        detail: shape === null ? "window.api.sessionRpc is missing" : JSON.stringify(shape),
      };
    });

    // A real procedure handed input it will reject: what matters is that the
    // request REACHED the router and came back as the router's verdict, not
    // that some channel answered.
    await attempt(2, "a routed procedure reaches the router and answers", async () => {
      const reply = await page.evaluate(() =>
        window.api.sessionRpc.request({ procedure: "session.snapshot", input: { sessionId: "" } }),
      );
      return {
        ok: reply.ok === false && reply.error.code === "BAD_REQUEST",
        detail: JSON.stringify(reply).slice(0, 200),
      };
    });

    await attempt(3, "a lab-only procedure is refused", async () => {
      const reply = await page.evaluate(() =>
        window.api.sessionRpc.request({ procedure: "labDiagnostics.list", input: {} }),
      );
      return {
        ok: reply.ok === false && reply.error.message === "Invalid Session RPC request",
        detail: JSON.stringify(reply).slice(0, 200),
      };
    });
  } finally {
    await app.close().catch(() => {});
  }
}

try {
  await main();
} finally {
  await cleanup().catch(() => {});
}
// `summarize()` RETURNS the exit code (see `createRunner` in lib/smoke-kit.mjs:
// "the roll-up line + process exit code"), and dropping it is not a style slip.
// An abort still fails, because the throw escapes the `try` above — but a
// recorded FAIL only prints, so the process exits 0 and CI's
// `node … || failures=$((failures + 1))` counts a pass. That silences precisely
// what this probe exists to catch: a channel declared but never handled, a
// preload door that never reached `contextBridge`, an allow-list spelling a
// procedure differently from the router. Every other smoke here ends on
// `process.exit(code)` for the same reason.
process.exit(summarize());
