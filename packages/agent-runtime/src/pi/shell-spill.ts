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
