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
  await page.getByTestId(`account-${PROVIDER_ID}`).waitFor();
}

const accountRow = (page) => page.getByTestId(`account-${PROVIDER_ID}`);
const signInPanel = (page) => page.getByTestId(`sign-in-${PROVIDER_ID}`);

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
    const status = (await row.textContent())?.trim() ?? "";
    const signIn = row.getByRole("button", { name: "Sign in", exact: true });
    return {
      ok: (await signIn.count()) === 1 && status.includes("Sign in required"),
      detail: `status=${JSON.stringify(status)}`,
    };
  });

  await attempt(3, "the provider's own step is what the panel asks", async () => {
    await accountRow(page).getByRole("button", { name: "Sign in", exact: true }).click();
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
        procedure: "modelAccess.inspect",
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
        const button = accountRow(page).getByRole("button", { name: "Sign out", exact: true });
        return (await button.count()) === 1 ? button : null;
      },
      { timeout: 20_000 },
    );
    // The panel is gone: an ended attempt leaves nothing open, and nothing on
    // screen claims the key was verified, because nothing verified it.
    const panels = await signInPanel(page).count();
    const text = (await accountRow(page).textContent()) ?? "";
    return {
      ok: panels === 0 && !/connected|verified/i.test(text),
      detail: `panels=${panels} row=${JSON.stringify(text.trim())}`,
    };
  });

  await attempt(7, "signing out removes the stored credential", async () => {
    await accountRow(page).getByRole("button", { name: "Sign out", exact: true }).click();
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
        const button = accountRow(page).getByRole("button", { name: "Sign in", exact: true });
        return (await button.count()) === 1 ? button : null;
      },
      { timeout: 20_000 },
    );
    const signOut = await accountRow(page)
      .getByRole("button", { name: "Sign out", exact: true })
      .count();
    return { ok: signIn !== null && signOut === 0, detail: `signOutButtons=${signOut}` };
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
