import type { CommandReceipt } from "@volli/shared";

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
  if (receipt.status === "rejected") return receipt.detail ?? receipt.code;
  return `the attach is ${receipt.status}`;
}
