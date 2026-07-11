/**
 * Owns the restty runtime session — the shared WASM module + WebGPU device
 * every terminal renders through — so GPU device loss is recoverable.
 *
 * restty 0.2.0 has no device-loss handling anywhere: a GPU process crash
 * blanks every terminal until app restart, and because the (dead) device
 * promise is cached inside the runtime session, NEW terminals come up blank
 * too. The fix restty can't give us yet lives here: create the session
 * ourselves (instead of restty's module-global default), watch the device's
 * `lost` promise, and on loss ROTATE — swap in a fresh session and tell the
 * engine registry to rebuild every live renderer against it. Scrollback
 * beyond each engine's replay buffer is lost; the shells themselves live in
 * the main process and never notice.
 */
import { createResttyRuntimeSession } from "restty/internal/runtime";
import { toast } from "sonner";

type RuntimeSession = ReturnType<typeof createResttyRuntimeSession>;

let session: RuntimeSession | null = null;
/** Bumped on every rotation so stale `lost` continuations can no-op. */
let generation = 0;
/** One armed watcher per generation — `device.lost` resolves once per device. */
let watching = false;

const rotationListeners = new Set<() => void>();

/** The session every engine passes to createRestty. Lazily created. */
export function currentGpuSession(): RuntimeSession {
  session ??= createResttyRuntimeSession();
  return session;
}

/**
 * Subscribe to session rotations (device lost → fresh session installed).
 * The registry rebuilds every live engine from this event.
 */
export function onGpuSessionRotated(listener: () => void): () => void {
  rotationListeners.add(listener);
  return () => {
    rotationListeners.delete(listener);
  };
}

/**
 * Arm the device-loss watcher. Called by an engine once its backend resolves
 * to WebGPU — at that point the session's core promise is already cached, so
 * the canvas argument is never used for a fresh init. On the WebGL2 fallback
 * there is no WebGPU device; context loss there stays unhandled (rarer, and
 * restty offers no seam for it either).
 */
export function watchGpuDeviceLoss(canvas: HTMLCanvasElement): void {
  if (watching) return;
  watching = true;
  const armedGeneration = generation;
  currentGpuSession()
    .getWebGPUCore(canvas)
    .then((core) => {
      if (core === null) {
        if (armedGeneration === generation) watching = false;
        return;
      }
      return core.device.lost.then((info) => {
        if (armedGeneration !== generation) return;
        // "destroyed" is a deliberate teardown, not a crash — never rotate.
        if (info.reason === "destroyed") return;
        rotate();
      });
    })
    .catch(() => {
      if (armedGeneration === generation) watching = false;
    });
}

function rotate(): void {
  generation += 1;
  session = createResttyRuntimeSession();
  watching = false;
  // Surface it — silent recovery would leave truncated scrollback unexplained.
  toast.warning("Display driver reset — terminals recovered, older scrollback trimmed");
  for (const listener of rotationListeners) listener();
}

/** Test-only: force a rotation without a real GPU loss. */
export function rotateGpuSessionForTests(): void {
  rotate();
}
