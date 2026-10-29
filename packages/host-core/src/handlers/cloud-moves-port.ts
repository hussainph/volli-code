/** Desktop main's person-only move service. Other hosts supply no port. */
import type {
  CloudMoveSnapshot,
  CloudMovePreflightInput,
  CloudMovePreflight,
  CloudMoveStartInput,
  CloudMoveCommand,
} from "@volli/shared";

type Answer<Value> = Value | Promise<Value>;

export interface CloudMovesPort {
  snapshot(): Answer<CloudMoveSnapshot>;
  preflight(input: CloudMovePreflightInput): Promise<CloudMovePreflight>;
  start(input: CloudMoveStartInput): Promise<void>;
  command(input: CloudMoveCommand): Promise<void>;
  report(moveId: string): Promise<string>;
  /** Invalidations only. A failed source ends the feed, so the window can retry it. */
  onChanged(listener: () => void, failed: (error: unknown) => void): () => void;
}
