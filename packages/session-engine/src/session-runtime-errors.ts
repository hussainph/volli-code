import { COMMAND_INTENT_CONFLICT, type CommandIntentConflict } from "@volli/shared";

export class SessionRuntimeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRuntimeNotFoundError";
  }
}

export class SessionRuntimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRuntimeConflictError";
  }
}

/**
 * A command id already in flight, sent again with a different intent: the
 * runtime's half of `SessionEngineCommandConflictError`, answered
 * `CONFLICT` / `command-conflict` on the wire.
 */
export class SessionRuntimeCommandConflictError
  extends SessionRuntimeConflictError
  implements CommandIntentConflict
{
  readonly [COMMAND_INTENT_CONFLICT] = true as const;

  constructor(message: string) {
    super(message);
    this.name = "SessionRuntimeCommandConflictError";
  }
}

/**
 * A turn start refused because this host is exiting (VC-577): the idle-exit
 * latch is up. Nothing was recorded or sent; the work is simply not started in
 * a process that is about to end. A queued follow-up stays queued instead.
 */
export class SessionRuntimeExitingError extends SessionRuntimeConflictError {
  constructor() {
    super("Volli is quitting, so no new turn can start. Queued messages are kept for next launch.");
    this.name = "SessionRuntimeExitingError";
  }
}
