/**
 * A wait that an interrupt ends early: what `volli-runner link`'s device code
 * sleeps between polls, so Ctrl-C stops it at once rather than at the next
 * poll. It resolves either way (the caller checks `signal`), and leaves no
 * listener behind on the signal.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((done) => {
    const wake = (): void => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", wake);
      done();
    }, ms);
    signal.addEventListener("abort", wake, { once: true });
  });
}
