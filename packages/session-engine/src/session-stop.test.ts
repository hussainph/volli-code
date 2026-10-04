import { describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { SessionAttachmentProjection, SessionProjection } from "@volli/shared";
import {
  stopSessionById,
  stopResolvedSession,
  SuperviseSessionError,
  type StopSessionByIdPorts,
} from "./session-stop";
const TARGET = "bbbbbbbb-0000-0000-0000-000000000000";

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: TARGET,
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Implementer",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    resumptions: [],
    latestTurnId: null,
    latestTurnOrigin: null,
    resumedAfterStop: false,
    receipts: [],
    pendingExecutorStart: null,
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    modelSelection: null,
    modelTier: null,
    turnActive: false,
    lastTurnOutcome: null,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 1,
    bornTicketless: true,
    ...overrides,
  };
}

function openAttachment(
  overrides: Partial<SessionAttachmentProjection> = {},
): SessionAttachmentProjection {
  return {
    id: "attachment-1",
    sessionId: TARGET,
    adapterId: "pi",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: null,
    authority: null,
    status: "open",
    exitCode: null,
    openedAt: 1,
    closedAt: null,
    outcome: null,
    failure: null,
    ...overrides,
  };
}

/** The person's door: the target is read by id, never listed. */
function byIdPorts(
  snapshots: SessionProjection[],
  overrides: Partial<{ submit: ReturnType<typeof vi.fn>; command: ReturnType<typeof vi.fn> }> = {},
): {
  ports: StopSessionByIdPorts;
  submit: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
} {
  const submit = overrides.submit ?? vi.fn(async () => ({ receipt: { status: "completed" } }));
  const command = overrides.command ?? vi.fn(async () => ({ receipt: { status: "accepted" } }));
  return {
    ports: {
      sessionEngine: {
        getSession: vi.fn(
          async ({ sessionId }: { sessionId: string }) =>
            snapshots.find((one) => one.session.id === sessionId) ?? null,
        ),
        submit,
      } as unknown as StopSessionByIdPorts["sessionEngine"],
      runtime: { command } as unknown as StopSessionByIdPorts["runtime"],
    },
    submit,
    command,
  };
}

describe("stopSessionById", () => {
  it("records the stop with the user as actor, then interrupts and releases", async () => {
    const {
      ports: p,
      submit,
      command,
    } = byIdPorts([projection({ attachments: [openAttachment()], turnActive: true })]);

    const outcome = await stopSessionById(p, {
      operationId: "op-user",
      sessionId: TARGET,
      reason: "Runaway",
    });

    expect(submit).toHaveBeenCalledWith({
      commandId: "op-user",
      sessionId: TARGET,
      intent: { kind: "session.stop", reason: "Runaway", by: { kind: "user" } },
      provenance: {
        source: { kind: "user", id: "renderer", detail: { sessionOrigin: { kind: "user" } } },
        venue: { id: "local", kind: "local" },
      },
    });
    expect(command.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        commandId: "op-user:interrupt",
        sessionId: TARGET,
        command: { kind: "executor.interrupt", attachmentId: "attachment-1" },
      }),
      expect.objectContaining({
        commandId: "op-user:release",
        sessionId: TARGET,
        command: { kind: "adapter.release", attachmentId: "attachment-1" },
      }),
    ]);
    expect(outcome).toMatchObject({
      sessionId: TARGET,
      title: "Implementer",
      previouslyStopped: false,
      interrupted: true,
      released: true,
      failures: [],
    });
  });

  it("re-reads the target by id after the durable write, and reports a failed act", async () => {
    const snapshots = [projection({ attachments: [openAttachment()] })];
    const command = vi.fn(async (request: { command: { kind: string } }) => {
      if (request.command.kind === "adapter.release") throw new Error("executor is gone");
      return { receipt: { status: "accepted" } };
    });
    const submit = vi.fn(async () => {
      snapshots.splice(
        0,
        1,
        projection({
          stopped: { at: 5, reason: null, by: { kind: "user" } },
          attachments: [openAttachment()],
          turnActive: true,
        }),
      );
      return { receipt: { status: "completed" } };
    });
    const { ports: p } = byIdPorts(snapshots, { submit, command });

    const outcome = await stopSessionById(p, { operationId: "op-user", sessionId: TARGET });

    expect(outcome).toMatchObject({
      interrupted: true,
      released: false,
      failures: ["The executor did not release: executor is gone."],
    });
  });

  it("refuses an unknown id, a terminal session, and an unrecorded stop, by name", async () => {
    await expect(
      stopSessionById(byIdPorts([]).ports, { operationId: "op", sessionId: TARGET }),
    ).rejects.toThrow(new SuperviseSessionError("Unknown session."));

    const terminal = projection({
      attachments: [openAttachment({ adapterId: "terminal" })],
    });
    await expect(
      stopSessionById(byIdPorts([terminal]).ports, { operationId: "op", sessionId: TARGET }),
    ).rejects.toThrow(/terminal session/);

    const refused = byIdPorts([projection({ attachments: [openAttachment()] })], {
      submit: vi.fn(async () => ({ receipt: { status: "rejected" } })),
    });
    await expect(
      stopSessionById(refused.ports, { operationId: "op", sessionId: TARGET }),
    ).rejects.toThrow(
      new SuperviseSessionError(
        `Session ${TARGET.slice(0, 8)} could not be durably recorded as stopped.`,
      ),
    );
    expect(refused.command).not.toHaveBeenCalled();
  });

  // Fix-first (review c5714a22): a not-live target — no open structured
  // attachment, so nothing for the runtime acts to touch — must be refused by
  // name rather than durably recorded as a quiet no-op success. This is the
  // "already-idle/done child" case the island's stop button races against.
  it("refuses a target with no open attachment as not live, and writes nothing", async () => {
    const notLive = byIdPorts([projection()]);
    await expect(
      stopSessionById(notLive.ports, { operationId: "op", sessionId: TARGET }),
    ).rejects.toThrow(
      new SuperviseSessionError(
        `Session ${TARGET.slice(0, 8)} is not live; there is nothing running to stop.`,
      ),
    );
    expect(notLive.submit).not.toHaveBeenCalled();
    expect(notLive.command).not.toHaveBeenCalled();

    const closed = byIdPorts([
      projection({ attachments: [openAttachment({ status: "closed", closedAt: 9 })] }),
    ]);
    await expect(
      stopSessionById(closed.ports, { operationId: "op", sessionId: TARGET }),
    ).rejects.toThrow(/is not live/);
    expect(closed.submit).not.toHaveBeenCalled();
  });

  // A previously-recorded stop with its attachment still open is a legitimate
  // retry of the runtime release (VC-86) — "live" is about the attachment, not
  // about `stopped`, so this must not be refused.
  it("does not refuse a retry of a previously-stopped, still-live target", async () => {
    const retry = byIdPorts([
      projection({
        stopped: { at: 5, reason: null, by: { kind: "user" } },
        attachments: [openAttachment()],
        turnActive: true,
      }),
    ]);
    await expect(
      stopSessionById(retry.ports, { operationId: "op", sessionId: TARGET }),
    ).resolves.toMatchObject({ previouslyStopped: true, interrupted: true, released: true });
    expect(retry.submit).not.toHaveBeenCalled();
  });
});

