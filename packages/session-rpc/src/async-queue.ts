export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  /** Each held value's size, beside it, when the queue is bounded in bytes. */
  readonly #sizes: number[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  readonly #capacity: number;
  readonly #maxBytes: number;
  #bytes = 0;
  #closed = false;
  #overflowed = false;

  /**
   * `capacity` bounds the values held; `maxBytes`, when given, bounds the
   * sizes their pushes declared too, so a few huge values overflow it as
   * surely as many small ones.
   */
  constructor(capacity = 4_096, maxBytes = Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("AsyncQueue capacity must be a positive integer");
    }
    this.#capacity = capacity;
    this.#maxBytes = maxBytes;
  }

  /**
   * True once a push found the buffer full. **A consumer must convert this into
   * a terminal error rather than letting the iteration end.** An overflowed
   * queue ends exactly like an exhausted one, and a normal end is the single
   * thing this stream must never claim after dropping frames: downstream it
   * becomes a `done` frame, then `observer.complete()`, then a surface that
   * silently stops updating while its own state is already stale.
   */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  /** `bytes` is what this value counts against `maxBytes`. */
  push(value: T, bytes = 0): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else if (this.#values.length < this.#capacity && this.#bytes + bytes <= this.#maxBytes) {
      this.#values.push(value);
      this.#sizes.push(bytes);
      this.#bytes += bytes;
    } else {
      // Closed without discarding: what the queue did hold is still contiguous
      // history the consumer can use, and the gap only starts after it. Dropping
      // it would widen the hole the consumer then has to resume across.
      this.#overflowed = true;
      this.close(false);
    }
  }

  close(discard = true): void {
    if (this.#closed) return;
    this.#closed = true;
    if (discard) {
      this.#values.length = 0;
      this.#sizes.length = 0;
      this.#bytes = 0;
    }
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) {
      this.#bytes -= this.#sizes.shift()!;
      return { done: false, value: this.#values.shift()! };
    }
    if (this.#closed) return { done: true, value: undefined };
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
