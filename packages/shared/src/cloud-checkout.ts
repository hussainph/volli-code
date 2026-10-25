/**
 * "Choose the folder for <project> on this Mac" (VC-895, N2-3): the wire
 * types of the desktop-only `checkouts.*` entries (`./desktop-entries`).
 *
 * In a Volli Cloud launch, a project's folder on this Mac lives only in the
 * runner's local path registry, never in the backend and never on the wire.
 * A cloud project with no checkout here (and no frozen local project to adopt
 * one from) cannot start a Session until the person picks its folder once.
 * The window asks whether this Mac has the folder, and asks main to show the
 * native folder picker; main checks the project with the backend, stores the
 * chosen path locally, and answers with path-free facts only.
 *
 * With the `cloud` experiment off every `checkouts.*` entry answers
 * unavailable, and outside a Volli Cloud launch the window never asks.
 */

/**
 * Whether this Mac knows a cloud project's folder.
 *
 * - `located`: this runner has the project's checkout registered, or a local
 *   project with the same id it adopts the folder from on first use.
 * - `missing`: no folder here yet; "Choose the folder…" is the recovery.
 * - `no_runner`: this Mac is not one of the person's runners yet, so there is
 *   no registry to hold a folder (Settings → Runners is the recovery).
 */
export const CLOUD_CHECKOUT_STATES = ["located", "missing", "no_runner"] as const;

export type CloudCheckoutState = (typeof CLOUD_CHECKOUT_STATES)[number];

/** `checkouts.status`'s answer: never a path. */
export interface CloudCheckoutStatus {
  readonly state: CloudCheckoutState;
}

/**
 * `checkouts.chooseFolder`'s answer: the repository the folder now stands for,
 * or the person closed the picker (nothing changed). Never the path itself.
 */
export type CloudCheckoutChoice =
  | { readonly outcome: "chosen"; readonly projectRepoId: string }
  | { readonly outcome: "cancelled" };
