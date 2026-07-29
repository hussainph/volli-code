import { describe, expect, it, vi } from "vite-plus/test";

import type { HarnessPendingResult, PendingHarnessManifest, Result } from "@volli/shared";

import {
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
    pending: () => Promise.resolve(answers.shift() ?? { ok: true, pending: [] }),
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

describe("loadPendingHarnesses", () => {
  it("hands back what is waiting", async () => {
    const queue = await loadPendingHarnesses(
      api({ pending: [{ ok: true, pending: [waiting()] }] }),
    );

    expect(queue.pending.map((entry) => entry.slug)).toEqual(["my-harness"]);
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
    const bridge = api({ pending: [{ ok: true, pending: [] }] });

    await recordTrustVerdict(bridge, waiting(), "trusted");

    expect(bridge.calls).toEqual([
      { slug: "my-harness", manifestSha256: "a1", decision: "trusted" },
    ]);
  });

  it("stops asking about a manifest whose answer landed", async () => {
    const queue = await recordTrustVerdict(
      api({ pending: [{ ok: true, pending: [] }] }),
      waiting(),
      "blocked",
    );

    expect(queue.pending).toEqual([]);
    expect(queue.error).toBeNull();
  });

  it("re-asks with the new bytes when the manifest changed under the dialog", async () => {
    const edited = waiting({ manifestSha256: "b2", label: "My Harness (edited)" });
    const queue = await recordTrustVerdict(
      api({
        pending: [{ ok: true, pending: [edited] }],
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
    const bridge = api({ pending: [{ ok: true, pending: [waiting()] }] });
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
        { ok: true, pending: [waiting(), waiting({ slug: "other", manifestSha256: "c3" })] },
        { ok: true, pending: [waiting({ slug: "other", manifestSha256: "c3" })] },
        { ok: true, pending: [] },
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
