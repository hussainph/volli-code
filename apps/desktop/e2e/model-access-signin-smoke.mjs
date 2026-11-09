/**
 * E2e probe: signing in to a provider without leaving the app.
 *
 * Sign-in used to be a terminal handoff to a bundled `pi` binary, and the whole
 * point of replacing it is a chain no unit test can see: a preload door, four
 * guarded channels, an ephemeral update channel main pushes on, a login flow
 * pi-ai owns, and a credential file the runtime reads back. Each half is
 * mocked by the other's tests. All of them pass while the seam is broken.
 *
 * So this drives the real one: open Settings, sign in to an api-key provider,
 * type a key into the step the provider asks for, and check the file. Then sign
 * out and check it again — the two halves of the same claim, since a sign-in
 * that cannot be undone is a sign-in nobody should trust.
 *
 * **Nothing here is billed and no account is touched.** An api-key login is
 * entirely local: the provider prompts, returns a credential, and `Models.login`
 * persists it. Nobody validates the key — no provider offers a call that would
 * — so a made-up one stores exactly like a real one, and a wrong key surfaces on
 * first use rather than here. That is also the honest reason this probe never
 * asserts the word "connected" anywhere.
 *
 * `HOME` is a scratch directory, so `piAuthFilePath()` resolves to
 * `<scratch>/home/.pi/agent/auth.json` and the developer's own `~/.pi` is not
 * read, written, or even opened.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/model-access-signin-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  createRunner,
  launch,
  makeScratch,
  readFileSafe,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

/**
 * Groq offers an api-key login and no OAuth, so its row shows one plain "Sign
 * in" button rather than a method menu, and its flow is the generic helper's
 * single `secret` step. `sign-in.integration.test.ts` pins both facts against
 * the real provider table; this only has to click them.
 */
const PROVIDER_ID = "groq";
/** The name a person types into the provider search to find it. */
const PROVIDER_LABEL = "Groq";
/** Never a real key, and never validated by anything — see the header. */
const FAKE_KEY = "gsk-volli-smoke-not-a-real-key-000000";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-model-access-signin-");
const home = join(scratch, "home");
const authFile = join(home, ".pi", "agent", "auth.json");
const { check, attempt, summarize } = createRunner();

