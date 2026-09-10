import { doctorCheckHeadline, type DoctorCheck } from "@volli/shared";

import type { SupportInfo } from "../../../../../ipc/contract";
import type { CliStatusRow } from "@renderer/components/pages/cli-status-model";
import type { HarnessListing } from "@renderer/components/pages/harness-catalog";

/** The facts About has already measured and can show before placing them on the clipboard. */
export interface AboutReportInput {
  /**
   * When this snapshot was taken, as an ISO 8601 UTC instant.
   *
   * Passed in rather than read here so the report stays a pure function of its
   * input: About stamps ONE snapshot and hands the same string to the preview
   * and to the clipboard, which it could not promise if this module reached
   * for the clock on every render (VC-293).
   */
  generatedAt: string;
  /** Main's allowlist: build, release line, OS, architecture, schema version. */
  support: SupportInfo;
  rows: readonly CliStatusRow[];
  checks: readonly DoctorCheck[];
  listings: readonly HarnessListing[];
}

/**
 * Formats the support report from the state already held by Settings → About.
 *
 * This is deliberately independent of React and the clipboard: the preview and
 * the eventual clipboard write receive this exact same string.
 *
 * IT LEADS WITH THE METADATA, because every diagnosis starts there: a report
 * without a version, a channel and an OS is a list of symptoms nobody can
 * place. What it must never grow is the other direction — no credential or
 * secret-store value, no environment, no database contents beyond the schema
 * number. `support` is an allowlist assembled in main for exactly that reason,
 * and this reader touches only its five fields.
 */
export function buildAboutReport({
  generatedAt,
  support,
  rows,
  checks,
  listings,
}: AboutReportInput): string {
  const lines = [
    "Volli report",
    `Generated at: ${generatedAt}`,
    `App version: ${support.appVersion}`,
    `Release channel: ${support.channel}`,
    `OS: ${support.platform} ${support.arch}`,
    `Database schema: ${support.schemaVersion}`,
  ];

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
      // Headed by the finding, like the pane (VC-293) — with the check's own
      // claim kept underneath, because what was being measured is part of
      // reading a failure.
      lines.push(`[${check.status}] ${doctorCheckHeadline(check)}`);
      if (check.status !== "ok") lines.push(`  Check: ${check.title}`);
      lines.push(`  ${check.detail}`);
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
