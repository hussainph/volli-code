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
    return this.deliverChecked(observation).then(() => undefined);
  }

  /** Audit boundaries need proof of this write, not merely an exhausted queue. */
  deliverChecked(observation: T): Promise<boolean> {
    const delivery = this.#tail.then(async () => {
      try {
        await this.observer(observation);
        return true;
      } catch (error) {
        this.#firstFailure ??= error;
        return false;
      }
    });
    this.#tail = delivery.then(() => undefined);
    return delivery;
  }

  consumeFailure(): unknown {
    const failure = this.#firstFailure;
    this.#firstFailure = undefined;
    return failure;
  }
}