/** The credential map as it is on disk right now, or null when there is no file. */
async function storedProviders() {
  const text = await readFileSafe(authFile);
  if (text === null) return null;
  try {
    return Object.keys(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The provider's name, as the Models page lists it.
 *
 * A provider row is the settings kit's `ItemRow`, and the shared list row puts
 * a `data-testid` on its NAME half — the row's buttons are that element's
 * sibling, never its children (`ui/list-row.tsx`). The row a person reads —
 * name, status and actions — is the shell one level up, so that is what
 * {@link accountRow} names.
 */
const accountName = (page) => page.getByTestId(`account-${PROVIDER_ID}`);
const accountRow = (page) => accountName(page).locator("xpath=..");
const signInPanel = (page) => page.getByTestId(`sign-in-${PROVIDER_ID}`);

/**
 * Which half of the accounts list holds the provider: `connected` under
 * "Signed in", `available` under "Available to connect", or null when neither
 * renders it. The rebuilt page dropped the per-row "Sign in required" status
 * as a repeat of the row's own action; the half it sits in is what says it.
 */
async function accountHalf(page) {
  const inHalf = (slot) =>
    page.locator(`[data-slot="${slot}"]`).getByTestId(`account-${PROVIDER_ID}`).count();
  if ((await inHalf("model-access-accounts")) > 0) return "connected";
  if ((await inHalf("model-access-accounts-available")) > 0) return "available";
  return null;
}

/**
 * "Available to connect" previews a handful of common providers and keeps the
 * rest behind its own search, so a signed-out Groq is found the way a person
 * finds it: by typing its name. Signed in, it moves up to "Signed in", where
 * nothing hides it.
 */
async function revealAccount(page) {
  if ((await accountName(page).count()) > 0) return;
  await page.getByRole("searchbox", { name: "Search providers", exact: true }).fill(PROVIDER_LABEL);
}

/**
 * Settings → Models, scoped through the nav landmark because these words are
 * common on this surface.
 *
 * The category was "Model Access" and before that "Agent"; VC-111 renamed it
 * to Models and grouped it under Services. `resolveSettingsCategory` keeps the
 * old KEY working for the chat blocker's deep link, but the rail LABEL is what
 * this clicks, so it follows the rename.
 */
async function openAgentSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Models", exact: true })
    .click();
  // The provider search renders once the catalogue has loaded.
  await page.getByRole("searchbox", { name: "Search providers", exact: true }).waitFor();
  await revealAccount(page);
  await accountName(page).waitFor();
}

console.log("scratch:", scratch, "\n");
await fs.mkdir(home, { recursive: true });

const app = await launch({ dbPath, userDataDir, extraEnv: { HOME: home } });
try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await assertBuiltRendererLoaded(page);
  await sleep(1000);

  // The premise of everything below: this profile has no credentials at all,
  // and the file the app is about to write is inside the scratch.
  check(
    "0",
    "the scratch profile starts with no Pi credentials",
    (await storedProviders()) === null,
    `authFile=${authFile}`,
  );

  await attempt(1, "the preload exposes the in-app sign-in door", async () => {
    const shape = await page.evaluate(() => {
      const door = window.api?.modelAccess;
      return door === undefined
        ? null
        : Object.fromEntries(
            ["beginSignIn", "respondToPrompt", "cancelSignIn", "signOut", "onSignInUpdate"].map(
              (name) => [name, typeof door[name]],
            ),
          );
    });
    const wrong = Object.entries(shape ?? {}).filter(([, kind]) => kind !== "function");
    return {
      ok: shape !== null && wrong.length === 0,
      detail: shape === null ? "window.api.modelAccess is missing" : JSON.stringify(shape),
    };
  });

  await attempt(2, "a signed-out provider offers Sign in rather than a terminal", async () => {
    await openAgentSettings(page);
    const row = accountRow(page);
    const text = (await row.textContent())?.trim() ?? "";
    const half = await accountHalf(page);
    const signIn = await row
      .getByRole("button", { name: `Sign in to ${PROVIDER_LABEL}`, exact: true })
      .count();
    const signOut = await row
      .getByRole("button", { name: `Sign out of ${PROVIDER_LABEL}`, exact: true })
      .count();
    return {
      ok: half === "available" && signIn === 1 && signOut === 0 && !/terminal/i.test(text),
      detail: `half=${half} signIn=${signIn} signOut=${signOut} row=${JSON.stringify(text)}`,
    };
  });

  await attempt(3, "the provider's own step is what the panel asks", async () => {
    await accountRow(page)
      .getByRole("button", { name: `Sign in to ${PROVIDER_LABEL}`, exact: true })
      .click();
    const panel = signInPanel(page);
    await panel.waitFor();
    const field = panel.locator("input");
    await field.waitFor();
    // The label is the provider's `message`, not copy written here, and a
    // credential field is masked — the one thing this UI decides about a step.
    const label = (await panel.locator("label").textContent())?.trim() ?? "";
    const type = await field.getAttribute("type");
    return {
      ok: type === "password" && label.length > 0,
      detail: `label=${JSON.stringify(label)} type=${type}`,
    };
  });

  await attempt(4, "an answered step stores the credential in the scratch profile", async () => {
    const panel = signInPanel(page);
    await panel.locator("input").fill(FAKE_KEY);
    await panel.getByRole("button", { name: "Continue", exact: true }).click();

    const stored = await waitUntil(
      "auth.json names the provider",
      async () => {
        const providers = await storedProviders();
        return providers?.includes(PROVIDER_ID) === true ? providers : null;
      },
      { timeout: 20_000 },
    );
    return { ok: true, detail: `stored=${JSON.stringify(stored)}` };
  });

  await attempt(5, "the key crossed once and is not readable back through the door", async () => {
    // The renderer may never learn a stored credential — `CredentialInfo` is
    // the whole shape it is allowed, and this is the assertion that keeps a
    // convenience field from quietly appearing on the snapshot later.
    const snapshot = await page.evaluate(() =>
      window.api.sessionRpc.request({
        path: "modelAccess.inspect",
        type: "query",
        input: { refresh: false },
      }),
    );
    const serialized = JSON.stringify(snapshot);
    return {
      ok: !serialized.includes(FAKE_KEY),
      detail: serialized.includes(FAKE_KEY) ? "the snapshot echoed the key" : "no key in snapshot",
    };
  });

  await attempt(6, "the row reports a stored credential and offers Sign out", async () => {
    await waitUntil(
      "the account row offers Sign out",
      async () => {
        const button = accountRow(page).getByRole("button", {
          name: `Sign out of ${PROVIDER_LABEL}`,
          exact: true,
        });
        return (await button.count()) === 1 ? button : null;
      },
      { timeout: 20_000 },
    );
    // The panel is gone: an ended attempt leaves nothing open, and nothing on
    // screen claims the key was verified, because nothing verified it.
    const panels = await signInPanel(page).count();
    const half = await accountHalf(page);
    const text = (await accountRow(page).textContent()) ?? "";
    return {
      ok: panels === 0 && half === "connected" && !/connected|verified/i.test(text),
      detail: `panels=${panels} half=${half} row=${JSON.stringify(text.trim())}`,
    };
  });

  await attempt(7, "signing out removes the stored credential", async () => {
    await accountRow(page)
      .getByRole("button", { name: `Sign out of ${PROVIDER_LABEL}`, exact: true })
      .click();
    const remaining = await waitUntil(
      "auth.json no longer names the provider",
      async () => {
        const providers = await storedProviders();
        return providers !== null && !providers.includes(PROVIDER_ID) ? providers : null;
      },
      { timeout: 20_000 },
    );
    return { ok: true, detail: `remaining=${JSON.stringify(remaining)}` };
  });

  await attempt(8, "the row goes back to offering Sign in", async () => {
    const signIn = await waitUntil(
      "the account row offers Sign in again",
      async () => {
        // Back in "Available to connect", it may be behind the preview again.
        await revealAccount(page);
        const button = accountRow(page).getByRole("button", {
          name: `Sign in to ${PROVIDER_LABEL}`,
          exact: true,
        });
        return (await button.count()) === 1 ? button : null;
      },
      { timeout: 20_000 },
    );
    const half = await accountHalf(page);
    const signOut = await accountRow(page)
      .getByRole("button", { name: `Sign out of ${PROVIDER_LABEL}`, exact: true })
      .count();
    return {
      ok: signIn !== null && signOut === 0 && half === "available",
      detail: `half=${half} signOutButtons=${signOut}`,
    };
  });

  check(
    "9",
    "the developer's own Pi profile was never the target",
    authFile.startsWith(scratch),
    `authFile=${authFile}`,
  );
} catch (error) {
  check("!", "smoke crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}

const exitCode = summarize();
await cleanup();
process.exit(exitCode);
