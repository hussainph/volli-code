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
  queried: string[];
  reconciled: Array<{ sessionId: string; attachmentId: string }>;
  reconcile(input: { sessionId: string; attachmentId: string }): Promise<void>;
}

/** A promise the test settles at an exact step — no sleeps, no polling. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recorder(
  byProject: Record<string, readonly BootRecoverySession[]>,
  observe?: (observation: SessionObservation) => Promise<void>,
  reconcile?: (input: { sessionId: string; attachmentId: string }) => Promise<void>,
): Recorder {
  const observed: SessionObservation[] = [];
  const queried: string[] = [];
  const reconciled: Array<{ sessionId: string; attachmentId: string }> = [];
  return {
    observed,
    queried,
    reconciled,
    reconcile: async (input) => {
      reconciled.push(input);
      await reconcile?.(input);
    },
    engine: {
      listSessions: async ({ projectId }) => {
        queried.push(projectId);
        return byProject[projectId] ?? [];
      },
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
  shouldStop?: () => boolean,
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
      ...(shouldStop === undefined ? {} : { shouldStop }),
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
          source: {
            kind: "system",
            id: "desktop-recovery",
            detail: { sessionOrigin: { kind: "volli", reason: "relaunch-recovery" } },
          },
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
          source: {
            kind: "system",
            id: "desktop-recovery",
            detail: { sessionOrigin: { kind: "volli", reason: "relaunch-recovery" } },
          },
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

  it("retires only host permission questions parked on the recovered attachment", async () => {
    const lost = session("session-1", [attachment({ id: "pi-1", adapterId: "pi" })], true);
    const target = recorder({
      "project-1": [
        {
          ...lost,
          interactions: {
            active: [
              { id: "budget-ask:lost", attachmentId: "pi-1", kind: "permission" },
              { id: "ask-user:model", attachmentId: "pi-1", kind: "question" },
              { id: "confirm-ask:elsewhere", attachmentId: "pi-2", kind: "permission" },
            ],
          },
        },
      ],
    });
    await expect(sweep(target, ["project-1"]).run).resolves.toBe(0);
    expect(target.observed).toMatchObject([
      { kind: "interaction.cancelled", interactionId: "budget-ask:lost", reason: "abandoned" },
    ]);
    expect(target.observed).toHaveLength(1);
  });

  it("reports a failed permission retirement and keeps recovering", async () => {
    const lost = session("session-1", [attachment({ id: "pi-1", adapterId: "pi" })], true);
    const target = recorder(
      {
        "project-1": [
          {
            ...lost,
            interactions: {
              active: [
                {
                  id: "budget-ask:lost",
                  attachmentId: "pi-1",
                  kind: "permission",
                },
              ],
            },
          },
        ],
      },
      async (event) => {
        if (event.kind === "interaction.cancelled") throw new Error("cannot retire card");
      },
    );
    const { run, onError } = sweep(target, ["project-1"]);
    await run;
    expect(onError).toHaveBeenCalledWith(
      "pi-1",
      expect.objectContaining({ message: "cannot retire card" }),
    );
    expect(target.reconciled).toEqual([{ sessionId: "session-1", attachmentId: "pi-1" }]);
  });

  it.each(["already-interrupted", "failed-reconcile", "closed"])(
    "retires abandoned host permissions after %s",
    async (state) => {
      const lost = session(
        "session-1",
        [
          attachment({
            id: "pi-1",
            adapterId: "pi",
            status: state === "closed" ? "closed" : "open",
          }),
        ],
        state === "failed-reconcile",
      );
      const target = recorder(
        {
          "project-1": [
            {
              ...lost,
              interactions: {
                active: [
                  {
                    id: "budget-ask:lost",
                    attachmentId: "pi-1",
                    kind: "permission",
                  },
                ],
              },
            },
          ],
        },
        undefined,
        async () => {
          throw new Error("sidecar missing");
        },
      );
      await sweep(target, ["project-1"]).run;
      expect(
        target.observed.some(
          (event) =>
            event.kind === "interaction.cancelled" && event.interactionId === "budget-ask:lost",
        ),
      ).toBe(true);
    },
  );

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

  // Verifier note (VC-622 a3): the sweep used to keep sweeping after close.
  // Once the host is closing it must start no new attachment or project work;
  // a1, already in flight, finishes, and everything else waits for next launch.
  it("starts no new attachment or project query once the host is closing", async () => {
    let closing = false;
    const target = recorder(
      {
        "project-1": [
          session("session-1", [attachment({ id: "a1" }), attachment({ id: "a2" })], true),
        ],
        "project-2": [session("session-2", [attachment({ id: "a3" })])],
      },
      async (observation) => {
        if (observation.kind === "attachment.closed" && observation.attachmentId === "a1") {
          closing = true;
        }
      },
    );

    await expect(
      sweep(target, ["project-1", "project-2"], vi.fn(), () => closing).run,
    ).resolves.toBe(1);
    expect(target.queried).toEqual(["project-1"]);
    expect(target.observed.map(({ kind, attachmentId }) => ({ kind, attachmentId }))).toEqual([
      { kind: "attention.raised", attachmentId: "a1" },
      { kind: "attachment.closed", attachmentId: "a1" },
    ]);
  });

  it.each(["permission", "permissions", "attention"])(
    "starts no more durable work after closing during %s retirement",
    async (stage) => {
      const atWrite = deferred();
      const release = deferred();
      let closing = false;
      const lost = session(
        "s",
        [attachment({ adapterId: stage === "attention" ? "terminal" : "pi" })],
        true,
      );
      const target = recorder(
        {
          p: [
            {
              ...lost,
              interactions: {
                active: [
                  { id: "first", attachmentId: "attachment-1", kind: "permission" },
                  ...(stage === "permissions"
                    ? [{ id: "second", attachmentId: "attachment-1", kind: "permission" as const }]
                    : []),
                ],
              },
            },
          ],
        },
        async () => {
          atWrite.resolve();
          await release.promise;
        },
      );
      const { run } = sweep(target, ["p"], vi.fn(), () => closing);
      await atWrite.promise;
      closing = true;
      release.resolve();
      await expect(run).resolves.toBe(0);
      expect(target.observed.map(({ kind }) => kind)).toEqual([
        stage === "attention" ? "attention.raised" : "interaction.cancelled",
      ]);
      expect(target.reconciled).toEqual([]);
    },
  );

  it("answers nothing and queries nothing when the host is already closing", async () => {
    const target = recorder({ "project-1": [session("session-1", [attachment()])] });

    await expect(sweep(target, ["project-1"], vi.fn(), () => true).run).resolves.toBe(0);
    expect(target.queried).toEqual([]);
    expect(target.observed).toEqual([]);
  });

  // A reconcile rejected because the runtime closed is a stop, not a lost
  // sidecar: no failure report, no partial_turn_interrupted, no forced close —
  // the next launch finds the binding and reconciles it.
  it("leaves an in-flight structured turn untouched when closing rejects its reconcile", async () => {
    const parkedAt = deferred();
    const release = deferred();
    let closing = false;
    let parkedCalls = 0;
    const target = recorder(
      { "project-1": [session("session-1", [attachment({ id: "pi-1", adapterId: "pi" })], true)] },
      undefined,
      async () => {
        parkedCalls += 1;
        if (parkedCalls === 1) {
          parkedAt.resolve();
          await release.promise;
        }
      },
    );
    const onError = vi.fn();
    const { run } = sweep(target, ["project-1"], onError, () => closing);
    await parkedAt.promise;
    closing = true;
    release.reject(new Error("runtime closed during shutdown"));
    await expect(run).resolves.toBe(0);

    expect(onError).not.toHaveBeenCalled();
    expect(target.observed).toEqual([]);
    await expect(sweep(target, ["project-1"]).run).resolves.toBe(0);
    expect(target.reconciled).toEqual([
      { sessionId: "session-1", attachmentId: "pi-1" },
      { sessionId: "session-1", attachmentId: "pi-1" },
    ]);
  });

  // Supplying the flag changes nothing about real failures while the host is
  // still up: a failed reconcile is still reported, still records its
  // Attention, and still closes the unusable attachment.
  it("keeps the failure fallback when shouldStop is supplied but not closing", async () => {
    const target = recorder(
      { "project-1": [session("session-1", [attachment({ id: "pi-1", adapterId: "pi" })], true)] },
      undefined,
      async () => Promise.reject(new Error("sidecar missing")),
    );
    const onError = vi.fn();

    await expect(sweep(target, ["project-1"], onError, () => false).run).resolves.toBe(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(target.observed).toMatchObject([
      { kind: "attention.raised", attachmentId: "pi-1" },
      { kind: "attachment.closed", attachmentId: "pi-1" },
    ]);
  });
});

it("recovers only the supplied headless venue, leaving other hosts alone", async () => {
  const venue = { id: "hostd-one", kind: "remote" as const };
  const target = recorder({
    p: [
      session(
        "s",
        [
          attachment({ id: "ours", adapterId: "pi", venue }),
          attachment({ id: "terminal", venue }),
          attachment({ id: "other", adapterId: "pi", venue: { id: "hostd-two", kind: "remote" } }),
          attachment({ id: "desktop", adapterId: "pi" }),
        ],
        true,
      ),
    ],
  });
  await closeStaleAttachments({
    engine: target.engine,
    reconcile: target.reconcile,
    projectIds: ["p"],
    now: () => 100,
    newId: () => "id",
    onError: vi.fn(),
    venue,
  });
  expect(target.reconciled).toEqual([{ sessionId: "s", attachmentId: "ours" }]);
  expect(target.observed).toHaveLength(2);
  expect(
    target.observed.every(
      (event) => event.attachmentId === "terminal" && event.provenance.venue?.id === "hostd-one",
    ),
  ).toBe(true);
});
