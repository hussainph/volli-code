/**
 * Serializes runtime observations at the product boundary without allowing a
 * consumer failure to reject a Pi callback. The caller consumes failures at a
 * command boundary once Pi has settled.
 */
export class OrderedObservationDelivery<T> {
  #tail: Promise<void> = Promise.resolve();
  #firstFailure: unknown;

  constructor(private readonly observer: (observation: T) => Promise<void>) {}

  deliver(observation: T): Promise<void> {
    const delivery = this.#tail.then(async () => {
      try {
        await this.observer(observation);
      } catch (error) {
        this.#firstFailure ??= error;
      }
    });
    this.#tail = delivery;
    return delivery;
  }

  consumeFailure(): unknown {
    const failure = this.#firstFailure;
    this.#firstFailure = undefined;
    return failure;
  }
}
