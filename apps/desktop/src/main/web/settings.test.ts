import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  BRAVE_SEARCH_KEY_SECRET,
  EXA_SEARCH_KEY_SECRET,
  WebCredentialStore,
  type SecretCipher,
} from "./credential";
import { WebAccessSettings } from "./settings";

class FakeCipher implements SecretCipher {
  available = true;
  decryptFailure: Error | null = null;

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`v1:${Buffer.from(plainText, "utf8").toString("base64")}`, "utf8");
  }

  decryptString(encrypted: Buffer): string {
    if (this.decryptFailure !== null) throw this.decryptFailure;
    return Buffer.from(encrypted.toString("utf8").slice("v1:".length), "base64").toString("utf8");
  }
}

const KEY = "BSA-super-secret-brave-key-42";

let ctx: TestDb;
let cipher: FakeCipher;
let settings: WebAccessSettings;

beforeEach(() => {
  ctx = openTestDb();
  cipher = new FakeCipher();
  settings = new WebAccessSettings({
    db: ctx.db,
    credentials: {
      brave: new WebCredentialStore({ db: ctx.db, cipher, secretName: BRAVE_SEARCH_KEY_SECRET }),
      exa: new WebCredentialStore({ db: ctx.db, cipher, secretName: EXA_SEARCH_KEY_SECRET }),
    },
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  ctx.cleanup();
});

describe("WebAccessSettings — choosing Exa", () => {
  const EXA_KEY = "exa-second-provider-key-99";

  it("stores Exa's key beside Brave's rather than over it", () => {
    settings.saveKey("brave", KEY);
    settings.saveKey("exa", EXA_KEY);

    // Two providers, two rows. Configuring the second must not cost a person
    // the first, or switching provider would silently mean re-pasting a key.
    expect(settings.view().keys).toEqual({ brave: "present", exa: "present" });

    settings.setProvider({ provider: "brave", searxngUrl: null });
    expect(settings.resolve()).toEqual({ configured: true, provider: "brave", apiKey: KEY });
    settings.setProvider({ provider: "exa", searxngUrl: null });
    expect(settings.resolve()).toEqual({ configured: true, provider: "exa", apiKey: EXA_KEY });
  });

  it("is chosen but unconfigured until its own key is stored", () => {
    // Brave being configured says nothing about Exa: the reason must be about
    // the provider actually selected.
    settings.saveKey("brave", KEY);
    settings.setProvider({ provider: "exa", searxngUrl: null });

    expect(settings.view().keys.exa).toBe("absent");
    expect(settings.resolve()).toEqual({ configured: false, reason: "no-key" });
  });

  it("withholds web when Exa's stored key cannot be read on this machine", () => {
    settings.saveKey("exa", EXA_KEY);
    settings.setProvider({ provider: "exa", searxngUrl: null });
    cipher.available = false;

    expect(settings.view().keys.exa).toBe("unreadable");
    expect(settings.resolve()).toEqual({ configured: false, reason: "unreadable-key" });
  });

  it("forgets one provider's key without touching the other's", () => {
    settings.saveKey("brave", KEY);
    settings.saveKey("exa", EXA_KEY);

    settings.clearKey("exa");

    expect(settings.view().keys).toEqual({ brave: "present", exa: "absent" });
  });
});

describe("WebAccessSettings defaults", () => {
  it("is Off on a profile that never configured it", () => {
    expect(settings.view()).toEqual({
      provider: "off",
      searxngUrl: null,
      keys: { brave: "absent", exa: "absent" },
      encryptionAvailable: true,
    });
  });

  it("resolves to nothing configured, so a Session is offered no web at all", () => {
    expect(settings.resolve()).toEqual({ configured: false, reason: "off" });
  });
});

describe("WebAccessSettings — choosing SearXNG", () => {
  it("admits a self-hosted instance on this machine and stores what the policy normalized", () => {
    const saved = settings.setProvider({
      provider: "searxng",
      searxngUrl: "http://localhost:8888",
    });

    expect(saved.provider).toBe("searxng");
    expect(saved.searxngUrl).toBe("http://localhost:8888/");
    expect(settings.view().searxngUrl).toBe("http://localhost:8888/");
    expect(settings.resolve()).toEqual({
      configured: true,
      provider: "searxng",
      endpoint: "http://localhost:8888/",
    });
  });

  it("refuses an instance elsewhere on the network, in the endpoint policy's own words", () => {
    expect(() =>
      settings.setProvider({ provider: "searxng", searxngUrl: "http://192.168.1.5:8888" }),
    ).toThrow(/private network/i);

    // Nothing was stored: a refused endpoint must not become a live setting.
    expect(settings.view()).toMatchObject({ provider: "off", searxngUrl: null });
  });

  it("refuses a URL that is not one, a scheme that is not web, and credentials in the authority", () => {
    for (const searxngUrl of [
      "not a url",
      "ws://localhost:8888",
      "http://user:pw@localhost:8888",
    ]) {
      expect(() => settings.setProvider({ provider: "searxng", searxngUrl })).toThrow();
    }
    expect(settings.view().provider).toBe("off");
  });

  it("refuses SearXNG with no instance to call", () => {
    expect(() => settings.setProvider({ provider: "searxng", searxngUrl: null })).toThrow(
      /address of your SearXNG/i,
    );
    expect(() => settings.setProvider({ provider: "searxng", searxngUrl: "   " })).toThrow(
      /address of your SearXNG/i,
    );
  });
});

describe("WebAccessSettings — choosing Brave", () => {
  it("takes the choice before the key exists, and withholds web until one does", () => {
    const saved = settings.setProvider({ provider: "brave", searxngUrl: null });

    expect(saved.provider).toBe("brave");
    expect(saved.keys.brave).toBe("absent");
    expect(settings.resolve()).toEqual({ configured: false, reason: "no-key" });
  });

  it("is configured once a key is stored, and hands that key on only to the resolver", () => {
    settings.setProvider({ provider: "brave", searxngUrl: null });
    const view = settings.saveKey("brave", KEY);

    expect(view.keys.brave).toBe("present");
    expect(settings.resolve()).toEqual({ configured: true, provider: "brave", apiKey: KEY });
  });

  it("withholds web when the stored key cannot be read on this machine", () => {
    settings.setProvider({ provider: "brave", searxngUrl: null });
    settings.saveKey("brave", KEY);
    cipher.available = false;

    expect(settings.view()).toMatchObject({
      keys: { brave: "unreadable", exa: "absent" },
      encryptionAvailable: false,
    });
    expect(settings.resolve()).toEqual({ configured: false, reason: "unreadable-key" });
  });

  it("costs a Session its web tools, never its attach, when the ciphertext will not open", () => {
    settings.setProvider({ provider: "brave", searxngUrl: null });
    settings.saveKey("brave", KEY);
    // The keychain answers, and then fails to decrypt — a profile restored from
    // a backup, or a keychain entry replaced out from under this one.
    cipher.decryptFailure = new Error("decryption failed");

    // Resolving is on the attach path. A throw here would fail the whole
    // attachment, so a Session with a broken key would be a Session that cannot
    // start rather than one without web tools.
    expect(() => settings.resolve()).not.toThrow();
    expect(settings.resolve()).toEqual({ configured: false, reason: "unreadable-key" });
  });

  it("forgets the key on request", () => {
    settings.setProvider({ provider: "brave", searxngUrl: null });
    settings.saveKey("brave", KEY);

    expect(settings.clearKey("brave").keys.brave).toBe("absent");
    expect(settings.resolve()).toEqual({ configured: false, reason: "no-key" });
  });
});

describe("WebAccessSettings — turning it off", () => {
  it("stops offering web without discarding what was configured", () => {
    settings.setProvider({ provider: "searxng", searxngUrl: "http://127.0.0.1:8080" });
    settings.saveKey("brave", KEY);

    const off = settings.setProvider({ provider: "off", searxngUrl: null });

    expect(off).toMatchObject({
      provider: "off",
      searxngUrl: "http://127.0.0.1:8080/",
      keys: { brave: "present", exa: "absent" },
    });
    expect(settings.resolve()).toEqual({ configured: false, reason: "off" });
  });
});

describe("WebAccessSettings — what the renderer may learn", () => {
  it("never puts the key in anything it returns", () => {
    settings.setProvider({ provider: "brave", searxngUrl: null });

    const answers = [
      settings.saveKey("brave", KEY),
      settings.view(),
      settings.setProvider({ provider: "searxng", searxngUrl: "http://localhost:8888" }),
      settings.clearKey("brave"),
    ];

    expect(JSON.stringify(answers)).not.toContain(KEY);
  });

  it("survives a database somebody edited by hand rather than trusting what is in it", () => {
    ctx.db
      .prepare(
        "INSERT INTO web_access_settings (id, provider, searxng_url, updated_at) VALUES (1, 'off', ?, 0)" +
          " ON CONFLICT(id) DO UPDATE SET searxng_url = excluded.searxng_url",
      )
      .run("http://169.254.169.254/");

    // Stored is not admitted: the endpoint is judged again on the way out, so a
    // row written around the validating channel still reaches no socket.
    expect(settings.view().searxngUrl).toBe("http://169.254.169.254/");
    expect(settings.resolve()).toEqual({ configured: false, reason: "off" });

    ctx.db.prepare("UPDATE web_access_settings SET provider = 'searxng' WHERE id = 1").run();
    expect(settings.resolve()).toEqual({ configured: false, reason: "no-endpoint" });
  });
});
