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
 * procedure reaches the router and comes back with its verdict, a lab-only one
 * is refused, and the Runtime Catalog settings section renders a real answer
 * instead of sitting on its checking copy forever.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/session-rpc-transport-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { createRunner, launch, makeScratch, waitUntil } from "./lib/smoke-kit.mjs";

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

    // Either answer proves the route: a view means the catalog resolved, a
    // coded failure means the router ran and refused. Only the allow-list's own
    // message would mean the request never got that far.
    await attempt(3, "the Runtime Catalog is routed over IPC", async () => {
      const reply = await page.evaluate(() =>
        window.api.sessionRpc.request({
          procedure: "runtimeCatalog.inspect",
          input: { adapterId: "opencode" },
        }),
      );
      return {
        ok: reply.ok === true || reply.error.message !== "Invalid Session RPC request",
        detail: JSON.stringify(reply).slice(0, 200),
      };
    });

    await attempt(4, "a lab-only procedure is refused", async () => {
      const reply = await page.evaluate(() =>
        window.api.sessionRpc.request({ procedure: "labDiagnostics.list", input: {} }),
      );
      return {
        ok: reply.ok === false && reply.error.message === "Invalid Session RPC request",
        detail: JSON.stringify(reply).slice(0, 200),
      };
    });

    await attempt(5, "Settings answers about OpenCode instead of checking forever", async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).first().click();
      await page.getByRole("button", { name: "Harness Runtimes", exact: true }).click();
      const settled = await waitUntil("the OpenCode section to settle", async () => {
        if ((await page.getByText("Checking the local runtime…").count()) > 0) return false;
        const unavailable = await page.getByText("OpenCode unavailable").count();
        const providers = await page
          .getByRole("button", { name: "Refresh OpenCode models" })
          .count();
        return providers > 0 ? { unavailable } : false;
      }).catch((error) => error);
      return {
        ok: !(settled instanceof Error),
        detail:
          settled instanceof Error
            ? settled.message
            : settled.unavailable > 0
              ? "reports the runtime unavailable, with its reason"
              : "lists providers",
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
summarize();
