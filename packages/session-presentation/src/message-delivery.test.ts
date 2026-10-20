import { describe, expect, it } from "vite-plus/test";
import {
  parseRendererSessionEvent,
  scrubSessionEventPayload,
  type SessionEventPayload,
  type CommandReceipt,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { ChatSessionFrame } from "./transcript";
import { messageDeliveryLabels } from "./message-delivery";

const user: UIMessage = { id: "message", role: "user", parts: [{ type: "text", text: "hello" }] };
function frame(
  sequence: number,
  payload: SessionEventPayload,
  message: UIMessage | null = null,
  commandId: string | null = null,
): ChatSessionFrame {
  const parsed = parseRendererSessionEvent(
    JSON.parse(
      JSON.stringify({
        id: `event-${sequence}`,
        sessionId: "session",
        sequence,
        occurredAt: sequence,
        recordedAt: sequence,
        attachmentId: "attachment",
        commandId,
        provenance: {
          source: { kind: "system", id: "runtime", detail: null },
          venue: { id: "host", kind: "local" },
        },
        payload: scrubSessionEventPayload(payload),
      }),
    ),
    "test",
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  return {
    sessionId: "session",
    sequence,
    event: parsed.event,
    transcript: message === null ? null : { message },
  };
}
const submitted = (sequence = 1) =>
  frame(
    sequence,
    {
      kind: "command.recorded",
      command: {
        id: "command",
        sessionId: "session",
        createdAt: 0,
        route: null,
        intent: {
          kind: "message.submit",
          reference: { id: "artifact", mediaType: null, digest: null },
        },
      },
    },
    user,
  );
function receipt(status: CommandReceipt["status"], commandId = "command", sequence = 2) {
  const common = { id: "receipt", commandId, recordedAt: sequence, sequence };
  const value: CommandReceipt =
    status === "accepted"
      ? {
          ...common,
          status,
          acceptedAt: 2,
          result: { kind: "message.submitted", sessionId: "session" },
        }
      : status === "rejected"
        ? { ...common, status, code: "failure", detail: "not delivered" }
        : status === "completed"
          ? { ...common, status, result: { kind: "message.submitted", sessionId: "session" } }
          : { ...common, status, detail: "unknown" };
  return frame(sequence, { kind: "command.receipt.recorded", receipt: value });
}
describe("message ownership through the real renderer codec", () => {
  it("keeps intent pending until a runtime acceptance fact", () => {
    expect(messageDeliveryLabels([submitted()]).get(user.id)).toBe("Pending");
    expect(messageDeliveryLabels([submitted(), receipt("accepted")]).get(user.id)).toBe(
      "Delivered",
    );
    expect(messageDeliveryLabels([submitted(), receipt("completed")]).get(user.id)).toBe(
      "Delivered",
    );
    expect(messageDeliveryLabels([submitted(), receipt("rejected")]).get(user.id)).toBe(
      "Not delivered",
    );
    expect(
      messageDeliveryLabels([submitted(), receipt("accepted"), receipt("rejected")]).get(user.id),
    ).toBe("Delivered");
    expect(messageDeliveryLabels([submitted(), receipt("unreconciled")]).get(user.id)).toBe(
      "Delivery unconfirmed",
    );
  });
  it("does not use synthetic turn correlation as acceptance or call a running turn refused", () => {
    const started = (id: string | null) =>
      frame(2, { kind: "turn.started", attachmentId: "attachment", turnId: "turn" }, null, id);
    expect(messageDeliveryLabels([submitted(), started("command")]).get(user.id)).toBe("Pending");
    expect(
      messageDeliveryLabels([submitted(), started(null), receipt("rejected", "command", 3)]).get(
        user.id,
      ),
    ).toBe("Delivery unconfirmed");
    expect(
      messageDeliveryLabels([submitted(), started(null), receipt("unreconciled")]).get(user.id),
    ).toBe("Delivery unconfirmed");
    expect(
      messageDeliveryLabels([submitted(), started(null), receipt("accepted", "another")]).get(
        user.id,
      ),
    ).toBe("Pending");
    // A turn preceding the submit cannot have run this message.
    expect(
      messageDeliveryLabels([
        frame(1, { kind: "turn.started", attachmentId: "attachment", turnId: "old-turn" }),
        submitted(2),
        receipt("rejected", "command", 3),
      ]).get(user.id),
    ).toBe("Not delivered");
  });
  it("accepts runtime transcript observation and tolerates future or missing envelopes", () => {
    const observed = frame(
      3,
      {
        kind: "transcript.referenced",
        attachmentId: "attachment",
        turnId: "turn",
        reference: { id: "artifact-observed", mediaType: null, digest: null },
      },
      user,
    );
    expect(messageDeliveryLabels([submitted(), observed]).get(user.id)).toBe("Delivered");
    expect(messageDeliveryLabels([{ ...observed, event: null, transcript: null }]).size).toBe(0);
    expect(
      messageDeliveryLabels([
        frame(
          4,
          { kind: "turn.completed", attachmentId: "attachment", turnId: "turn" },
          { ...user, role: "assistant" },
        ),
      ]).size,
    ).toBe(0);
    expect(messageDeliveryLabels([]).size).toBe(0);
  });
});
