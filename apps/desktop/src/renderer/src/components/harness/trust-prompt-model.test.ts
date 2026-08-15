import { describe, expect, it, vi } from "vite-plus/test";

import type {
  BrokenHarnessManifest,
  HarnessPendingResult,
  PendingHarnessManifest,
  Result,
} from "../../../../ipc/contract";

import {
  brokenHarnessMessage,
  harnessCommandLine,
  loadPendingHarnesses,
  recordTrustVerdict,
  type HarnessTrustApi,
} from "./trust-prompt-model";

function waiting(overrides: Partial<PendingHarnessManifest> = {}): PendingHarnessManifest {
  return {
    slug: "my-harness",
    label: "My Harness",
    binaryPath: "/opt/homebrew/bin/my-harness",
    argv: ["/opt/homebrew/bin/my-harness", "--hook", "/tmp/volli.sock"],
    claimedEvents: ["input.needed"],
    manifestPath: "/Users/me/.agents/harnesses/my-harness/harness.json",
    manifestSha256: "a1",
    ...overrides,
  };
}

/** An api whose `pending` answers each queued result in turn. */
function api(input: {
  pending?: HarnessPendingResult[];
  setTrust?: () => Promise<Result>;
}): HarnessTrustApi & { calls: unknown[] } {
  const answers = [...(input.pending ?? [])];
  const calls: unknown[] = [];
  return {
    calls,
    pending: () => Promise.resolve(answers.shift() ?? { ok: true, broken: [], pending: [] }),
    setTrust: (verdict) => {
      calls.push(verdict);
      return (input.setTrust ?? (() => Promise.resolve({ ok: true } as Result)))();
    },
  };
}

describe("harnessCommandLine", () => {
  it("renders the exact argv as one line, a word that needs quoting quoted", () => {
    expect(
      harnessCommandLine(
        waiting({ argv: ["/opt/homebrew/bin/my-harness", "--settings", '{"a": 1}'] }),
      ),
    ).toBe(`/opt/homebrew/bin/my-harness --settings '{"a": 1}'`);
  });

  it("leaves a plain word alone, so the common line reads as it was typed", () => {
    expect(harnessCommandLine(waiting())).toBe(
      "/opt/homebrew/bin/my-harness --hook /tmp/volli.sock",
    );
  });
});

function broken(overrides: Partial<BrokenHarnessManifest> = {}): BrokenHarnessManifest {
  return {
    slug: "my-harness",
    manifestPath: "/Users/me/.agents/harnesses/my-harness/harness.json",
    errors: [{ path: "command", message: "must be a bare executable name" }],
    ...overrides,
  };
}

describe("brokenHarnessMessage", () => {
  it("names the file and every reason it was refused", () => {
    expect(
      brokenHarnessMessage(
        broken({
          errors: [
            { path: "command", message: "must be a bare executable name" },
            { path: "", message: "must be readable JSON" },
          ],
        }),
      ),
    ).toBe(
      "/Users/me/.agents/harnesses/my-harness/harness.json isn't a valid manifest: " +
        "command must be a bare executable name; must be readable JSON",
    );
  });
});

describe("loadPendingHarnesses", () => {
  it("hands back what is waiting", async () => {
    const queue = await loadPendingHarnesses(
      api({ pending: [{ ok: true, broken: [], pending: [waiting()] }] }),
    );

    expect(queue.pending.map((entry) => entry.slug)).toEqual(["my-harness"]);
    expect(queue.error).toBeNull();
  });

  it("hands back the manifests that could not ask, alongside the ones asking", async () => {
    const queue = await loadPendingHarnesses(
      api({ pending: [{ ok: true, broken: [broken()], pending: [waiting()] }] }),
    );

    expect(queue.broken.map((entry) => entry.slug)).toEqual(["my-harness"]);
    expect(queue.pending).toHaveLength(1);
    expect(queue.error).toBeNull();
  });

  it("surfaces a read that failed rather than reporting an empty queue", async () => {
    const queue = await loadPendingHarnesses(
      api({ pending: [{ ok: false, error: "database is locked" }] }),
    );

    expect(queue.pending).toEqual([]);
    expect(queue.error).toBe("database is locked");
  });

  it("surfaces a call that threw", async () => {
    const queue = await loadPendingHarnesses({
      pending: () => Promise.reject(new Error("the bridge is gone")),
      setTrust: () => Promise.resolve({ ok: true }),
    });

    expect(queue.pending).toEqual([]);
    expect(queue.error).toBe("the bridge is gone");
  });
});

