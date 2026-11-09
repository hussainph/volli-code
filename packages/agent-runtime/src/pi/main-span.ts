/**
 * The host's main-thread spans around a Session's Pi work (VC-1090).
 *
 * Electron main runs every Session's agent loop, so the host's stall log
 * (`@volli/host-core`'s `withMainSpan`) needs to know when a stall was a
 * Session's: each Pi agent event's handler (`pi:<event type>`) and each tool
 * call's start (`tool:<name>`). The host hands the span in; this package
 * knows nothing of its log. Only the synchronous part of each call is timed,
 * and the call runs unchanged.
 */
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";

/** The host's main-thread span: labels are code-owned identifiers, never content. */
export type PiMainSpan = <Result>(
  labels: { readonly door: string; readonly operation: string; readonly sessionId: string },
  fn: () => Result,
) => Result;

/** Every tool's `execute` timed under its name, its result unchanged. */
export function timedTools(
  span: PiMainSpan | undefined,
  sessionId: string,
  tools: readonly AgentTool[],
): AgentTool[] {
  if (span === undefined) return [...tools];
  return tools.map((tool) => ({
    ...tool,
    execute: (...args: Parameters<AgentTool["execute"]>) =>
      span({ door: "runtime", operation: `tool:${tool.name}`, sessionId }, () =>
        tool.execute(...args),
      ),
  }));
}

/** `agent.subscribe(listener)`, each event's handler timed under its event type. */
export function subscribeTimed(
  agent: Agent,
  span: PiMainSpan | undefined,
  sessionId: string,
): (listener: Parameters<Agent["subscribe"]>[0]) => ReturnType<Agent["subscribe"]> {
  if (span === undefined) return (listener) => agent.subscribe(listener);
  return (listener) =>
    agent.subscribe((event, signal) =>
      span({ door: "runtime", operation: `pi:${event.type}`, sessionId }, () =>
        listener(event, signal),
      ),
    );
}
