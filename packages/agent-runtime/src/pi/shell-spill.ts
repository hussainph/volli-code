import type { ShellSpillRedaction } from "./vendor/pi-harness/types";

/** Disk budget for one shell spill, independent of its model-visible tail. */
export class ShellSpillBudget {
  static readonly maxBytes = 64 * 1024 * 1024;
  #bytes = 0;
  truncatedAt: number | undefined;

  /** Reserve before queueing so neither pending writes nor disk can exceed the cap. */
  take(chunk: Uint8Array): Uint8Array {
    const remaining = ShellSpillBudget.maxBytes - this.#bytes;
    if (chunk.byteLength > remaining) this.truncatedAt = ShellSpillBudget.maxBytes;
    const kept = chunk.subarray(0, remaining);
    this.#bytes += kept.byteLength;
    return kept;
  }
}

/**
 * VC-865: one spill's redaction, in stream order, ahead of {@link ShellSpillBudget}.
 *
 * Redacting before the cap is what keeps a value straddling the cap off disk:
 * it is replaced whole and only its marker can be cut. The transform is
 * created on first use, so a command whose output fits inline never builds
 * one. Every failure, including the factory's, is the same fixed error with
 * no cause, because the original may carry the text being redacted.
 */
export class ShellSpillRedactor {
  static readonly failure = "Credential redaction failed.";
  readonly #create: (() => ShellSpillRedaction) | undefined;
  #redaction: ShellSpillRedaction | undefined;

  constructor(create: (() => ShellSpillRedaction) | undefined) {
    this.#create = create;
  }

  /** Bytes now safe to spill; the undecided rest stays here. */
  push(chunk: Uint8Array): Uint8Array {
    if (this.#create === undefined) return chunk;
    return this.#guard(() => (this.#redaction ??= this.#create!()).push(chunk));
  }

  /** What was still held once no more output follows. */
  end(): Uint8Array {
    const redaction = this.#redaction;
    return redaction === undefined ? new Uint8Array(0) : this.#guard(() => redaction.end());
  }

  #guard(run: () => Uint8Array): Uint8Array {
    try {
      return run();
    } catch {
      // eslint-disable-next-line preserve-caught-error -- the original cause may contain a credential
      throw new Error(ShellSpillRedactor.failure);
    }
  }
}
