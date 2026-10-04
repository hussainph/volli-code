const DEFAULT_APPLICATION_SHUTDOWN_DEADLINE_MS = 15_000;

type ShutdownTask = () => Promise<void>;

/**
 * Drains every accepted shutdown task, but never leaves Electron's quit held
 * forever. Rejections are observed as soon as they happen, while the aggregate
 * still waits for the other tasks so one failed close cannot weaken a normal
 * drain. Tasks that settle after the deadline remain observed and cannot
 * complete the returned promise a second time.
 */
export function settleShutdownBeforeDeadline(options: {
  shutdowns: readonly ShutdownTask[];
  deadlineMs?: number;
  reportFailure(error: unknown): void;
}): Promise<void> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_APPLICATION_SHUTDOWN_DEADLINE_MS;
  const observedShutdowns = options.shutdowns.map((shutdown) =>
    Promise.resolve()
      .then(() => shutdown())
      .catch((error: unknown) => {
        options.reportFailure(error);
      }),
  );
  const drained = Promise.allSettled(observedShutdowns).then(() => "drained" as const);
  let deadline!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<"timed-out">((resolve) => {
    deadline = setTimeout(() => resolve("timed-out"), deadlineMs);
  });

  return Promise.race([drained, timedOut])
    .then((outcome) => {
      if (outcome === "timed-out") {
        options.reportFailure(
          new Error(`Application shutdown did not settle within ${deadlineMs}ms.`),
        );
      }
    })
    .finally(() => clearTimeout(deadline));
}
