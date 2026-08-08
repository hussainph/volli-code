import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPiAgentRuntime } from "./runtime";
import { PiFileCredentialStore, piAuthFilePath, piOwnedModels } from "./models";

const OAUTH = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: 1,
  accountId: "acct-1",
} as const;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "volli-pi-credentials-"));
}

/** An agent dir holding `auth.json` with exactly `contents`, verbatim. */
function agentDirWith(contents: string): string {
  const dir = join(scratch(), "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), contents, "utf8");
  return dir;
}

function storeIn(dir: string): PiFileCredentialStore {
  return new PiFileCredentialStore(join(dir, "auth.json"));
}

const held = { agentDir: process.env.PI_CODING_AGENT_DIR };

afterEach(() => {
  if (held.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = held.agentDir;
});

describe("piAuthFilePath", () => {
  it("prefers an explicitly passed agent dir", () => {
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    expect(piAuthFilePath({ agentDir: "/explicit/agent" })).toBe("/explicit/agent/auth.json");
  });

  it("falls back to Pi's own environment override", () => {
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    expect(piAuthFilePath()).toBe("/env/agent/auth.json");
  });

  it("expands a leading tilde in the override, as the pi CLI does", () => {
    process.env.PI_CODING_AGENT_DIR = "~/elsewhere/agent";
    expect(piAuthFilePath()).toBe(join(homedir(), "elsewhere/agent/auth.json"));

    process.env.PI_CODING_AGENT_DIR = "~";
    expect(piAuthFilePath()).toBe(join(homedir(), "auth.json"));
  });

  it("falls back to ~/.pi/agent when the override is absent or empty", () => {
    const expected = join(homedir(), ".pi", "agent", "auth.json");
    delete process.env.PI_CODING_AGENT_DIR;
    expect(piAuthFilePath()).toBe(expected);
    process.env.PI_CODING_AGENT_DIR = "";
    expect(piAuthFilePath()).toBe(expected);
  });
});

describe("PiFileCredentialStore reads", () => {
  it("reads a credential the pi CLI wrote, index signature and all", async () => {
    const store = storeIn(agentDirWith(JSON.stringify({ "openai-codex": OAUTH })));
    await expect(store.read("openai-codex")).resolves.toEqual(OAUTH);
  });

  it("reports no credential for a provider the file does not name", async () => {
    const store = storeIn(agentDirWith(JSON.stringify({ "openai-codex": OAUTH })));
    await expect(store.read("anthropic")).resolves.toBeUndefined();
  });

  it("treats a missing file as no credentials rather than a failure", async () => {
    const store = storeIn(join(scratch(), "never-written"));
    await expect(store.read("openai-codex")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("lists stored metadata without exposing a secret", async () => {
    const store = storeIn(
      agentDirWith(
        JSON.stringify({ "openai-codex": OAUTH, anthropic: { type: "api_key", key: "sk-secret" } }),
      ),
    );
    const listed = await store.list();
    expect(listed).toEqual([
      { providerId: "openai-codex", type: "oauth" },
      { providerId: "anthropic", type: "api_key" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("sk-secret");
  });

  it("drops entries that are not credentials and keeps the ones beside them", async () => {
    const store = storeIn(
      agentDirWith(
        JSON.stringify({ "openai-codex": OAUTH, future: { type: "passkey" }, broken: 7 }),
      ),
    );
    await expect(store.read("future")).resolves.toBeUndefined();
    await expect(store.read("broken")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("reports an unreadable file by path alone, never by quoting it", async () => {
    const store = storeIn(agentDirWith('{"openai-codex": {"access": "sk-live-secret'));
    await expect(store.read("openai-codex")).rejects.toThrow(/auth\.json are unreadable/);
    await expect(store.read("openai-codex")).rejects.not.toThrow(/sk-live-secret/);
  });

  it("reports a file that is not a credential map the same way", async () => {
    const store = storeIn(agentDirWith('["openai-codex"]'));
    await expect(store.read("openai-codex")).rejects.toThrow(/unreadable/);
  });

  it("reports an unopenable file without a filesystem error's own words", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH }));
    chmodSync(join(dir, "auth.json"), 0o000);
    const store = storeIn(dir);
    await expect(store.read("openai-codex")).rejects.toThrow(/Could not read Pi credentials/);
    chmodSync(join(dir, "auth.json"), 0o600);
  });
});

describe("PiFileCredentialStore writes", () => {
  it("persists a refreshed credential for the next process to read", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH, anthropic: OAUTH }));
    const store = storeIn(dir);

    const refreshed = { ...OAUTH, access: "rotated", expires: 2 };
    await expect(
      store.modify("openai-codex", async (current) => {
        expect(current).toEqual(OAUTH);
        return refreshed;
      }),
    ).resolves.toEqual(refreshed);

    await expect(storeIn(dir).read("openai-codex")).resolves.toEqual(refreshed);
    // The provider beside it is carried forward, not dropped by the rewrite.
    await expect(storeIn(dir).read("anthropic")).resolves.toEqual(OAUTH);
    expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("creates the agent directory and the file on a first login", async () => {
    const dir = join(scratch(), "fresh", "agent");
    const store = storeIn(dir);
    await expect(store.modify("openai-codex", async () => OAUTH)).resolves.toEqual(OAUTH);
    expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))).toEqual({
      "openai-codex": OAUTH,
    });
  });

  it("leaves the file untouched when the refresh decides nothing changed", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH }));
    const before = readFileSync(join(dir, "auth.json"), "utf8");
    await expect(storeIn(dir).modify("openai-codex", async () => undefined)).resolves.toEqual(
      OAUTH,
    );
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe(before);
  });

  it("serializes concurrent writes so neither one is lost", async () => {
    const dir = agentDirWith("{}");
    const store = storeIn(dir);
    await Promise.all([
      store.modify("openai-codex", async () => OAUTH),
      store.modify("anthropic", async () => ({ type: "api_key", key: "k" }) as const),
    ]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")))).toEqual([
      "openai-codex",
      "anthropic",
    ]);
  });

  it("preserves a Pi CLI update made while an async refresh is pending", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH }));
    const authPath = join(dir, "auth.json");
    const store = storeIn(dir);
    const piRefreshed = { ...OAUTH, access: "pi-refreshed", expires: 2 };
    const volliRefreshed = { ...piRefreshed, access: "volli-refreshed", expires: 3 };
    const piRelease = await lockfile.lock(authPath, { realpath: false });
    let enteredModify = false;
    const pending = store.modify("openai-codex", async (current) => {
      enteredModify = true;
      // Pi's write wins the read that begins this refresh; the refresh itself
      // then deterministically produces the credential it persists.
      expect(current).toEqual(piRefreshed);
      return volliRefreshed;
    });

    // Pi's FileAuthStorageBackend takes this same advisory lock before it
    // reads or writes. Volli must not enter its async modifier while that
    // writer owns auth.json.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(enteredModify).toBe(false);

    writeFileSync(
      authPath,
      JSON.stringify({ "openai-codex": piRefreshed, anthropic: { type: "api_key", key: "k" } }),
      "utf8",
    );
    await piRelease();

    await expect(pending).resolves.toEqual(volliRefreshed);
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      "openai-codex": volliRefreshed,
      anthropic: { type: "api_key", key: "k" },
    });
  });

  it("hands a failure to its caller and still serves the write behind it", async () => {
    const dir = agentDirWith("{}");
    const store = storeIn(dir);
    const failed = store.modify("openai-codex", () => Promise.reject(new Error("refresh refused")));
    const after = store.modify("anthropic", async () => OAUTH);
    await expect(failed).rejects.toThrow("refresh refused");
    await expect(after).resolves.toEqual(OAUTH);
  });

  it("removes a credential on logout and ignores one that is already gone", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH, anthropic: OAUTH }));
    const store = storeIn(dir);
    await store.delete("openai-codex");
    await store.delete("openai-codex");
    expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))).toEqual({ anthropic: OAUTH });
  });
});

