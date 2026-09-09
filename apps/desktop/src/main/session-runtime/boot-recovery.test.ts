import type { SessionObservation } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  closeStaleAttachments,
  type BootRecoveryAttachment,
  type BootRecoveryEngine,
  type BootRecoverySession,
} from "./boot-recovery";

function attachment(overrides: Partial<BootRecoveryAttachment> = {}): BootRecoveryAttachment {
  return {
    id: "attachment-1",
    adapterId: "terminal",
    venue: { id: "local", kind: "local" },
    status: "open",
    ...overrides,
  };
}

function session(
  id: string,
  attachments: readonly BootRecoveryAttachment[],
  turnActive = false,
): BootRecoverySession {
  return { session: { id }, attachments, turnActive };
}

interface Recorder {
  engine: BootRecoveryEngine;
  observed: SessionObservation[];
  reconciled: Array<{ sessionId: string; attachmentId: string }>;
  reconcile(input: { sessionId: string; attachmentId: string }): Promise<void>;
}

function recorder(
  byProject: Record<string, readonly BootRecoverySession[]>,
  observe?: (observation: SessionObservation) => Promise<void>,
  reconcile?: (input: { sessionId: string; attachmentId: string }) => Promise<void>,
): Recorder {
  const observed: SessionObservation[] = [];
  const reconciled: Array<{ sessionId: string; attachmentId: string }> = [];
  return {
    observed,
    reconciled,
    reconcile: async (input) => {
      reconciled.push(input);
      await reconcile?.(input);
    },
    engine: {
      listSessions: async ({ projectId }) => byProject[projectId] ?? [],
      observe: async (observation) => {
        observed.push(observation);
        if (observe) await observe(observation);
      },
    },
  };
}

function sweep(
  target: Recorder,
  projectIds: readonly string[],
  onError = vi.fn(),
): { run: Promise<number>; onError: ReturnType<typeof vi.fn> } {
  let sequence = 0;
  return {
    onError,
    run: closeStaleAttachments({
      engine: target.engine,
      reconcile: target.reconcile,
      projectIds,
      newId: () => `event-${++sequence}`,
      now: () => 1_700_000_000_000,
      onError,
    }),
  };
}

