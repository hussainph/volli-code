/**
 * PTY output arrives on ONE shared IPC stream (see preload `terminal.onData`),
 * every chunk carrying its own `sessionId`. This router is the pure fan-out:
 * one subscription to the stream, dispatched to the matching session's engine.
 * Kept free of DOM/IPC so the routing logic is unit-testable in isolation.
 */
import type { TerminalDataEvent } from "@volli/shared";

export type TerminalDataHandler = (data: string) => void;

export interface TerminalDataRouter {
  /** Route future events for `sessionId` to `handler` (replacing any prior one). */
  register(sessionId: string, handler: TerminalDataHandler): void;
  /** Stop routing events for `sessionId`. */
  unregister(sessionId: string): void;
  /** Deliver one stream event to its session's handler, if registered. */
  dispatch(event: TerminalDataEvent): void;
  has(sessionId: string): boolean;
}

export function createTerminalDataRouter(): TerminalDataRouter {
  const handlers = new Map<string, TerminalDataHandler>();
  return {
    register(sessionId, handler) {
      handlers.set(sessionId, handler);
    },
    unregister(sessionId) {
      handlers.delete(sessionId);
    },
    dispatch(event) {
      handlers.get(event.sessionId)?.(event.data);
    },
    has(sessionId) {
      return handlers.has(sessionId);
    },
  };
}
