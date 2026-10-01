import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  UtilityCompletionError,
  type ModelAccessDefaults,
  type SessionUsage,
  type UtilityCompletionResult,
} from "@volli/shared";
import { setAppState } from "../db/app-state-repo";
import {
  AUTHORITY_REASON_MAX_CHARS,
  AUTHORITY_REASON_SOURCE_KEY,
  AUTHORITY_REASON_TIMEOUT_MS,
  createAuthorityReason,
  type AuthorityReasonOptions,
} from "./authority-reason";

const UTILITY = { providerId: "fixture", modelId: "small", reasoningLevel: "high" as const };
const INPUT = {
  sessionId: "session-1",
  tool: "bash",
  category: "destructive",
  fallback: "This tool call risks destroying data.",
};
const USAGE: SessionUsage = {
  cause: "utility",
  providerId: UTILITY.providerId,
  modelId: UTILITY.modelId,
  inputTokens: 50,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0001,
  costBasis: "catalog-estimate",
};

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)");
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

function harness(overrides: Partial<AuthorityReasonOptions> = {}) {
  const readModelDefaults = vi.fn((): ModelAccessDefaults => ({
    ...EMPTY_MODEL_ACCESS_DEFAULTS,
    utility: UTILITY,
  }));
  const completeUtility = vi.fn<AuthorityReasonOptions["completeUtility"]>(async () => ({
    text: "This tool may destroy data.",
    usage: null,
  }));
  const recordUsage = vi.fn<AuthorityReasonOptions["recordUsage"]>(async () => {});
  const log = vi.fn();
  const reason = createAuthorityReason({
    db,
    readModelDefaults,
    completeUtility,
    recordUsage,
    log,
    ...overrides,
  });
  return { reason, completeUtility, readModelDefaults, recordUsage, log };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("authority block-reason source", () => {
  it.each([undefined, "utility"])("uses only configured utility for source %s", async (source) => {
    if (source !== undefined)
      setAppState(db, AUTHORITY_REASON_SOURCE_KEY, JSON.stringify(source), 0);
    const h = harness();
    expect(await h.reason(INPUT)).toBe("This tool may destroy data.");
    expect(h.completeUtility).toHaveBeenCalledOnce();
    expect(h.completeUtility).toHaveBeenCalledWith({
      model: { ...UTILITY, reasoningLevel: "off" },
      systemPrompt: expect.stringContaining("Do not judge whether to allow"),
      user: JSON.stringify({ tool: INPUT.tool, category: INPUT.category }),
      maxOutputTokens: 80,
      signal: expect.any(AbortSignal),
    });
    const sent = h.completeUtility.mock.calls[0]![0];
    expect(sent.user).not.toContain(INPUT.sessionId);
    expect(sent.user).not.toContain(INPUT.fallback);
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it("category skips both the defaults read and completion", async () => {
    setAppState(db, AUTHORITY_REASON_SOURCE_KEY, JSON.stringify("category"), 0);
    const h = harness();
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
    expect(h.readModelDefaults).not.toHaveBeenCalled();
    expect(h.completeUtility).not.toHaveBeenCalled();
  });

  it.each(["not-json", '"unknown"', "null", "{}"])(
    "rejects invalid stored source %s",
    async (raw) => {
      setAppState(db, AUTHORITY_REASON_SOURCE_KEY, raw, 0);
      const h = harness();
      expect(await h.reason(INPUT)).toBe(INPUT.fallback);
      expect(h.completeUtility).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to role or session models when utility is unset", async () => {
    const h = harness({
      readModelDefaults: () => ({
        ...EMPTY_MODEL_ACCESS_DEFAULTS,
        global: { providerId: "fixture", modelId: "expensive", reasoningLevel: "high" },
        ticket: { providerId: "fixture", modelId: "expensive", reasoningLevel: "high" },
      }),
    });
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
    expect(h.completeUtility).not.toHaveBeenCalled();
  });

  it("reads settings and utility configuration anew per call", async () => {
    const h = harness();
    await h.reason(INPUT);
    setAppState(db, AUTHORITY_REASON_SOURCE_KEY, JSON.stringify("category"), 1);
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
    setAppState(db, AUTHORITY_REASON_SOURCE_KEY, JSON.stringify("utility"), 2);
    h.readModelDefaults.mockReturnValue({ ...EMPTY_MODEL_ACCESS_DEFAULTS, utility: null });
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
    expect(h.completeUtility).toHaveBeenCalledOnce();
  });

  it("keeps category fallback on configuration read errors", async () => {
    const h = harness({
      readModelDefaults: () => {
        throw new Error("read failed");
      },
    });
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
    expect(h.log).toHaveBeenCalledOnce();
    expect(h.completeUtility).not.toHaveBeenCalled();
  });

  it("keeps category fallback on database read errors", async () => {
    db.exec("DROP TABLE app_state");
    const h = harness();
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
    expect(h.log).toHaveBeenCalledOnce();
  });
});

describe("bounded and redacted wording", () => {
  it.each(["", " \n\t ", "...", "ALLOW", "Approved: proceed", "true", "x".repeat(4_097)])(
    "uses category for unusable output %j",
    async (text) => {
      const h = harness({ completeUtility: async () => ({ text, usage: USAGE }) });
      expect(await h.reason(INPUT)).toBe(INPUT.fallback);
      expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(INPUT.sessionId, USAGE);
    },
  );

  it("bounds long explanations, strips controls, and collapses whitespace", async () => {
    const h = harness({
      completeUtility: async () => ({
        text: '"This\n\u202e call  ' + "risks damage. ".repeat(100) + '"',
        usage: null,
      }),
    });
    const reason = await h.reason(INPUT);
    expect(reason.startsWith("This call risks damage.")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(AUTHORITY_REASON_MAX_CHARS);
    expect(reason).not.toMatch(/[\n\u202e]/);
  });

  it("redacts secrets before bounding the result, including boundary-crossing credentials", async () => {
    const secret = "sk-fixture-super-secret-key";
    const h = harness({
      completeUtility: async () => ({
        text:
          "This call risks " +
          secret +
          "; password='quoted secret'; " +
          "x ".repeat(120) +
          "Bearer ABCDEF01234567890123456789",
        usage: null,
      }),
    });
    const reason = await h.reason(INPUT);
    expect(reason).toContain("[redacted]");
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain("quoted secret");
    expect(reason).not.toContain("ABCDEF");
    expect(reason.length).toBeLessThanOrEqual(AUTHORITY_REASON_MAX_CHARS);
  });

  it("redacts URL userinfo from wording without changing the host or tail", async () => {
    const h = harness({
      completeUtility: async () => ({
        text: "Blocked https://alice:pw12@example.com/a and ftp://bob:p%3Aw@files.example.net/x.",
        usage: null,
      }),
    });
    expect(await h.reason(INPUT)).toBe(
      "Blocked https://[redacted]@example.com/a and ftp://[redacted]@files.example.net/x.",
    );
  });

  it("redacts curl basic and proxy credentials in every flag form", async () => {
    const h = harness({
      completeUtility: async () => ({
        text:
          "Runs curl -u alice:pw1; then -ubob:pw2 with --user=carol:pw3 -U dave:pw4 " +
          '-Ugrace:pw7 --proxy-user eve:pw5 --proxy-user=frank:pw6 and -u "heidi:pw9 x" works.',
        usage: null,
      }),
    });
    expect(await h.reason(INPUT)).toBe(
      "Runs curl -u alice:[redacted]; then -ubob:[redacted] with --user=carol:[redacted] " +
        "-U dave:[redacted] -Ugrace:[redacted] --proxy-user eve:[redacted] " +
        '--proxy-user=frank:[redacted] and -u "heidi:[redacted]" works.',
    );
  });

  it("leaves password-less credentials untouched, bare, quoted, or escaped", async () => {
    const h = harness({
      completeUtility: async () => ({
        text: 'Uses -u alice and -u "bob" plus -u "ali\\"ce" to fetch.',
        usage: null,
      }),
    });
    expect(await h.reason(INPUT)).toBe('Uses -u alice and -u "bob" plus -u "ali\\"ce" to fetch.');
  });

  it("redacts start-of-string, pipe-chained, labelled, and empty-userinfo secrets", async () => {
    const h = harness({
      completeUtility: async () => ({
        text: "-u alice:pw1|grep token=abcdef https://@example.com/x",
        usage: null,
      }),
    });
    expect(await h.reason(INPUT)).toBe(
      "-u alice:[redacted]|grep [redacted] https://[redacted]@example.com/x",
    );
  });

  it("also bounds and redacts the deterministic fallback", async () => {
    const h = harness({ readModelDefaults: () => EMPTY_MODEL_ACCESS_DEFAULTS });
    const reason = await h.reason({
      ...INPUT,
      fallback: "Block sk-fixture-secret " + "x ".repeat(500),
    });
    expect(reason).not.toContain("sk-fixture-secret");
    expect(reason.length).toBeLessThanOrEqual(AUTHORITY_REASON_MAX_CHARS);
    expect(await h.reason({ ...INPUT, fallback: "" })).toContain("blocked");
  });

  it("bounds and redacts the two prompt fields, with no extra caller data", async () => {
    const h = harness();
    await h.reason({
      ...INPUT,
      tool: "bash sk-fixture-secret",
      category: "destructive " + "x ".repeat(1_000),
    });
    const prompt = JSON.parse(h.completeUtility.mock.calls[0]![0].user);
    expect(Object.keys(prompt)).toEqual(["tool", "category"]);
    expect(prompt.tool).not.toContain("sk-fixture-secret");
    expect(prompt.category.length).toBeLessThanOrEqual(128);
  });
});

describe("deadline, cancellation, and metering", () => {
  it.each(["success", "failure"] as const)(
    "returns at 1500ms despite ignored abort; meters late %s",
    async (outcome) => {
      vi.useFakeTimers();
      const pending = deferred<UtilityCompletionResult>();
      const h = harness();
      h.completeUtility.mockReturnValue(pending.promise);
      const answer = h.reason(INPUT);
      const signal = h.completeUtility.mock.calls[0]![0].signal!;
      let settled = false;
      void answer.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(AUTHORITY_REASON_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await answer).toBe(INPUT.fallback);
      expect(signal.aborted).toBe(true);
      expect(h.recordUsage).not.toHaveBeenCalled();
      if (outcome === "success") pending.resolve({ text: "A late explanation.", usage: USAGE });
      else pending.reject(new UtilityCompletionError("late billed failure", USAGE));
      await flush();
      expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(INPUT.sessionId, USAGE);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not call utility for an already-aborted caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const h = harness();
    expect(await h.reason({ ...INPUT, signal: caller.signal })).toBe(INPUT.fallback);
    expect(h.completeUtility).not.toHaveBeenCalled();
  });

  it("returns immediately on caller abort and still meters a late billed rejection", async () => {
    vi.useFakeTimers();
    const pending = deferred<UtilityCompletionResult>();
    const h = harness();
    h.completeUtility.mockReturnValue(pending.promise);
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const answer = h.reason({ ...INPUT, signal: caller.signal });
    caller.abort();
    expect(await answer).toBe(INPUT.fallback);
    expect(h.completeUtility.mock.calls[0]![0].signal!.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    pending.reject(new UtilityCompletionError("aborted but billed", USAGE));
    await flush();
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(INPUT.sessionId, USAGE);
  });

  it("meters successful wording without waiting on a stuck usage writer", async () => {
    vi.useFakeTimers();
    const h = harness({ recordUsage: () => new Promise(() => {}) });
    h.completeUtility.mockResolvedValue({ text: "This call may destroy data.", usage: USAGE });
    expect(await h.reason(INPUT)).toBe("This call may destroy data.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([new Error("network failed"), new UtilityCompletionError("no usage", null)])(
    "uses fallback without fabricating usage for %s",
    async (error) => {
      const h = harness();
      h.completeUtility.mockRejectedValue(error);
      expect(await h.reason(INPUT)).toBe(INPUT.fallback);
      expect(h.recordUsage).not.toHaveBeenCalled();
      expect(h.log).toHaveBeenCalledOnce();
    },
  );

  it("meters a failed completion before returning category", async () => {
    const h = harness();
    h.completeUtility.mockRejectedValue(new UtilityCompletionError("no usable text", USAGE));
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(INPUT.sessionId, USAGE);
  });

  it("catches synchronous completion failures too", async () => {
    const h = harness({
      completeUtility: () => {
        throw new UtilityCompletionError("sync", USAGE);
      },
    });
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
    expect(h.recordUsage).toHaveBeenCalledExactlyOnceWith(INPUT.sessionId, USAGE);
  });

  it("logs failed metering without losing wording", async () => {
    const h = harness({
      recordUsage: async () => {
        throw new Error("ledger failed");
      },
    });
    h.completeUtility.mockResolvedValue({ text: "This call may destroy data.", usage: USAGE });
    expect(await h.reason(INPUT)).toBe("This call may destroy data.");
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining("usage was not recorded"),
      expect.any(Error),
    );
  });

  it("never rejects when the logging sink throws", async () => {
    const h = harness({
      completeUtility: async () => {
        throw new Error("network failed");
      },
      log: () => {
        throw new Error("log failed");
      },
    });
    expect(await h.reason(INPUT)).toBe(INPUT.fallback);
  });
});

describe("default diagnostics sink", () => {
  it("falls back to console.warn when no diagnostics sink is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({ log: undefined });
      h.completeUtility.mockRejectedValue(new Error("network failed"));
      expect(await h.reason(INPUT)).toBe(INPUT.fallback);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("block reason unavailable"),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("survives a throwing default console.warn sink too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console broke");
    });
    try {
      const h = harness({ log: undefined });
      h.completeUtility.mockRejectedValue(new Error("network failed"));
      expect(await h.reason(INPUT)).toBe(INPUT.fallback);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