describe("closeStaleAttachments", () => {
  it("closes a stale local terminal attachment as an interrupted, system-provenanced fact", async () => {
    const target = recorder({ "project-1": [session("session-1", [attachment()], true)] });

    await expect(sweep(target, ["project-1"]).run).resolves.toBe(1);
    expect(target.observed).toEqual([
      {
        id: "event-1",
        kind: "attention.raised",
        sessionId: "session-1",
        attachmentId: "attachment-1",
        occurredAt: 1_700_000_000_000,
        provenance: {
          source: { kind: "system", id: "desktop-recovery", detail: null },
          venue: { id: "local", kind: "local" },
        },
        attention: {
          id: "attachment-1:boot-recovery",
          attachmentId: "attachment-1",
          kind: "partial_turn_interrupted",
          detail: "The prior desktop process ended while this turn was active.",
          diagnostic: null,
        },
      },
      {
        id: "event-2",
        kind: "attachment.closed",
        sessionId: "session-1",
        attachmentId: "attachment-1",
        occurredAt: 1_700_000_000_000,
        provenance: {
          source: { kind: "system", id: "desktop-recovery", detail: null },
          venue: { id: "local", kind: "local" },
        },
        outcome: "interrupted",
      },
    ]);
  });

  // Nothing can answer for a departed runtime's native identity again: left
  // open, it projects live forever and a lazy rehydration refuses it instead of
  // reconnecting. The rule is the adapter id, not a list of names — a build
  // that retires another executor gets the same sweep without editing it.
  it("retires an open attachment of any runtime this build no longer hosts", async () => {
    const target = recorder({
      "project-1": [
        session("session-1", [
          attachment({ id: "opencode-1", adapterId: "opencode" }),
          attachment({ id: "retired-1", adapterId: "some-future-retiree" }),
        ]),
      ],
    });

    await expect(sweep(target, ["project-1"]).run).resolves.toBe(2);
    expect(target.observed).toMatchObject([
      { attachmentId: "opencode-1", kind: "attachment.closed", outcome: "interrupted" },
      { attachmentId: "retired-1", kind: "attachment.closed", outcome: "interrupted" },
    ]);
  });

  it("leaves a quiet structured executor alone for lazy recovery", async () => {
    const target = recorder({
      "project-1": [session("session-1", [attachment({ id: "pi-1", adapterId: "pi" })])],
    });

    await expect(sweep(target, ["project-1"]).run).resolves.toBe(0);
    expect(target.observed).toEqual([]);
    expect(target.reconciled).toEqual([]);
  });

  it("eagerly reconciles a structured turn left active by the prior process", async () => {
    const target = recorder({
      "project-1": [session("session-1", [attachment({ id: "pi-1", adapterId: "pi" })], true)],
    });

    await expect(sweep(target, ["project-1"]).run).resolves.toBe(0);
    expect(target.reconciled).toEqual([{ sessionId: "session-1", attachmentId: "pi-1" }]);
    expect(target.observed).toEqual([]);
  });

  it("closes a structured turn as interrupted when it cannot be rehydrated", async () => {
    const target = recorder(
      {
        "project-1": [session("session-1", [attachment({ id: "pi-1", adapterId: "pi" })], true)],
      },
      undefined,
      async () => Promise.reject(new Error("sidecar missing")),
    );
    const onError = vi.fn();

    await expect(sweep(target, ["project-1"], onError).run).resolves.toBe(1);
    expect(onError).toHaveBeenCalledWith("pi-1", expect.any(Error));
    expect(target.observed).toMatchObject([
      {
        attachmentId: "pi-1",
        kind: "attention.raised",
        attention: { kind: "partial_turn_interrupted" },
      },
      { attachmentId: "pi-1", kind: "attachment.closed", outcome: "interrupted" },
    ]);
  });

  it("still closes a failed recovery when recording its Attention also fails", async () => {
    const target = recorder(
      {
        "project-1": [session("session-1", [attachment({ id: "pi-1", adapterId: "pi" })], true)],
      },
      async (observation) => {
        if (observation.kind === "attention.raised") throw new Error("attention write failed");
      },
      async () => Promise.reject(new Error("sidecar missing")),
    );
    const onError = vi.fn();

    await expect(sweep(target, ["project-1"], onError).run).resolves.toBe(1);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(target.observed.at(-1)).toMatchObject({
      attachmentId: "pi-1",
      kind: "attachment.closed",
      outcome: "interrupted",
    });
  });

  it("leaves an attachment that is not an open local one alone", async () => {
    const target = recorder({
      "project-1": [
        session("session-1", [
          attachment({ id: "closed-1", status: "closed" }),
          attachment({ id: "failed-1", status: "failed" }),
          attachment({ id: "cloud-1", venue: { id: "sandbox", kind: "cloud" } }),
        ]),
      ],
    });

    await expect(sweep(target, ["project-1"]).run).resolves.toBe(0);
    expect(target.observed).toEqual([]);
  });

  it("sweeps every project and every session it was given", async () => {
    const target = recorder({
      "project-1": [
        session("session-1", [attachment({ id: "a" })]),
        session("session-2", [attachment({ id: "b", adapterId: "opencode" })]),
      ],
      "project-2": [session("session-3", [attachment({ id: "c" })])],
    });

    await expect(sweep(target, ["project-1", "project-2"]).run).resolves.toBe(3);
    expect(target.observed.map((observation) => observation.id)).toEqual([
      "event-1",
      "event-2",
      "event-3",
    ]);
  });

  it("answers with nothing for a project that has no sessions", async () => {
    const target = recorder({});

    await expect(sweep(target, ["project-empty"]).run).resolves.toBe(0);
  });

  // One malformed or concurrently-closed attachment must not leave every later
  // stale one falsely open after relaunch.
  it("reports a refused close and keeps sweeping", async () => {
    const target = recorder(
      {
        "project-1": [
          session("session-1", [
            attachment({ id: "broken" }),
            attachment({ id: "fine", adapterId: "opencode" }),
          ]),
        ],
      },
      async (observation) => {
        if (observation.kind === "attachment.closed" && observation.attachmentId === "broken") {
          throw new Error("already closed");
        }
      },
    );
    const onError = vi.fn();

    await expect(sweep(target, ["project-1"], onError).run).resolves.toBe(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBe("broken");
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error);
  });
});
