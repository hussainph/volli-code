/**
 * The Chromium backend against a real Chrome for Testing (VC-619): the shared
 * browser tool suite, then what only this engine has — browser contexts per
 * scope, denied permissions, the page-navigation guard and dialogs. Skips without a browser unless
 * `VOLLI_REQUIRE_CHROMIUM=1` (CI's "Test (packages)" lane) makes that a failure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { browserAgentPort } from "./agent-port";
import { ChromiumBrowserBackend } from "./chromium-backend";
import {
  describeBrowserBackendSuite,
  eventually,
  refNamed,
  suitePorts,
} from "./test-support/backend-suite";
import { testChromium } from "./test-support/chromium";
import { startBrowserFixture, type BrowserFixture } from "./test-support/fixture-server";

const chromium = testChromium();
const profileRoot = mkdtempSync(join(tmpdir(), "volli-chromium-test-"));

function chromiumBackend(): ChromiumBrowserBackend {
  return new ChromiumBrowserBackend(suitePorts(), {
    executablePath: chromium!.executablePath,
    profileRoot,
    noSandbox: chromium!.noSandbox,
  });
}

describeBrowserBackendSuite(
  "Chromium over a CDP pipe",
  chromium === null
    ? null
    : async (ports) => {
        const backend = new ChromiumBrowserBackend(ports, {
          executablePath: chromium.executablePath,
          profileRoot,
          noSandbox: chromium.noSandbox,
        });
        return { backend, dispose: () => backend.dispose() };
      },
);

const PROJECT = "chromium-project";
const signal = (): AbortSignal => new AbortController().signal;

describe.skipIf(chromium === null)("ChromiumBrowserBackend's engine facts", () => {
  let fixture: BrowserFixture;
  let backend: ChromiumBrowserBackend;

  beforeAll(async () => {
    fixture = await startBrowserFixture();
    backend = chromiumBackend();
  });

  afterAll(async () => {
    await backend?.dispose();
    await fixture?.close();
    rmSync(profileRoot, { recursive: true, force: true });
  }, 30_000);

  const port = (sessionId: string, ticketId: string | null) =>
    browserAgentPort({
      backend,
      scope: { projectId: PROJECT, ticketId },
      session: { sessionId, attachmentId: `${sessionId}-a` },
      cursorFor: () => undefined,
    });

  it("keeps cookies inside one Ticket's context", async () => {
    const first = port("ticket-one-a", "T-1");
    const sibling = port("ticket-one-b", "T-1");
    const other = port("ticket-two", "T-2");
    await first.navigate({
      navigation: { kind: "url", url: fixture.url("/cookie-set") },
      signal: signal(),
    });
    const same = await sibling.navigate({
      navigation: { kind: "url", url: fixture.url("/cookie-read") },
      signal: signal(),
    });
    const elsewhere = await other.navigate({
      navigation: { kind: "url", url: fixture.url("/cookie-read") },
      signal: signal(),
    });
    expect(same.title).toBe("cookie:volli_fixture=present");
    expect(elsewhere.title).toBe("cookie:none");
    for (const each of [first, sibling, other]) each.dispose();
  });

  it("denies permissions", async () => {
    const asker = port("permission", null);
    const nav = await asker.navigate({
      navigation: { kind: "url", url: fixture.url("/permission") },
      signal: signal(),
    });
    const settled = await eventually(
      () => asker.snapshot({ tabId: nav.tabId, signal: signal() }),
      (snap) => snap.title.startsWith("geolocation:"),
    );
    expect(settled.title).toBe("geolocation:denied");
    asker.dispose();
  });

  const BLOCKED = "Blocked a page navigation to a non-HTTP(S) address";

  it("refuses a main frame's own blob: navigation before it commits", async () => {
    const driver = port("blob", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/blob") },
      signal: signal(),
    });
    await driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "click",
      ref: refNamed(nav.snapshotText, "Go to blob"),
      signal: signal(),
    });
    const record = await eventually(
      () => driver.console({ tabId: nav.tabId, signal: signal() }),
      (read) => read.messages.some((message) => message.text === BLOCKED),
    );
    expect(record.messages.map((message) => message.text)).toContain(BLOCKED);
    // Refused before commit, the page stays where it was, as desktop's
    // `will-navigate` keeps it; the commit check is only the backstop.
    const settled = await eventually(
      async () => backend.list({ projectId: PROJECT }).find((tab) => tab.tabId === nav.tabId)!,
      (tab) => !tab.loading,
    );
    expect(settled.url).toBe(fixture.url("/blob"));
    expect(settled.title).toBe("Blob opener");
    driver.dispose();
  });

  it("refuses an external scheme before it commits", async () => {
    const driver = port("external", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/external") },
      signal: signal(),
    });
    await driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "click",
      ref: refNamed(nav.snapshotText, "Go external"),
      signal: signal(),
    });
    await eventually(
      () => driver.console({ tabId: nav.tabId, signal: signal() }),
      (read) => read.messages.some((message) => message.text === BLOCKED),
    );
    const tab = backend.list({ projectId: PROJECT }).find((each) => each.tabId === nav.tabId)!;
    expect(tab.url).toBe(fixture.url("/external"));
    driver.dispose();
  });

  it("guards frames: out-of-process iframes and redirect hops are held to HTTP(S)", async () => {
    const driver = port("frames", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/frames") },
      signal: signal(),
    });
    // Every frame that may run has run: the cross-site frame (out of
    // process) and the allowed redirect.
    const ran = await eventually(
      () => driver.snapshot({ tabId: nav.tabId, signal: signal() }),
      (snap) => snap.title.includes("oopif") && snap.title.includes("hop-ok"),
      6_000,
    );
    // Give the refused navigations time they would need to land.
    await new Promise((resolve) => setTimeout(resolve, 750));
    const final = await driver.snapshot({ tabId: nav.tabId, signal: signal() });
    const said = final.title.replace(/^frames:/, "").split(",");
    // The out-of-process frame's own navigation to an address the policy
    // refuses (an over-long URL Chromium itself would load) never ran: the
    // frame's session carries the page's document guard.
    expect(said).not.toContain("oopif-long");
    // A redirect hop to a refused address is refused before it is sent.
    expect(said).not.toContain("hop");
    expect(ran.title).toContain("oopif");
    /*
     * The residual, pinned (B6(c)): same-process `data:`, `blob:` and
     * `srcdoc` frames are made without a network request, so no `Fetch`
     * guard sees them, and CDP has no per-frame pre-commit refusal. They run
     * here; desktop's `will-frame-navigate` refuses them. None gains a
     * privilege the page lacks (`blob:`/`srcdoc` share its origin, `data:` is
     * opaque), but it is not desktop parity: VC-571 must not wire hostd's
     * browser for people until this is resolved. See the host-core README.
     * When a mechanism lands, flip these to `not.toContain`.
     */
    expect(said).toEqual(expect.arrayContaining(["data", "blob", "srcdoc"]));
    driver.dispose();
  });

  const click = async (
    driver: ReturnType<typeof port>,
    nav: { tabId: string; generation: number; snapshotText: string },
    name: string,
  ) =>
    driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "click",
      ref: refNamed(nav.snapshotText, name),
      signal: signal(),
    });

  it("answers dialogs nobody can see safely, and says so: alert acknowledged, confirm and prompt declined", async () => {
    const driver = port("dialogs", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/dialogs") },
      signal: signal(),
    });
    const titleAfter = async (name: string, expected: string) => {
      const current = await driver.snapshot({ tabId: nav.tabId, signal: signal() });
      await click(driver, current, name);
      const settled = await eventually(
        () => driver.snapshot({ tabId: nav.tabId, signal: signal() }),
        (snap) => snap.title === expected,
      );
      expect(settled.title).toBe(expected);
    };
    await titleAfter("Raise alert", "alert:done");
    await titleAfter("Ask confirm", "confirm:false");
    await titleAfter("Ask prompt", "prompt:null");
    const record = await driver.console({ tabId: nav.tabId, signal: signal() });
    const texts = record.messages.map((message) => message.text);
    expect(texts).toContain(
      "The page opened a alert dialog nobody could answer; Volli acknowledged it: fixture alert",
    );
    expect(texts).toContain(
      "The page opened a confirm dialog nobody could answer; Volli declined it (confirm returned false): Sure?",
    );
    expect(texts).toContain(
      "The page opened a prompt dialog nobody could answer; Volli declined it (prompt returned null): Name?",
    );
    driver.dispose();
  });

  it("never approves leaving a page that guards unsaved work: the tab stays, and the agent is told", async () => {
    const driver = port("guarded", null);
    const nav = await driver.navigate({
      navigation: { kind: "url", url: fixture.url("/guarded") },
      signal: signal(),
    });
    // Typing gives the page the activation a leave-page prompt needs.
    await driver.act({
      tabId: nav.tabId,
      generation: nav.generation,
      kind: "type",
      ref: refNamed(nav.snapshotText, "Draft"),
      text: "unsaved words",
      signal: signal(),
    });
    const typed = await driver.snapshot({ tabId: nav.tabId, signal: signal() });
    // The page's own departure (a link)...
    const followed = await click(driver, typed, "Leave the draft");
    expect(followed.url).toBe(fixture.url("/guarded"));
    expect(followed.error).toBe("The page asked to confirm leaving it; Volli stayed on the page.");
    // ...and the product door's (the agent's navigate) are both refused.
    const steered = await driver.navigate({
      tabId: nav.tabId,
      navigation: { kind: "url", url: fixture.url("/second") },
      signal: signal(),
    });
    expect(steered.url).toBe(fixture.url("/guarded"));
    expect(steered.error).toBe("The page asked to confirm leaving it; Volli stayed on the page.");
    expect(fixture.hits("/second")).toBe(0);
    const record = await driver.console({ tabId: nav.tabId, signal: signal() });
    expect(record.messages.map((message) => message.text)).toContain(
      "The page opened a beforeunload dialog nobody could answer; Volli declined it and stayed on the page",
    );
    // Closing the tab runs no unload veto: the way out is always open.
    backend.close(nav.tabId);
    expect(backend.list({ projectId: PROJECT }).some((tab) => tab.tabId === nav.tabId)).toBe(false);
    driver.dispose();
  });

  it("forgets every tab when the browser exits, and launches again for the next", async () => {
    const lonely = chromiumBackend();
    const tab = lonely.open({
      url: fixture.url("/second"),
      projectId: PROJECT,
      ticketId: null,
      createdBy: "user",
    });
    await lonely.waitForLoad(tab.tabId, signal(), "current");
    await lonely.dispose();
    expect(lonely.list({ projectId: PROJECT })).toEqual([]);
  });
});
