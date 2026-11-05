/** Yield through a paint opportunity without tying input/focus to animation completion. */
export function afterPaint(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let frame = 0;
    const finish = () => {
      cancelAnimationFrame(frame);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish);
    });
  });
}