describe("piOwnedModels", () => {
  it("registers Pi's built-in providers against the credentials on disk", async () => {
    const models = piOwnedModels({
      agentDir: agentDirWith(JSON.stringify({ "openai-codex": OAUTH })),
    });
    expect(models.getModel("openai-codex", "gpt-5.6-luna")).toBeDefined();
    // The bug this file exists for: with pi-ai's default in-memory store this
    // resolves undefined — "Provider is not configured" — however valid the
    // OAuth token on disk is.
    await expect(models.checkAuth("openai-codex")).resolves.toEqual({
      type: "oauth",
      source: "OAuth",
    });
  });

  it("reports a provider with nothing stored as unconfigured", async () => {
    const models = piOwnedModels({ agentDir: agentDirWith("{}") });
    await expect(models.checkAuth("openai-codex")).resolves.toBeUndefined();
  });

  it("is what a runtime built without an injected collection uses", async () => {
    const dir = agentDirWith("{}");
    process.env.PI_CODING_AGENT_DIR = dir;
    const runtime = createPiAgentRuntime({ sessionDataDir: scratch() });
    // No credential for the pinned provider, so the attach reports the
    // configuration it could not satisfy rather than starting a turn.
    await expect(
      runtime.startTicketSession({
        identity: {
          sessionId: "s",
          rootThreadId: "t",
          attachmentId: "a",
          projectId: "p",
          ticketId: "k",
        },
        role: "ticket",
        worktreePath: scratch(),
        venue: "local",
        model: { providerId: "openai-codex", modelId: "not-a-model", reasoningLevel: "off" },
        authority: { mode: "auto" },
        brief: { text: "brief" },
        tools: { tools: [] },
        observer: async () => undefined,
      }),
    ).rejects.toThrow(/is not available/);
  });
});