describe("shared stop acts", () => {
  const acts = {
    operationId: "op",
    by: { kind: "session" as const, sessionId: "caller" },
    reason: null,
    name: "Helper",
    provenance: { kind: "system" as const, id: "test", detail: null },
  };

  it("preserves session attribution and uses the latest attachment, or none after commit", async () => {
    const target = projection({ attachments: [openAttachment()] });
    const { ports: p, command } = byIdPorts([target]);
    const fresh = projection({ attachments: [openAttachment({ id: "new" })], turnActive: true });
    expect(await stopResolvedSession(p, target, async () => fresh, acts)).toMatchObject({
      interrupted: true,
      released: true,
    });
    expect(command).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        origin: { kind: "session", sessionId: "caller" },
        command: { kind: "executor.interrupt", attachmentId: "new" },
      }),
    );
    expect(command).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ origin: { kind: "session", sessionId: "caller" } }),
    );
    expect(await stopResolvedSession(p, target, async () => projection(), acts)).toMatchObject({
      interrupted: false,
      released: false,
    });
    expect(await stopResolvedSession(p, target, async () => target, acts)).toMatchObject({
      interrupted: false,
      released: true,
    });
  });

  it("reports every non-accepted runtime receipt and handles completed receipts", async () => {
    const target = projection({ attachments: [openAttachment()], turnActive: true });
    const cases = [
      [null, "the runtime returned no delivery receipt"],
      [{ status: "rejected", code: "gone", detail: null }, "the runtime rejected it (gone)"],
      [
        { status: "rejected", code: "gone", detail: "exited" },
        "the runtime rejected it (gone): exited",
      ],
      [{ status: "unreconciled", detail: null }, "delivery is unreconciled"],
      [{ status: "unreconciled", detail: "pending" }, "delivery is unreconciled: pending"],
    ] as const;
    for (const [receipt, message] of cases) {
      const { ports: p } = byIdPorts([target], { command: vi.fn(async () => ({ receipt })) });
      expect((await stopSessionById(p, { operationId: "op", sessionId: TARGET })).failures).toEqual(
        [
          `The active turn did not interrupt: ${message}.`,
          `The executor did not release: ${message}.`,
        ],
      );
    }
    const { ports: p } = byIdPorts([target], {
      command: vi.fn(async () => ({ receipt: { status: "completed" } })),
    });
    expect(await stopSessionById(p, { operationId: "op", sessionId: TARGET })).toMatchObject({
      interrupted: true,
      released: true,
    });
  });

  it("reports thrown runtime failures, including non-Error values", async () => {
    const target = projection({ attachments: [openAttachment()], turnActive: true });
    for (const failure of [new Error("gone"), "gone"]) {
      const { ports: p } = byIdPorts([target], {
        command: vi.fn(async () => {
          throw failure;
        }),
      });
      expect((await stopSessionById(p, { operationId: "op", sessionId: TARGET })).failures).toEqual(
        ["The active turn did not interrupt: gone.", "The executor did not release: gone."],
      );
    }
  });

  it("requires a completed durable receipt before touching the runtime", async () => {
    const target = projection({ attachments: [openAttachment()] });
    const { ports: p, command } = byIdPorts([target], {
      submit: vi.fn(async () => ({ receipt: null })),
    });
    await expect(stopSessionById(p, { operationId: "op", sessionId: TARGET })).rejects.toThrow(
      "could not be durably recorded",
    );
    expect(command).not.toHaveBeenCalled();
  });
});
