import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { readSecret } from "../db/secrets-repo";
import { BRAVE_SEARCH_KEY_SECRET, WebCredentialError, WebCredentialStore } from "./credential";

const KEY = "BSA-super-secret-brave-key-42";

let ctx: TestDb;
let store: WebCredentialStore;

beforeEach(() => {
  ctx = openTestDb();
  store = new WebCredentialStore({
    db: ctx.db,
    secretName: BRAVE_SEARCH_KEY_SECRET,
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  ctx.cleanup();
});

describe("WebCredentialStore", () => {
  it("holds nothing on a fresh profile", () => {
    expect(store.state()).toBe("absent");
    expect(store.read()).toBeNull();
  });

  it("hands back the key it was given", () => {
    store.save(KEY);

    expect(store.state()).toBe("present");
    expect(store.read()).toBe(KEY);
  });

  it("keeps the key in the one table nothing answers the renderer from", () => {
    store.save(KEY);

    // The key IS the stored value now — the protection is which table it is in,
    // not what it was transformed into. So the claim worth testing is that it is
    // in that table and no other.
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBe(KEY);
  });

  it("keeps no row anywhere else in the database", () => {
    store.save(KEY);

    // Every other table's whole content, as text. A key that leaked into
    // `app_state` would ride the bootstrap payload straight to the renderer.
    const tables = ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'secrets'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const rows = ctx.db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows)).not.toContain(KEY);
    }
  });

  it("trims what a paste brought with it", () => {
    store.save(`  ${KEY}\n`);

    expect(store.read()).toBe(KEY);
  });

  it("refuses a key that is only whitespace, without repeating what it was handed", () => {
    try {
      store.save("   \n ");
      expect.unreachable("saving must refuse");
    } catch (error) {
      const refusal = error as Error;
      expect(refusal).toBeInstanceOf(WebCredentialError);
      expect(refusal.message).toMatch(/no key/i);
    }
    expect(store.state()).toBe("absent");
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBeNull();
  });

  it("replaces a stored key rather than keeping two", () => {
    store.save(KEY);
    store.save("exa-rotated-key-88");

    expect(store.read()).toBe("exa-rotated-key-88");
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM secrets").get()).toEqual({ n: 1 });
  });

  it("forgets a key on request, and forgetting nothing is not an error", () => {
    store.save(KEY);
    store.clear();

    expect(store.state()).toBe("absent");
    expect(store.read()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  it("owns one name, so a second provider's store cannot answer for it", () => {
    const exa = new WebCredentialStore({ db: ctx.db, secretName: "web-access.exa.api-key" });
    store.save(KEY);

    expect(exa.state()).toBe("absent");
    expect(exa.read()).toBeNull();
  });
});
