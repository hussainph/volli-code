/**
 * The contract harness's own router context, for tests only (VC-564 review B2).
 *
 * Production's IPC registration binds the desktop's own window,
 * `LOCAL_DESKTOP_CALLER`, and takes no caller option at all. To judge other
 * actors over that same bridge, a contract test mocks `@volli/session-rpc`
 * with {@link withHarnessIdentity}: the router the NEXT registration builds
 * answers as the identity {@link judgeNextRegistrationAs} named, and every
 * other router stays the real one. Nothing here is reachable from `src/main`.
 *
 * This module imports `@volli/session-rpc` for types only, so the mock
 * factory that loads it never re-enters the module it is mocking.
 */
import type * as SessionRpc from "@volli/session-rpc";
import type { RouterCaller, SessionRouterContext } from "@volli/session-rpc";

/** Who a harness link's router judges, in place of the desktop's own window. */
export interface HarnessIdentity {
  readonly caller: RouterCaller;
  readonly sessionWorkspace?: SessionRouterContext["sessionWorkspace"];
}

let pending: HarnessIdentity | null = null;

/** The next router `createSessionRouter` builds judges this identity. */
export function judgeNextRegistrationAs(identity: HarnessIdentity): void {
  pending = identity;
}

/** Throws unless the registration just made consumed the identity: the mock is missing. */
export function assertIdentityConsumed(): void {
  if (pending === null) return;
  pending = null;
  throw new Error(
    'The harness identity was never applied: mock "@volli/session-rpc" with withHarnessIdentity',
  );
}

/** `vi.mock("@volli/session-rpc", ...)`'s module: the real one, whose next router is the harness's. */
export function withHarnessIdentity(actual: typeof SessionRpc): typeof SessionRpc {
  return {
    ...actual,
    createSessionRouter: () => {
      const router = actual.createSessionRouter();
      const identity = pending;
      pending = null;
      if (identity === null) return router;
      return {
        ...router,
        createCaller: (context, options) =>
          router.createCaller(
            {
              // Main's bridge always hands the router a context object.
              ...(context as SessionRouterContext),
              caller: identity.caller,
              sessionWorkspace: identity.sessionWorkspace,
            },
            options,
          ),
      };
    },
  };
}
