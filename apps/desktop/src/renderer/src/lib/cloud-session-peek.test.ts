import { describe, expect, it } from "vite-plus/test";
import { readCloudSessionPeek } from "./cloud-session-peek";
import { readCloudSnapshot } from "./cloud-session-view";
import {
  SESSION_ID,
  referencedEvent,
  snapshotAnswer,
  turnEvent,
} from "./cloud-session.test-support";

const projection = () => readCloudSnapshot(snapshotAnswer(10)).projection;
function frame(sequence: number, event: unknown, message: unknown = null) {
  return {
    sessionId: SESSION_ID,
    sequence,
    event,
    transcript: message === null ? null : { message },
  };
}

describe("cloud hover peek", () => {
  it("uses settled cloud bodies and safe questions without adopting or registering a viewer", async () => {
    const view = projection();
    const question = { id: "question" } as never;
    const result = await readCloudSessionPeek(SESSION_ID, async () => ({
      projection: { ...view, interactions: { active: [question], resolved: [] } },
      throughSequence: 10,
      frames: [
        null,
        frame(1, referencedEvent(1), {
          id: "m1",
          role: "assistant",
          parts: [
            { type: "text", text: "  Hello\n world " },
            {
              type: "dynamic-tool",
              toolName: "read",
              toolCallId: "tool1",
              state: "input-available",
              input: {},
            },
          ],
        }),
        frame(2, referencedEvent(2)),
        frame(3, turnEvent(3, "turn.started")),
        frame(
          4,
          { ...referencedEvent(4), payload: { kind: "future.event" } },
          { id: "m4", role: "user", parts: [{ type: "text", text: "newer build" }] },
        ),
      ],
    }));
    expect(result).toMatchObject({
      sessionId: SESSION_ID,
      question,
      turns: null,
      turnDepth: null,
      unreadable: 1,
      lastActivityAt: 5,
      entries: [
        { at: 1, role: "assistant", text: "Hello world", tools: ["read"] },
        { at: 5, role: "user", text: "newer build", tools: [] },
      ],
    });
  });
  it("keeps the last six excerpts, and does not invent a question or lifelong totals", async () => {
    const result = await readCloudSessionPeek(SESSION_ID, async () => ({
      projection: projection(),
      throughSequence: 10,
      frames: Array.from({ length: 9 }, (_, i) =>
        frame(i + 1, referencedEvent(i + 1), {
          id: `m${i}`,
          role: "assistant",
          parts: [{ type: "text", text: `entry ${i}` }],
        }),
      ),
    }));
    expect(result.entries).toHaveLength(6);
    expect(result.entries[0]?.text).toBe("entry 3");
    expect(result.question).toBeNull();
    expect(result.unreadable).toBe(0);
  });
});
