import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vite-plus/test";

import { subscribeTimed, timedTools, type PiMainSpan } from "./main-span";

/** A span that records its labels and whether the body ran inside it. */
function recordingSpan(): { span: PiMainSpan; spans: unknown[]; depth: () => number } {
  const spans: unknown[] = [];
  let depth = 0;
  const span: PiMainSpan = (labels, fn) => {
    spans.push(labels);
    depth += 1;
    try {
      return fn();
    } finally {
      depth -= 1;
    }
  };
  return { span, spans, depth: () => depth };
}

/** A listener left as it is when no span is installed. */
const plain = async (): Promise<void> => {};

describe("the host's main-thread spans around Pi work (VC-1090)", () => {
  it("times each tool call under its name, arguments and result unchanged, the rest of the tool kept", async () => {
    const { span, spans, depth } = recordingSpan();
    const seen: unknown[] = [];
    const tool = {
      name: "read",
      label: "Read",
      description: "reads",
      parameters: {},
      executionMode: "sequential",
      execute: async (...args: unknown[]) => {
        seen.push([args, depth()]);
        return { content: [], details: "ok" };
      },
    } as unknown as AgentTool;
    const [timed] = timedTools(span, "session-1", [tool]);
    expect(timed).toMatchObject({ name: "read", label: "Read", executionMode: "sequential" });
    await expect(timed!.execute("call-1", { path: "a" } as never)).resolves.toEqual({
      content: [],
      details: "ok",
    });
    expect(seen).toEqual([[["call-1", { path: "a" }], 1]]);
    expect(spans).toEqual([{ door: "runtime", operation: "tool:read", sessionId: "session-1" }]);
    expect(timedTools(undefined, "session-1", [tool])).toEqual([tool]);
  });

  it("times each agent event's handler under its event type", async () => {
    const { span, spans, depth } = recordingSpan();
    const listeners: Array<(event: unknown, signal: unknown) => unknown> = [];
    const agent = {
      subscribe: (listener: (event: unknown, signal: unknown) => unknown) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Agent;
    const handled: unknown[] = [];
    const unsubscribe = subscribeTimed(
      agent,
      span,
      "session-1",
    )(async (event) => {
      handled.push([event.type, depth()]);
    });
    expect(typeof unsubscribe).toBe("function");
    await listeners[0]!({ type: "message_update" }, undefined);
    expect(handled).toEqual([["message_update", 1]]);
    expect(spans).toEqual([
      { door: "runtime", operation: "pi:message_update", sessionId: "session-1" },
    ]);
    subscribeTimed(agent, undefined, "session-1")(plain);
    expect(listeners[1]).toBe(plain);
  });
});
