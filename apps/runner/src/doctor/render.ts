/**
 * How a doctor report reads on a terminal.
 *
 * One line per check — `status`, what was checked, what it found — and, under
 * a check that has one, its single fix indented beneath it so the person can
 * copy it without reading the finding. The header names the box and its
 * platform, because a report pasted into a ticket without it is unreadable;
 * the last line counts what happened and never claims more than the checks
 * saw ("no failed checks", not "ready").
 */
import type { RunnerHostFacts } from "@volli/shared/cloud";

import type { DoctorReport } from "./checks";

const STATUS_WIDTH = 7;
const INDENT = "  ";

export function renderDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.title.length));
  const lines = [`volli-runner doctor — ${describeHost(report.host)}`, ""];
  for (const check of report.checks) {
    lines.push(
      `${INDENT}${check.status.padEnd(STATUS_WIDTH)}  ${check.title.padEnd(width)}  ${check.detail}`,
    );
    const fix = check.fix;
    if (fix !== undefined) {
      lines.push(`${INDENT}${" ".repeat(STATUS_WIDTH)}  ${" ".repeat(width)}  fix: ${fix}`);
    }
  }
  lines.push("", summary(report));
  return `${lines.join("\n")}\n`;
}

/** `hetzner-1 · debian 12 · x64 · glibc 2.36`, with what this box actually has. */
export function describeHost(host: RunnerHostFacts): string {
  const platform = host.platform;
  const parts = [host.hostname, platform.distro ?? platform.os, platform.arch];
  if (platform.glibc !== null) parts.push(`glibc ${platform.glibc}`);
  return parts.join(" · ");
}

function summary(report: DoctorReport): string {
  const { counts, checks } = report;
  if (counts.fail > 0) {
    return (
      `${counts.fail} of ${checks.length} checks failed. Fix the lines marked "fix:" above, ` +
      "then run `volli-runner doctor` again."
    );
  }
  const parts = [`${counts.ok} ok`];
  if (counts.warn > 0) parts.push(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} unknown`);
  if (counts.info > 0) parts.push(`${counts.info} info`);
  return `No failed checks (${parts.join(", ")}).`;
}
