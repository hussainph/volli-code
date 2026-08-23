import type { DoctorCheck } from "@volli/shared";

import type { CliStatusRow } from "@renderer/components/pages/cli-status-model";
import type { HarnessListing } from "@renderer/components/pages/harness-catalog";

/** The facts About has already measured and can show before placing them on the clipboard. */
export interface AboutReportInput {
  rows: readonly CliStatusRow[];
  checks: readonly DoctorCheck[];
  listings: readonly HarnessListing[];
}

/**
 * Formats the support report from the state already held by Settings → About.
 *
 * This is deliberately independent of React and the clipboard: the preview and
 * the eventual clipboard write receive this exact same string.
 */
export function buildAboutReport({ rows, checks, listings }: AboutReportInput): string {
  const lines = ["Volli report"];

  if (rows.length > 0) {
    lines.push("", "CLI status");
    for (const row of rows) {
      lines.push(`${row.label}: ${row.value}`);
      if (row.detail !== undefined) lines.push(`  ${row.detail}`);
    }
  }

  if (checks.length > 0) {
    lines.push("", "Doctor");
    for (const check of checks) {
      lines.push(`[${check.status}] ${check.title}`, `  ${check.detail}`);
      if (check.remedy !== undefined) lines.push(`  Remedy: ${check.remedy}`);
    }
  }

  if (listings.length > 0) {
    lines.push("", "Harnesses");
    for (const listing of listings) {
      lines.push(`${listing.label}: ${listing.command} (${listing.origin})`);
    }
  }

  return lines.join("\n");
}
