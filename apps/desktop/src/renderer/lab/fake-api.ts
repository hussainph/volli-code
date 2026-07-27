/**
 * A stand-in for the preload `window.api` bridge, so lab scratches can mount
 * real app components in a plain browser tab — where no Electron main process,
 * and therefore no bridge, exists.
 *
 * DELIBERATELY not a hand-mirrored copy of `src/preload/index.ts`. A hand-written
 * double of a ~550-line bridge rots the moment the bridge grows a method, and a
 * silently-stale double is worse than no double at all. This is instead a Proxy
 * that answers ANY namespace and method by shape, using the one naming
 * convention the bridge does hold to (verified against every member of
 * `preload/index.ts`):
 *
 *   • `on*`            — a subscription. Returns a no-op unsubscribe, synchronously.
 *   • everything else  — an `invoke`. Returns a resolved FAILURE Result.
 *
 * Failure rather than fabricated success is the honest default: every renderer
 * caller already handles `ok: false` (CLAUDE.md — "surface every failed
 * mutation"), so an unstubbed channel degrades into the app's real error path
 * instead of into a crash, and the scratch shows you what that path looks like.
 * Anything a scratch actually depends on is passed explicitly via `overrides`.
 *
 * The one shape this convention CANNOT infer is a plain value member — the
 * bridge has a few (`app.launchedByCli`, `versions.electron`), and a property
 * read alone gives nothing to distinguish "a boolean" from "a namespace I have
 * not descended into yet". They therefore read as a (truthy) node unless a
 * scratch overrides them, which {@link installFakeApi} supports by handing back
 * any non-object override verbatim. `lab/seed.ts` declares the ones the app
 * shell reads at mount.
 *
 * Scope: this is lab-only. Nothing under `src/renderer/src/` may import it —
 * the app talks to the real bridge, and a test double must never be reachable
 * from shipped code. The dependency runs one way: lab → app, never app → lab.
 */

/**
 * The real bridge's type, read off the global the preload declares
 * (`src/preload/index.d.ts`). Taken from the global rather than imported from
 * `src/preload/index.ts` so the lab never forms an import edge into
 * main-process code — the renderer's "no Node imports" rule applies here too.
 */
type Api = typeof window.api;

/**
 * A nested tree of partial overrides — `{ tickets: { move: fn } }`. Untyped by
 * necessity (it is a sparse slice of a deep interface), and confined to this
 * module plus the scratches that build one; `installFakeApi` is the single
 * boundary where it meets the typed `Api`.
 */
export type ApiOverrides = Record<string, unknown>;

/** The Result an unstubbed channel resolves to — shaped like every failing preload Result. */
const UNSTUBBED_RESULT = {
  ok: false,
  error: "Not stubbed in the UI lab — pass an override to installFakeApi().",
} as const;

/**
 * Property names that must resolve to `undefined` rather than to another node.
 * `then` is the load-bearing one: a Proxy that answers `then` with a function
 * is a thenable, so `await`ing or resolving a namespace would hang forever
 * instead of failing. The rest keep the proxy honest under runtime
 * introspection (`String(api)`, structured cloning, JSON serialization).
 */
const NON_MEMBERS: ReadonlySet<string> = new Set(["then", "catch", "finally", "toJSON"]);

/** One warning per channel — a scratch that hits an unstubbed call every render must not flood the console. */
const warned = new Set<string>();

function warnUnstubbed(channel: string): void {
  if (warned.has(channel)) return;
  warned.add(channel);
  console.warn(
    `[lab] window.api.${channel}() is not stubbed — resolving to a failure Result. ` +
      `Add it to this scratch's installFakeApi() overrides if the surface needs a real answer.`,
  );
}

/** Walks `overrides` along `path`, returning `undefined` at the first missing or non-object hop. */
function lookup(overrides: ApiOverrides, path: readonly string[]): unknown {
  let current: unknown = overrides;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Whether an override is a branch to descend into rather than a value to hand
 * back. Only a plain object qualifies, which is exactly what lets a partial
 * `{ tickets: { move } }` leave every other `tickets` method stubbed — while
 * an array, or a `null`, reads as the value it plainly is.
 */
function isNamespace(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One node of the fake bridge at `path`. The target is a function so the node
 * is both callable (a method) and traversable (a namespace) — which member it
 * turns out to be is decided by the caller, not guessed here. An override
 * found at this exact path wins outright; otherwise the node falls through to
 * the shape-based defaults, so `{ tickets: { move } }` still leaves every
 * other `tickets` method stubbed.
 */
function node(overrides: ApiOverrides, path: readonly string[]): unknown {
  const override = lookup(overrides, path);
  // A function override IS the method. Any other non-namespace value is a
  // VALUE member of the bridge and is returned verbatim — the only way to
  // express `app.launchedByCli: false`, since the shape convention above
  // cannot tell a boolean from an undescended namespace.
  if (override !== undefined && !isNamespace(override)) return override;

  return new Proxy(() => {}, {
    get(_target, property) {
      if (typeof property !== "string" || NON_MEMBERS.has(property)) return undefined;
      return node(overrides, [...path, property]);
    },
    apply() {
      const method = path[path.length - 1] ?? "";
      // Subscriptions are synchronous and return their unsubscribe; callers
      // store that in an effect cleanup, so it must be a real function.
      if (method.startsWith("on")) return () => {};
      warnUnstubbed(path.join("."));
      return Promise.resolve(UNSTUBBED_RESULT);
    },
  });
}

/**
 * Installs the fake bridge on `window.api`. Call once, before rendering.
 *
 * The `as Api` cast is the single deliberate lie in the lab, and it is
 * contained here: a structural double of a deep interface cannot be expressed
 * without it, and every scratch consumes the result through the app's own
 * typed call sites, which are checked normally.
 */
export function installFakeApi(overrides: ApiOverrides = {}): void {
  // Cleared per install so switching scratches re-reports what the new one
  // leaves unstubbed, rather than staying quiet about a different surface.
  warned.clear();
  window.api = node(overrides, []) as Api;
}
