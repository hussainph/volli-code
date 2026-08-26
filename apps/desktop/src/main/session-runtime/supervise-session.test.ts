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
  log: ReturnType<typeof vi.fn<(message: string) => void>>;
} {
  const submit = overrides.submit ?? vi.fn(async () => ({}));
  const command = overrides.command ?? vi.fn(async () => ({}));
  const log = vi.fn<(message: string) => void>();
  return {
    ports: {
      sessionEngine: {
        listSessions: vi.fn(async () => projections),
        submit,
      } as unknown as SuperviseSessionPorts["sessionEngine"],
      runtime: { command } as unknown as SuperviseSessionPorts["runtime"],
      log,
    },
    submit,
    command,
    log,
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
      return {};
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

  it("refuses a second stop by naming who already stopped it", async () => {
    const { ports: p, submit } = ports([
      projection({
        stopped: { at: 5, reason: null, by: { kind: "session", sessionId: CALLER } },
      }),
    ]);

    await expect(stopSessionOperation(p, stopInput())).rejects.toThrow(
      `already stopped (by Session ${CALLER.slice(0, 8)})`,
    );
    expect(submit).not.toHaveBeenCalled();
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
  it("steers a marked message into the live attachment, detached", async () => {
    const turn = Promise.withResolvers<unknown>();
    const command = vi.fn(() => turn.promise);
    const { ports: p } = ports(
      [projection({ attachments: [openAttachment()], turnActive: true })],
      { command },
    );

    // Resolves immediately even though the turn (the command promise) has not:
    // a supervisor never blocks on someone else's turn.
    const outcome = await sendSessionMessageOperation(p, sendInput());
    turn.resolve({});

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

  it("logs a detached delivery failure instead of failing the caller", async () => {
    const command = vi.fn(async () => {
      throw new Error("attachment closed mid-flight");
    });
    const { ports: p, log } = ports([projection({ attachments: [openAttachment()] })], { command });

    await expect(sendSessionMessageOperation(p, sendInput())).resolves.toMatchObject({
      midTurn: false,
    });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("attachment closed mid-flight"),
      );
    });
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