describe("recordTrustVerdict", () => {
  it("files the answer against the bytes the confirmation described", async () => {
    const bridge = api({ pending: [{ ok: true, broken: [], pending: [] }] });

    await recordTrustVerdict(bridge, waiting(), "trusted");

    expect(bridge.calls).toEqual([
      { slug: "my-harness", manifestSha256: "a1", decision: "trusted" },
    ]);
  });

  it("stops asking about a manifest whose answer landed", async () => {
    const queue = await recordTrustVerdict(
      api({ pending: [{ ok: true, broken: [broken()], pending: [] }] }),
      waiting(),
      "blocked",
    );

    expect(queue.pending).toEqual([]);
    // The re-read's broken list rides along unchanged — a verdict on one
    // manifest says nothing about another that still does not parse.
    expect(queue.broken).toHaveLength(1);
    expect(queue.error).toBeNull();
  });

  it("re-asks with the new bytes when the manifest changed under the dialog", async () => {
    const edited = waiting({ manifestSha256: "b2", label: "My Harness (edited)" });
    const queue = await recordTrustVerdict(
      api({
        pending: [{ ok: true, broken: [], pending: [edited] }],
        setTrust: () =>
          Promise.resolve({
            ok: false,
            error: "my-harness changed on disk, so it needs confirming again.",
          }),
      }),
      waiting(),
      "trusted",
    );

    expect(queue.error).toBe("my-harness changed on disk, so it needs confirming again.");
    expect(queue.pending.map((entry) => entry.manifestSha256)).toEqual(["b2"]);
  });

  it("surfaces a write that threw, and still re-reads what is waiting", async () => {
    const bridge = api({ pending: [{ ok: true, broken: [], pending: [waiting()] }] });
    const queue = await recordTrustVerdict(
      { ...bridge, setTrust: () => Promise.reject(new Error("the bridge is gone")) },
      waiting(),
      "trusted",
    );

    expect(queue.error).toBe("the bridge is gone");
    expect(queue.pending).toHaveLength(1);
  });

  it("reports the refusal, not the re-read's own failure, when both go wrong", async () => {
    const queue = await recordTrustVerdict(
      api({
        pending: [{ ok: false, error: "database is locked" }],
        setTrust: () =>
          Promise.resolve({ ok: false, error: "No harness manifest for my-harness." }),
      }),
      waiting(),
      "trusted",
    );

    // The refusal is what the user's click produced; the re-read failing is a
    // second symptom of the same outage and would only bury the first.
    expect(queue.error).toBe("No harness manifest for my-harness.");
  });
});

describe("the round trip", () => {
  it("asks once per manifest — a recorded answer never comes back", async () => {
    const bridge = api({
      pending: [
        {
          ok: true,
          broken: [],
          pending: [waiting(), waiting({ slug: "other", manifestSha256: "c3" })],
        },
        { ok: true, broken: [], pending: [waiting({ slug: "other", manifestSha256: "c3" })] },
        { ok: true, broken: [], pending: [] },
      ],
    });
    const spy = vi.spyOn(bridge, "setTrust");

    const first = await loadPendingHarnesses(bridge);
    const head = first.pending[0];
    if (head === undefined) throw new Error("expected a pending manifest");
    const second = await recordTrustVerdict(bridge, head, "trusted");
    const next = second.pending[0];
    if (next === undefined) throw new Error("expected a second pending manifest");
    const third = await recordTrustVerdict(bridge, next, "trusted");

    expect(spy).toHaveBeenCalledTimes(2);
    expect(third.pending).toEqual([]);
  });
});
