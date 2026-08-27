import { describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";
import type { SessionAttachmentProjection, SessionProjection } from "@volli/shared";

import {
  sendSessionMessageOperation,
  stopSessionOperation,
  SuperviseSessionError,
  supervisionMarker,
} from "./supervise-session";
import type { SuperviseSessionPorts } from "./supervise-session";

const CALLER = "aaaaaaaa-0000-0000-0000-000000000000";
const TARGET = "bbbbbbbb-0000-0000-0000-000000000000";

function projection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id: TARGET,
      projectId: "project-1",
      ticketId: null,
      title: "Implementer",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments: [],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    modelSelection: null,
    turnActive: false,
    authorityDenials: 0,
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
    openedAt: 1,
    closedAt: null,
    outcome: null,
    failure: null,
    ...overrides,
  };
}

function ports(
  projections: SessionProjection[],
  overrides: Partial<{
    submit: ReturnType<typeof vi.fn>;
    command: ReturnType<typeof vi.fn>;
  }> = {},
): {
  ports: SuperviseSessionPorts;
  submit: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
} {
  const submit = overrides.submit ?? vi.fn(async () => ({ receipt: { status: "completed" } }));
  const command = overrides.command ?? vi.fn(async () => ({ receipt: { status: "accepted" } }));
  return {
    ports: {
      sessionEngine: {
        listSessions: vi.fn(async () => projections),
        submit,
      } as unknown as SuperviseSessionPorts["sessionEngine"],
      runtime: { command } as unknown as SuperviseSessionPorts["runtime"],
    },
    submit,
    command,
  };
}

function stopInput(overrides: Partial<Parameters<typeof stopSessionOperation>[1]> = {}) {
  return {
    operationId: "op-1",
    callerSessionId: CALLER,
    projectId: "project-1",
    handle: TARGET.slice(0, 8),
    ...overrides,
  };
}

