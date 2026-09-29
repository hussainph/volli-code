/**
 * Boot recovery must run AFTER the Browser host reference is assigned, and
 * BEFORE anything reads the ledger (VC-367).
 *
 * Those two are one invariant with two ends, and it lives in the boot sequence
 * of `main/index.ts` rather than in any function, which is why this is a source
 * scan rather than a unit test. `index.ts` is the Electron main entry: it
 * composes the whole app inside `app.whenReady()`, so there is nothing to call
 * and no seam to inject at without inverting the boot sequence itself.
 *
 * **What it caught.** `closeStaleAttachments` reconciles every Session whose
 * turn was live when the prior process died, and reconciling rehydrates the
 * structured attachment — which resolves the Session's tool surface, which
 * reaches `resolveBrowserPort`, which reads `browserTabsRef`. The host was
 * built several hundred lines further down, so that read found `null` and threw
 * "The Browser host is not ready; retry the attachment." on every pass. The
 * reconcile path could not succeed at boot: not sometimes, not under load —
 * structurally, on every crash, for every Session with a live turn. Recovery
 * then recorded `adapter_unrecoverable` and force-closed the attachment, which
 * is correct handling of a failure that should never have happened, and is also
 * why the bug read as "my Sessions are dead" rather than as a broken app and
 * survived this long.
 *
 * **Why the host moved up rather than recovery moving down.** The module header
 * of `boot-recovery.ts` states the other half: recovery runs before anything
 * reads the ledger. Moving the sweep below the host would have put it after
 * every IPC handler registration in the file, leaving that invariant resting on
 * none of those hundreds of lines ever growing a read. Moving the host up costs
 * nothing — `BrowserTabHost`'s constructor only stores its dependencies — and
 * keeps the sweep where its own contract requires.
 *
 * A source scan cannot prove the app boots. It proves the one ordering fact
 * that was wrong, names it, and fails in the suite a person actually runs if it
 * is ever reversed. The behaviour behind it — a recovery attach failing without
 * the host and succeeding with it — is covered in `pi-adapter.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const MAIN_INDEX = fileURLToPath(new URL("../index.ts", import.meta.url));

/** The boot sequence's own text, with comments stripped so prose cannot match. */
function bootSource(): string {
  return readFileSync(MAIN_INDEX, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Where a statement first appears, or `-1`. Asserted on, never assumed. */
function positionOf(source: string, needle: string): number {
  return source.indexOf(needle);
}

describe("the boot order recovery depends on", () => {
  const source = bootSource();
  const hostAssigned = positionOf(source, "browserTabsRef = browserTabs");
  const recoverySweep = positionOf(source, "await closeStaleAttachments({");

  it("still has both statements this rule is about", () => {
    // A rename that silently stopped this file from checking anything is the
    // one failure mode a source scan has, so it is asserted rather than
    // assumed: -1 here means the guard, not the boot order, needs updating.
    expect(hostAssigned).toBeGreaterThan(-1);
    expect(recoverySweep).toBeGreaterThan(-1);
  });

  it("assigns the Browser host before boot recovery reconciles anything", () => {
    expect(hostAssigned).toBeLessThan(recoverySweep);
  });

  it("keeps the guard that force-closes an attachment recovery could not rehydrate", () => {
    // The ordering fix must not be mistaken for a reason to drop the fallback:
    // it is what keeps a failed recovery from projecting as a live Session, and
    // it is the reason this bug degraded instead of corrupting.
    const recovery = readFileSync(
      fileURLToPath(new URL("./boot-recovery.ts", import.meta.url)),
      "utf8",
    );
    expect(recovery).toContain("options.onError(attachment.id, error)");
    expect(recovery).toContain("tryRaiseCrashRecoveryAttention");
  });
});
