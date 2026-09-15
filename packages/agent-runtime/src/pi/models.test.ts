import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_RULE_PACK_HASH, BUILTIN_RULE_PACK_ID } from "@volli/shared";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPiAgentRuntime } from "./runtime";
import { PiFileModelsStore } from "./model-catalog";
import {
  PiFileCredentialStore,
  piAuthFilePath,
  piModelsFilePath,
  piOwnedModelAccess,
  piOwnedModels,
} from "./models";

/**
 * `open`, counted, with an overridable `stat()` on what it hands back, and
 * the handle-reads that follow — the parse the hold exists to spare.
 *
 * The cache's whole job is to keep one inspection's eighty asks down to one
 * read of `auth.json`, and the open plus the parse are what one read costs.
 * The `stat()` pin stages the one case a real filesystem makes hard to write:
 * a filesystem whose mtime does not move when the store rewrites the file.
 */
const fsHooks = vi.hoisted(() => ({
  openPaths: [] as string[],
  parsedOpens: 0,
  fstatMtimeMs: undefined as number | undefined,
  /**
   * One entry per handle-read to hold open until a test releases it, taken in
   * order, so a test can stage a pass a write overtakes and a later pass
   * alongside it. Reads past the end of the queue are not held at all.
   */
  stalls: [] as Promise<void>[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: unknown[]) => {
      fsHooks.openPaths.push(String(args[0]));
      const handle = await (actual.open as (...inner: unknown[]) => Promise<unknown>)(...args);
      const pinned = fsHooks.fstatMtimeMs;
      if (pinned !== undefined) {
        Object.defineProperty(handle, "stat", { value: async () => ({ mtimeMs: pinned }) });
      }
      return handle;
    },
    readFile: async (...args: unknown[]) => {
      // The credential store is the one reader here that reads an opened
      // handle; a string path is someone else's file.
      if (typeof args[0] !== "string") {
        fsHooks.parsedOpens += 1;
        const stall = fsHooks.stalls.shift();
        if (stall !== undefined) await stall;
      }
      return (actual.readFile as (...inner: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

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
  vi.restoreAllMocks();
  fsHooks.openPaths.length = 0;
  fsHooks.parsedOpens = 0;
  fsHooks.fstatMtimeMs = undefined;
  fsHooks.stalls.length = 0;
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

describe("PiFileCredentialStore caching", () => {
  it("opens auth.json once for a burst of readers while it is unchanged", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH, anthropic: OAUTH }));
    const authPath = join(dir, "auth.json");
    const store = storeIn(dir);
    fsHooks.openPaths.length = 0;
    fsHooks.parsedOpens = 0;

    // One inspection asks this way: every provider's `checkAuth` and
    // `getAvailable`, all at once, for the same document.
    await Promise.all([
      store.read("openai-codex"),
      store.read("anthropic"),
      store.list(),
      store.read("openai-codex"),
    ]);
    expect(fsHooks.openPaths.filter((path) => path === authPath)).toHaveLength(1);
    expect(fsHooks.parsedOpens).toBe(1);

    // The next burst opens the file again to see whether it is still the one
    // held, and serves the parse rather than parsing anew.
    await store.read("anthropic");
    expect(fsHooks.openPaths.filter((path) => path === authPath)).toHaveLength(2);
    expect(fsHooks.parsedOpens).toBe(1);
  });

  it("drops the held parse when the file changes underneath it", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH }));
    const authPath = join(dir, "auth.json");
    const store = storeIn(dir);
    await expect(store.read("openai-codex")).resolves.toEqual(OAUTH);

    // The `pi` CLI's own write: bytes and mtime both move. The mtime is set
    // explicitly so the read cannot be a cache miss by filesystem accident on
    // a filesystem with coarser timestamps than this test's clock.
    writeFileSync(
      authPath,
      JSON.stringify({ "openai-codex": { ...OAUTH, access: "pi-refreshed" } }),
      "utf8",
    );
    const moved = new Date(Date.now() + 1_000);
    utimesSync(authPath, moved, moved);

    await expect(store.read("openai-codex")).resolves.toMatchObject({ access: "pi-refreshed" });
  });

  it("never serves a credential it read before its own write", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH }));
    const authPath = join(dir, "auth.json");
    const store = storeIn(dir);
    await expect(store.read("openai-codex")).resolves.toEqual(OAUTH);

    // Pin the mtime every opened handle reports to the one the hold already
    // carries, so only this store's own invalidation can make the write
    // visible — the case a filesystem too coarse to move the mtime on a
    // rewrite is.
    fsHooks.fstatMtimeMs = statSync(authPath).mtimeMs;

    await store.modify("openai-codex", async () => ({ ...OAUTH, access: "rotated" }) as const);
    await expect(store.read("openai-codex")).resolves.toMatchObject({ access: "rotated" });
  });

  it("never holds the parse of a read a write overtook", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH }));
    const authPath = join(dir, "auth.json");
    const store = storeIn(dir);
    // Pin every handle's mtime to the one the file has now, so the mtime alone
    // can never tell the pre-write bytes from the post-write ones. That is the
    // coarse-timestamp filesystem, and it is what leaves the write's own end
    // of the hold as the only thing standing between a later reader and the
    // past.
    fsHooks.fstatMtimeMs = statSync(authPath).mtimeMs;

    // A read opens the file, and is still reading it when the write lands.
    const release = Promise.withResolvers<void>();
    fsHooks.stalls.push(release.promise);
    const overtaken = store.read("openai-codex");
    await store.modify("openai-codex", async () => ({ ...OAUTH, access: "rotated" }) as const);

    // It answers with what the file said when it asked, which is honest...
    release.resolve();
    await expect(overtaken).resolves.toMatchObject({ access: "access-token" });

    // ...but it must not have left that behind for the next reader, who asked
    // after the write and is owed what the write put there.
    await expect(store.read("openai-codex")).resolves.toMatchObject({ access: "rotated" });
  });

  it("does not join a shared pass that a write has already overtaken", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH }));
    const store = storeIn(dir);

    const release = Promise.withResolvers<void>();
    fsHooks.stalls.push(release.promise);
    const overtaken = store.read("openai-codex");
    await store.modify("openai-codex", async () => ({ ...OAUTH, access: "rotated" }) as const);

    // This reader arrives after the write and while the earlier pass is still
    // out. Joining that pass would hand it the credential the write replaced,
    // so it must start a pass of its own.
    const after = store.read("openai-codex");
    release.resolve();
    await expect(overtaken).resolves.toMatchObject({ access: "access-token" });
    await expect(after).resolves.toMatchObject({ access: "rotated" });
  });

  it("lets an overtaken pass settle without emptying the pass that replaced it", async () => {
    const dir = agentDirWith(JSON.stringify({ "openai-codex": OAUTH }));
    const authPath = join(dir, "auth.json");
    const store = storeIn(dir);

    // Two passes out at once: the one a write overtook, and the one a reader
    // arriving after that write started.
    const releaseOvertaken = Promise.withResolvers<void>();
    const releaseCurrent = Promise.withResolvers<void>();
    fsHooks.stalls.push(releaseOvertaken.promise);
    const overtaken = store.read("openai-codex");
    // The write's own read is deliberately not held: it happens under the
    // lock, and holding it would just stall the write.
    await store.modify("openai-codex", async () => ({ ...OAUTH, access: "rotated" }) as const);
    fsHooks.stalls.push(releaseCurrent.promise);
    const current = store.read("openai-codex");

    // The overtaken one settles first. Its slot is not the current one's, so
    // emptying it must not send the reader below to the file again.
    releaseOvertaken.resolve();
    await expect(overtaken).resolves.toMatchObject({ access: "access-token" });
    fsHooks.openPaths.length = 0;
    const joined = store.read("openai-codex");

    releaseCurrent.resolve();
    await expect(current).resolves.toMatchObject({ access: "rotated" });
    await expect(joined).resolves.toMatchObject({ access: "rotated" });
    expect(fsHooks.openPaths.filter((path) => path === authPath)).toHaveLength(0);
  });

  it("reads again after a failed pass rather than repeating it", async () => {
    const dir = agentDirWith('{"openai-codex": {"access": "sk-live-secret');
    const store = storeIn(dir);
    await expect(store.read("openai-codex")).rejects.toThrow(/unreadable/);

    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": OAUTH }), "utf8");
    await expect(store.read("openai-codex")).resolves.toEqual(OAUTH);
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

  it("reports a credential-file initialization failure by path", async () => {
    const dir = join(scratch(), "read-only-agent");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);

    await expect(storeIn(dir).modify("openai-codex", async () => OAUTH)).rejects.toThrow(
      /Could not initialize Pi credentials/,
    );

    chmodSync(dir, 0o700);
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

  it("reports an acquisition failure without exposing lock internals", async () => {
    vi.spyOn(lockfile, "lock").mockRejectedValueOnce(
      Object.assign(new Error("lock detail"), { code: 7 }),
    );
    const dir = agentDirWith("{}");

    await expect(storeIn(dir).modify("openai-codex", async () => OAUTH)).rejects.toThrow(
      /Could not lock Pi credentials/,
    );
  });

  it("stops before mutation when the acquired lock is already compromised", async () => {
    const compromised = new Error("lock compromised");
    vi.spyOn(lockfile, "lock").mockImplementationOnce(async (_path, options) => {
      options?.onCompromised?.(compromised);
      return async () => undefined;
    });
    const modify = vi.fn(async () => OAUTH);

    await expect(storeIn(agentDirWith("{}")).modify("openai-codex", modify)).rejects.toThrow(
      compromised,
    );
    expect(modify).not.toHaveBeenCalled();
  });

  it("rejects a mutation if the lock becomes compromised while it runs", async () => {
    let compromise: ((error: Error) => unknown) | undefined;
    vi.spyOn(lockfile, "lock").mockImplementationOnce(async (_path, options) => {
      compromise = options?.onCompromised;
      return async () => Promise.reject(new Error("unlock follows compromise"));
    });
    const compromised = new Error("lock compromised");

    await expect(
      storeIn(agentDirWith("{}")).modify("openai-codex", async () => {
        compromise?.(compromised);
        return OAUTH;
      }),
    ).rejects.toThrow(compromised);
  });

  it("reports a lock that remains busy past Pi's stale deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_001);
    vi.spyOn(lockfile, "lock").mockRejectedValueOnce(
      Object.assign(new Error("still locked"), { code: "ELOCKED" }),
    );

    await expect(
      storeIn(agentDirWith("{}")).modify("openai-codex", async () => OAUTH),
    ).rejects.toThrow(/Could not lock Pi credentials/);
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

describe("piModelsFilePath", () => {
  it("keeps the catalog cache beside Pi's auth.json, under the same profile rules", () => {
    expect(piModelsFilePath({ agentDir: "/explicit/agent" })).toBe(
      "/explicit/agent/volli-models.json",
    );
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    expect(piModelsFilePath()).toBe("/env/agent/volli-models.json");
  });
});

describe("piOwnedModels", () => {
  it("drops a cached addition with no current admission proof before catalogReady resolves", async () => {
    const agentDir = agentDirWith("{}");
    const first = piOwnedModelAccess({ agentDir });
    await first.catalogReady;
    const sibling = first.models.getModel("opencode-go", "glm-5.3");
    expect(sibling).toBeDefined();
    if (sibling === undefined) return;
    // The id has to be one Pi's own catalog does not carry, or the restore is
    // entitled to rebase it onto the baseline entry and this asserts nothing.
    //
    // It used to be `glm-5.3-flash`, which pi 0.85.0 promoted into the
    // `opencode-go` baseline — measured: that provider's baseline went from 23
    // models to 27 across the bump, and `glm-5.3-flash` is one of the four.
    // The test then failed correctly, because a cached entry whose id IS in the
    // baseline needs no admission proof: `restoreStoredCatalog` rebases it and
    // keeps only its facts. Renamed rather than deleted, because what it pins
    // is still true and still worth pinning (VC-254).
    const added = {
      ...sibling,
      id: "volli-test-absent-from-every-catalog",
      name: "Persisted after restart",
    };
    await new PiFileModelsStore(piModelsFilePath({ agentDir })).write("opencode-go", {
      models: [added],
      checkedAt: 1,
    });

    const restarted = piOwnedModelAccess({ agentDir });
    await restarted.catalogReady;

    expect(restarted.models.getModel("opencode-go", added.id)).toBeUndefined();
  });

  it("surfaces catalog restoration failures without provider error details", async () => {
    const access = piOwnedModelAccess({ agentDir: agentDirWith("{ secret-ish malformed auth") });
    const failure = await access.catalogReady.catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) return;
    expect(failure.message).toMatch(/Could not restore model catalogs for:/);
    expect(failure.message).not.toContain("secret-ish");
  });

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

  it("gives every built-in provider a refreshable catalog", () => {
    // The premise of VC-135: pi ships its catalogs frozen and only radius
    // implements `refreshModels`, so without the wrapping the Refresh button
    // re-reads the same static lists forever. Every provider — static ones
    // wrapped, dynamic ones on their own contract — must now answer it.
    const models = piOwnedModels({ agentDir: agentDirWith("{}") });
    const providers = models.getProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider.refreshModels, provider.id).toBeDefined();
    }
  });

  it("is what a runtime built without an injected collection uses", async () => {
    const dir = agentDirWith("{}");
    process.env.PI_CODING_AGENT_DIR = dir;
    const runtime = createPiAgentRuntime({ sessionDataDir: scratch() });
    // No credential for the pinned provider, so the attach reports the
    // configuration it could not satisfy rather than starting a turn.
    await expect(
      runtime.startSession({
        identity: {
          role: "ticket",
          sessionId: "s",
          rootThreadId: "t",
          attachmentId: "a",
          projectId: "p",
          ticketId: "k",
        },
        workspacePath: scratch(),
        venue: "local",
        model: { providerId: "openai-codex", modelId: "not-a-model", reasoningLevel: "off" },
        authority: {
          mode: "auto",
          location: "worktree",
          enforcement: "enforce",
          judgmentMode: "ask",
          tools: [],
          rulePackId: BUILTIN_RULE_PACK_ID,
          rulePackHash: BUILTIN_RULE_PACK_HASH,
          classifierModel: null,
          fallback: { consecutiveDenials: 3, sessionDenials: 20 },
        },
        brief: { text: "brief" },
        tools: { tools: [] },
        observer: async () => undefined,
      }),
    ).rejects.toThrow(/is not available/);
  });
});