describe("stopSessionOperation", () => {
  it("records the stop with the calling Session as actor, then interrupts and releases", async () => {
    const {
      ports: p,
      submit,
      command,
    } = ports([projection({ attachments: [openAttachment()], turnActive: true })]);

    const outcome = await stopSessionOperation(p, stopInput({ reason: "Wedged for 3h" }));

    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        commandId: "op-1",
        sessionId: TARGET,
        intent: {
          kind: "session.stop",
          reason: "Wedged for 3h",
          by: { kind: "session", sessionId: CALLER },
        },
      }),
    );
    // The durable fact leads; the runtime acts follow it.
    expect(submit.mock.invocationCallOrder[0]).toBeLessThan(command.mock.invocationCallOrder[0]!);
    expect(command).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        commandId: "op-1:interrupt",
        command: { kind: "executor.interrupt", attachmentId: "attachment-1" },
      }),
    );
    expect(command).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commandId: "op-1:release",
        command: { kind: "adapter.release", attachmentId: "attachment-1" },
      }),
    );
    expect(outcome).toMatchObject({
      handle: TARGET.slice(0, 8),
      title: "Implementer",
      interrupted: true,
      released: true,
      failures: [],
    });
  });

  it("skips the interrupt when no turn is open, and both acts when nothing is attached", async () => {
    const idleAttached = ports([projection({ attachments: [openAttachment()] })]);
    await expect(stopSessionOperation(idleAttached.ports, stopInput())).resolves.toMatchObject({
      interrupted: false,
      released: true,
    });
    expect(idleAttached.command).toHaveBeenCalledTimes(1);

    const detached = ports([projection()]);
    await expect(stopSessionOperation(detached.ports, stopInput())).resolves.toMatchObject({
      interrupted: false,
      released: false,
      failures: [],
    });
    expect(detached.command).not.toHaveBeenCalled();
  });

  // "Stopped" with a still-streaming executor is the one lie a supervisor must
  // not be told: the stop fact stands, and the failed act is in the answer.
  it("reports a runtime act that failed instead of hiding it, keeping the stop fact", async () => {
    const command = vi.fn(async (request: { command: { kind: string } }) => {
      if (request.command.kind === "adapter.release") throw new Error("executor is gone");
      return { receipt: { status: "accepted" } };
    });
    const { ports: p, submit } = ports(
      [projection({ attachments: [openAttachment()], turnActive: true })],
      { command },
    );

    const outcome = await stopSessionOperation(p, stopInput());

    expect(submit).toHaveBeenCalledTimes(1);
    expect(outcome.interrupted).toBe(true);
    expect(outcome.released).toBe(false);
    expect(outcome.failures).toEqual(["The executor did not release: executor is gone."]);
  });

  it("uses the fresh projection after recording a stop, catching a turn admitted during commit", async () => {
    const snapshots = [projection()];
    const command = vi.fn(async () => ({ receipt: { status: "accepted" } }));
    const submit = vi.fn(async () => {
      snapshots.splice(
        0,
        1,
        projection({
          stopped: { at: 5, reason: null, by: { kind: "session", sessionId: CALLER } },
          attachments: [openAttachment()],
          turnActive: true,
        }),
      );
      return { receipt: { status: "completed" } };
    });
    const { ports: p } = ports(snapshots, { submit, command });

    const outcome = await stopSessionOperation(p, stopInput());

    expect(command).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ interrupted: true, released: true });
  });

  it("retries a live executor after a prior stop was recorded", async () => {
    const {
      ports: p,
      submit,
      command,
    } = ports([
      projection({
        stopped: { at: 5, reason: null, by: { kind: "session", sessionId: CALLER } },
        attachments: [openAttachment()],
        turnActive: true,
      }),
    ]);

    const outcome = await stopSessionOperation(p, stopInput());

    // The durable stop remains the original fact; this invocation is the
    // retryable executor shutdown it made necessary.
    expect(submit).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ previouslyStopped: true, interrupted: true, released: true });
  });

  it("does not claim rejected runtime commands stopped work", async () => {
    const command = vi.fn(async () => ({
      receipt: { status: "rejected", code: "executor_gone", detail: "the process exited" },
    }));
    const { ports: p } = ports(
      [projection({ attachments: [openAttachment()], turnActive: true })],
      { command },
    );

    const outcome = await stopSessionOperation(p, stopInput());

    expect(outcome).toMatchObject({ interrupted: false, released: false });
    expect(outcome.failures).toEqual([
      "The active turn did not interrupt: the runtime rejected it (executor_gone): the process exited.",
      "The executor did not release: the runtime rejected it (executor_gone): the process exited.",
    ]);
  });

  it("does not release an executor when the durable stop was not confirmed", async () => {
    const submit = vi.fn(async () => ({
      receipt: { status: "rejected", code: "session_closed", detail: null },
    }));
    const { ports: p, command } = ports(
      [projection({ attachments: [openAttachment()], turnActive: true })],
      { submit },
    );

    await expect(stopSessionOperation(p, stopInput())).rejects.toThrow(
      "could not be durably recorded",
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("refuses an unknown handle, an ambiguous handle, self, and a terminal session", async () => {
    const { ports: missing } = ports([]);
    await expect(stopSessionOperation(missing, stopInput())).rejects.toThrow("No session");

    const twin = projection();
    const { ports: ambiguous } = ports([twin, projection()]);
    await expect(stopSessionOperation(ambiguous, stopInput())).rejects.toThrow("ambiguous");

    const { ports: self } = ports([
      projection({
        session: { ...projection().session, id: CALLER },
      }),
    ]);
    await expect(
      stopSessionOperation(self, stopInput({ handle: CALLER.slice(0, 8) })),
    ).rejects.toThrow("this Session");

    const { ports: terminal } = ports([
      projection({ attachments: [openAttachment({ adapterId: "terminal" })] }),
    ]);
    await expect(stopSessionOperation(terminal, stopInput())).rejects.toThrow("terminal session");

    const { ports: blank } = ports([projection()]);
    await expect(stopSessionOperation(blank, stopInput({ handle: "  " }))).rejects.toThrow(
      "short session id",
    );
  });
});

function sendInput(overrides: Partial<Parameters<typeof sendSessionMessageOperation>[1]> = {}) {
  return {
    operationId: "op-2",
    callerSessionId: CALLER,
    projectId: "project-1",
    handle: TARGET.slice(0, 8),
    message: "Use the thinking-orbs library",
    ...overrides,
  };
}

describe("sendSessionMessageOperation", () => {
  it("waits for a marked steer to be accepted before answering", async () => {
    const delivery = Promise.withResolvers<unknown>();
    const command = vi.fn(() => delivery.promise);
    const { ports: p } = ports(
      [projection({ attachments: [openAttachment()], turnActive: true })],
      { command },
    );

    let settled = false;
    const sending = sendSessionMessageOperation(p, sendInput()).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    // Dispatch has begun, but the tool cannot claim delivery until the runtime
    // has returned a durable accepted receipt.
    expect(settled).toBe(false);

    delivery.resolve({ receipt: { status: "accepted" } });
    const outcome = await sending;

    expect(outcome).toMatchObject({ handle: TARGET.slice(0, 8), midTurn: true });
    expect(command).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        commandId: "op-2",
        sessionId: TARGET,
        command: expect.objectContaining({
          kind: "message.submit",
          delivery: "steer",
          message: expect.objectContaining({
            id: "op-2:message",
            role: "user",
            parts: [
              {
                type: "text",
                text: `${supervisionMarker(CALLER)}\n\nUse the thinking-orbs library`,
              },
            ],
          }),
        }),
      }),
    );
  });

  it("surfaces unconfirmed and failed delivery instead of claiming success", async () => {
    const rejected = ports([projection({ attachments: [openAttachment()] })], {
      command: vi.fn(async () => ({
        receipt: { status: "rejected", code: "attachment_closed", detail: "closed mid-flight" },
      })),
    });
    await expect(sendSessionMessageOperation(rejected.ports, sendInput())).rejects.toThrow(
      "could not confirm",
    );

    const noReceipt = ports([projection({ attachments: [openAttachment()] })], {
      command: vi.fn(async () => ({ receipt: null })),
    });
    await expect(sendSessionMessageOperation(noReceipt.ports, sendInput())).rejects.toThrow(
      "returned no delivery receipt",
    );

    const failed = ports([projection({ attachments: [openAttachment()] })], {
      command: vi.fn(async () => Promise.reject(new Error("runtime unavailable"))),
    });
    await expect(sendSessionMessageOperation(failed.ports, sendInput())).rejects.toThrow(
      "runtime unavailable",
    );
  });

  it("refuses a stopped target, a detached target, and an empty message", async () => {
    const { ports: stopped, command } = ports([
      projection({
        attachments: [openAttachment()],
        stopped: { at: 5, reason: null, by: { kind: "watchdog" } },
      }),
    ]);
    await expect(sendSessionMessageOperation(stopped, sendInput())).rejects.toThrow("is stopped");

    const { ports: detached } = ports([projection()]);
    await expect(sendSessionMessageOperation(detached, sendInput())).rejects.toThrow(
      "no live executor",
    );

    const { ports: closed } = ports([
      projection({ attachments: [openAttachment({ status: "closed", closedAt: 9 })] }),
    ]);
    await expect(sendSessionMessageOperation(closed, sendInput())).rejects.toThrow(
      "no live executor",
    );

    const { ports: blank } = ports([projection({ attachments: [openAttachment()] })]);
    await expect(sendSessionMessageOperation(blank, sendInput({ message: "  " }))).rejects.toThrow(
      "non-empty",
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("is a SuperviseSessionError for every refusal, so the door can word it", async () => {
    const { ports: missing } = ports([]);
    await expect(sendSessionMessageOperation(missing, sendInput())).rejects.toBeInstanceOf(
      SuperviseSessionError,
    );
  });
});
