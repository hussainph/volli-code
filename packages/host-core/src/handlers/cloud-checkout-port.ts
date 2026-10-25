/**
 * A Volli Cloud project's folder on this Mac (VC-895, N2-3): what the handler
 * map's desktop-only `checkouts.*` entries call.
 *
 * Desktop main implements it (`apps/desktop/src/main/cloud-checkout.ts`) over
 * the cloud product store's runner-local path registry and the system folder
 * picker. Every other host (hostd) supplies none, and each entry answers
 * `OperationUnavailableError`. A port that cannot act now (the `cloud` flag is
 * off, or this is not a Volli Cloud launch) throws `OperationUnavailableError`
 * itself. Structural, so host-core imports nothing of the desktop's.
 *
 * **Paths.** Neither answer carries the folder: it stays in this Mac's
 * registry, and the backend learns only path-free checkout metadata.
 */
import type { CloudCheckoutChoice, CloudCheckoutStatus } from "@volli/shared";

type Answer<Value> = Value | Promise<Value>;

export interface CloudCheckoutPort {
  /** Whether this Mac knows the project's folder. */
  status(projectId: string): Answer<CloudCheckoutStatus>;
  /**
   * Checks the project with Volli Cloud, shows the folder picker, and
   * registers the chosen folder locally. Closing the picker changes nothing.
   */
  chooseFolder(projectId: string): Answer<CloudCheckoutChoice>;
}
