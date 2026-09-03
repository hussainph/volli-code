/**
 * What one press of "Refresh models" is allowed to say.
 *
 * The button's whole job is to reach every connected provider's current list,
 * so the one thing a person must never be left guessing is which of four very
 * different things just happened: the catalog changed, it was already current,
 * some provider could not be reached, or a model was withheld because Volli
 * could not prove how to talk to it. "Nothing appeared" reads identically in
 * all four, and only this classification tells them apart.
 *
 * Pure and separate from the pane precisely so the coverage gate can reach
 * every branch — the same reason `run-automation-model.ts` sits beside its
 * view. Severity is the caller's to render; this decides only what is true.
 */
import type { ModelCatalogRefreshReport } from "@volli/shared";

/** How loudly the outcome needs to be said. */
export type RefreshOutcomeKind = "failed" | "issues" | "changed" | "unchanged";

export interface RefreshOutcome {
  kind: RefreshOutcomeKind;
  message: string;
}

/** English plural for a count, with no library for one `s`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Classify a completed refresh.
 *
 * The order is deliberate. A refresh where nothing succeeded is a failure even
 * though it changed nothing — reporting it as "unchanged" would tell somebody
 * their catalog is current when it is merely stale. A partial failure, or a
 * model withheld as unsafe, outranks the additions it arrived with, because
 * those are the outcomes a person may want to act on. Only a clean, complete
 * refresh gets to be quiet.
 */
export function refreshOutcome(report: ModelCatalogRefreshReport): RefreshOutcome {
  const failed = report.failedProviderIds.length;
  if (failed > 0 && report.refreshedProviderIds.length === 0) {
    return {
      kind: "failed",
      message: `Couldn't refresh models: ${count(failed, "provider")} failed.`,
    };
  }

  const issues = [
    failed > 0 ? `${count(failed, "provider")} failed` : null,
    report.rejected > 0 ? `${count(report.rejected, "model")} rejected as unsafe` : null,
  ].filter((part): part is string => part !== null);
  if (issues.length > 0) {
    return { kind: "issues", message: `Models refreshed with issues: ${issues.join("; ")}.` };
  }

  const changes = [
    report.added > 0 ? `${report.added} added` : null,
    report.removed > 0 ? `${report.removed} removed` : null,
  ].filter((part): part is string => part !== null);
  if (changes.length > 0) {
    return { kind: "changed", message: `Models refreshed: ${changes.join(", ")}.` };
  }

  return { kind: "unchanged", message: "Model catalog unchanged." };
}
