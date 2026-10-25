import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ACCOUNT_SESSION_PURPOSE,
  inventoryAccountSessionStore,
  parseSavedSession,
  SavedSessionChangedError,
  type SavedAccountSession,
} from "./session-store";
import { tempInventory } from "./test-support";

const SESSION: SavedAccountSession = {
  provider: "workos",
  refreshToken: "refresh-1",
  sessionId: "session_01",
  profile: { displayName: "Dana", email: "dana@example.com" },
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function store() {
  const temp = tempInventory();
  cleanups.push(temp.dispose);
  const unlock = vi.fn(async () => {});
  return { ...temp, unlock, store: inventoryAccountSessionStore(temp.inventory, unlock) };
}

describe("the saved sign-in", () => {
  it("seals the refresh token in the host-private family, and reads it back", async () => {
    const { store: saved, inventory, unlock } = store();
    await expect(saved.load()).resolves.toBeNull();
    const ref = await saved.save(SESSION, null);
    expect(inventory.list("host-private").map(({ selector }) => selector)).toEqual([
      { purpose: ACCOUNT_SESSION_PURPOSE },
    ]);
    await expect(saved.load()).resolves.toEqual({ session: SESSION, ref });
    expect(unlock).toHaveBeenCalledTimes(3);
  });

  it("replaces only the record it read: a sign-out beats a late refresh", async () => {
    const { store: saved } = store();
    const first = await saved.save(SESSION, null);
    const second = await saved.save({ ...SESSION, refreshToken: "refresh-2" }, first);
    // A save based on the first record, after the second replaced it, loses.
    await expect(saved.save({ ...SESSION, refreshToken: "stale" }, first)).rejects.toBeInstanceOf(
      SavedSessionChangedError,
    );
    await saved.clear();
    await expect(saved.save({ ...SESSION, refreshToken: "late" }, second)).rejects.toBeInstanceOf(
      SavedSessionChangedError,
    );
    await expect(saved.load()).resolves.toBeNull();
    await saved.clear();
  });

  it("forgets a value this build cannot read", async () => {
    const { store: saved, inventory } = store();
    inventory.put("host-private", { purpose: ACCOUNT_SESSION_PURPOSE }, "{not json");
    await expect(saved.load()).resolves.toBeNull();
    expect(inventory.list("host-private")).toEqual([]);
  });

  it("keeps a save failure that is not a conflict as it is", async () => {
    const failure = new Error("disk full");
    const saved = inventoryAccountSessionStore(
      {
        get: () => null,
        put: () => {
          throw failure;
        },
        remove: () => false,
      },
      async () => {},
    );
    await expect(saved.save(SESSION, null)).rejects.toBe(failure);
  });

  it("parses exactly the shape it writes", () => {
    const valid = JSON.stringify({ v: 1, ...SESSION });
    expect(parseSavedSession(valid)).toEqual(SESSION);
    expect(
      parseSavedSession(
        JSON.stringify({
          v: 1,
          ...SESSION,
          sessionId: null,
          profile: { displayName: null, email: null },
        }),
      ),
    ).toEqual({ ...SESSION, sessionId: null, profile: { displayName: null, email: null } });
    for (const value of [
      7,
      "null",
      JSON.stringify({ ...SESSION, v: 2 }),
      JSON.stringify({ v: 1, ...SESSION, provider: "clerk" }),
      JSON.stringify({ v: 1, ...SESSION, refreshToken: "" }),
      JSON.stringify({ v: 1, ...SESSION, sessionId: 3 }),
      JSON.stringify({ v: 1, ...SESSION, profile: { displayName: 1, email: null } }),
      JSON.stringify({ v: 1, ...SESSION, profile: null }),
    ]) {
      expect(parseSavedSession(value), String(value)).toBeNull();
    }
  });
});
