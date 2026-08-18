import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Result, VolliIpcChannel, WebAccessResult } from "../../ipc/contract";

// Hoisted so the electron mock factory can capture into it — the shape every
// other main IPC suite here uses.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { openTestDb, type TestDb } from "../db/test-helpers";
import { WebCredentialStore, type SecretCipher } from "./credential";
import { WebAccessSettings } from "./settings";
import { registerWebAccessIpcHandlers } from "./ipc";

class FakeCipher implements SecretCipher {
  available = true;

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`v1:${Buffer.from(plainText, "utf8").toString("base64")}`, "utf8");
  }

  decryptString(encrypted: Buffer): string {
    return Buffer.from(encrypted.toString("utf8").slice("v1:".length), "base64").toString("utf8");
  }
}

const KEY = "BSA-super-secret-brave-key-42";

let ctx: TestDb;
let cipher: FakeCipher;
let settings: WebAccessSettings;

/** Dispatch one request the way `ipcMain.handle` would, sender included. */
async function invoke(channel: VolliIpcChannel, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`No handler registered for ${channel}`);
  return (handler as (event: unknown, ...rest: unknown[]) => unknown)({ sender: {} }, ...args);
}

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
  cipher = new FakeCipher();
  settings = new WebAccessSettings({
    db: ctx.db,
    credentials: new WebCredentialStore({ db: ctx.db, cipher }),
  });
  registerWebAccessIpcHandlers(settings);
});

afterEach(() => {
  ctx.cleanup();
});

describe("the Web Access door", () => {
  it("answers a fresh profile with Off and no key", async () => {
    expect(await invoke("volli:web-access-get")).toEqual({
      ok: true,
      settings: {
        provider: "off",
        searxngUrl: null,
        braveKey: "absent",
        encryptionAvailable: true,
      },
    });
  });

  it("saves a provider and hands back what changed", async () => {
    const result = (await invoke(
      "volli:web-access-set-provider",
      "searxng",
      "http://localhost:8888",
    )) as WebAccessResult;

    expect(result).toMatchObject({
      ok: true,
      settings: { provider: "searxng", searxngUrl: "http://localhost:8888/" },
    });
  });

  it("returns a refused endpoint as an error a person can read, not a crash", async () => {
    const result = (await invoke(
      "volli:web-access-set-provider",
      "searxng",
      "http://10.0.0.9:8888",
    )) as Result;

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringMatching(/private network/i) });
    expect(((await invoke("volli:web-access-get")) as WebAccessResult).ok && true).toBe(true);
  });

  it("stores a key and afterwards will only say that one exists", async () => {
    await invoke("volli:web-access-set-provider", "brave", null);
    const saved = await invoke("volli:web-access-set-key", KEY);
    const fetched = await invoke("volli:web-access-get");

    expect(saved).toMatchObject({ ok: true, settings: { braveKey: "present" } });
    // The one non-negotiable: nothing this door answers with contains the key.
    expect(JSON.stringify([saved, fetched])).not.toContain(KEY);
  });

  it("forgets a key on request", async () => {
    await invoke("volli:web-access-set-key", KEY);

    expect(await invoke("volli:web-access-clear-key")).toMatchObject({
      ok: true,
      settings: { braveKey: "absent" },
    });
  });

  it("says plainly that a key cannot be stored on a machine that cannot encrypt", async () => {
    cipher.available = false;

    const result = (await invoke("volli:web-access-set-key", KEY)) as Result;

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringMatching(/keychain/i) });
    expect(result.ok === false && result.error).not.toContain(KEY);
  });

  it("refuses arguments that are not the ones the channel takes", async () => {
    expect(await invoke("volli:web-access-set-provider", "yandex", null)).toEqual({
      ok: false,
      error: "Invalid web access provider",
    });
    expect(await invoke("volli:web-access-set-key", 42)).toEqual({
      ok: false,
      error: "Invalid API key",
    });
    expect(await invoke("volli:web-access-get", "extra")).toEqual({
      ok: false,
      error: "Invalid request",
    });
  });

  it("claims its channels even when there is no database, so the page fails loudly", async () => {
    handlers.clear();
    registerWebAccessIpcHandlers(null, "The local database failed to open.");

    for (const channel of [
      "volli:web-access-get",
      "volli:web-access-set-provider",
      "volli:web-access-set-key",
      "volli:web-access-clear-key",
    ] as const) {
      expect(await invoke(channel)).toEqual({
        ok: false,
        error: "The local database failed to open.",
      });
    }
  });
});
