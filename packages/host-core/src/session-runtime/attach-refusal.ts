import type { CommandReceipt } from "@volli/shared";
import { ATTACH_CANCELLED_CODE } from "@volli/session-engine";

/**
 * Why an attach was not ready, in words, from the receipt it answered with.
 *
 * A rejected attach carries the diagnosis a person needs — an unpreparable
 * worktree names the path, the branch checked out there and the branch the
 * ticket expects — and that sentence is the reason a start has no first turn.
 * The other statuses have no such sentence, so they are named as what they
 * are rather than dressed up as one. Shared by every door that starts a
 * Session and reports an attach it could not complete (Automation Runs,
 * `session.start`).
 */
export function attachRefusal(receipt: CommandReceipt | null): string {
  if (receipt === null) return "the attach reported no receipt";
  if (attachStopped(receipt)) return "it was stopped before it finished starting";
  if (receipt.status === "rejected") return receipt.detail ?? receipt.code;
  return `the attach is ${receipt.status}`;
}

/**
 * Whether a start did not finish because a stop reached it first (VC-1072):
 * not a failure, but the outcome someone asked for, and worded as one.
 */
export function attachStopped(receipt: CommandReceipt | null): boolean {
  return receipt?.status === "rejected" && receipt.code === ATTACH_CANCELLED_CODE;
}
