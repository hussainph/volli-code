/**
 * Settings → About: is this install working — one line — and the report we
 * ask for when it is not.
 *
 * ABSORBS THREE CATEGORIES. "CLI", "Harness Runtimes" and the Doctor were
 * separate rail entries, and two of them had nothing to change — a settings
 * category with no settings in it is a page that teaches people the rail is
 * not worth reading. What they had in common is that they are all *facts about
 * this install*, which is what About is.
 *
 * WHAT A USER SEES vs WHAT SUPPORT GETS is the whole design now. The healthy
 * case is one line. A fault shows its headline and the one thing to do about
 * it — the remedy when the check computed one — plus a Fix button that runs
 * main's idempotent repair. Everything else (PATHs, socket paths, per-check
 * measurements, the harness inventory) lives ONLY in the copy report, because
 * that material is for us: diagnosing why an install is broken is our job, and
 * a settings page reciting it at the user was asking them to do it. The
 * harness inventory in particular was legacy of the multi-harness terminal
 * days — an inventory nothing on this page can change.
 */
import * as React from "react";
import { errorMessage, type DoctorCheck } from "@volli/shared";

import { useHarnessListingsState } from "@renderer/components/pages/harness-picker";
import { HealthPanel, type Fault } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { toastError } from "@renderer/lib/toast";
import {
  cliStatusDisclosure,
  cliStatusRows,
  type CliStatusRow,
} from "@renderer/components/pages/cli-status-model";

import { buildAboutReport } from "./about-report";
import { CopyReportDialog, type CopyReportAvailability } from "./copy-report-dialog";

type AboutFactStatus = CopyReportAvailability;

export function AboutPane() {
  const harnesses = useHarnessListingsState();
  const { listings } = harnesses;
  const projectCwd = useSelectedProject()?.path;
  const statusScope = projectCwd ?? null;
  const [rows, setRows] = React.useState<readonly CliStatusRow[]>([]);
  const [checks, setChecks] = React.useState<readonly DoctorCheck[]>([]);
  const [statusState, setStatusState] = React.useState<AboutFactStatus>("loading");
  const [loadedStatusScope, setLoadedStatusScope] = React.useState<string | null | undefined>(
    undefined,
  );
  const [doctorState, setDoctorState] = React.useState<AboutFactStatus>("loading");
  const statusFetch = useLatestAsync();

  const load = React.useCallback(async () => {
    const token = statusFetch.claim();
    setStatusState("loading");
    try {
      const result = await window.api.cli.status(
        projectCwd === undefined ? undefined : { cwd: projectCwd },
      );
      if (!statusFetch.isCurrent(token)) return;
      if (!result.ok) {
        setLoadedStatusScope(statusScope);
        setStatusState("unavailable");
        toastError(`Couldn't check this install: ${result.error}`);
        return;
      }
      setRows(cliStatusRows(result.status));
      setLoadedStatusScope(statusScope);
      setStatusState("ready");
    } catch (error) {
      if (statusFetch.isCurrent(token)) {
        setLoadedStatusScope(statusScope);
        setStatusState("unavailable");
        toastError(`Couldn't check this install: ${errorMessage(error)}`);
      }
    }
  }, [projectCwd, statusFetch, statusScope]);

  React.useEffect(() => {
    void load();
    return () => statusFetch.invalidate();
  }, [load, statusFetch]);

  /**
   * Doctor runs on entry rather than on a button, because a health surface that
   * says nothing until you press something is a health surface that reports
   * "fine" by default. `--fix` stays explicit — it writes.
   */
  const runDoctor = React.useCallback(async () => {
    setDoctorState("loading");
    try {
      // The same project scope the status read uses: which tool absences are
      // faults is a fact about a directory (VC-157), and the probe judges it
      // from its own cwd.
      const result = await window.api.cli.doctor(
        projectCwd === undefined ? { fix: false } : { fix: false, cwd: projectCwd },
      );
      if (!result.ok) {
        setDoctorState("unavailable");
        toastError(`Doctor couldn't run: ${result.error}`);
        return;
      }
      setChecks(result.checks);
      setDoctorState("ready");
    } catch (error) {
      setDoctorState("unavailable");
      toastError(`Doctor couldn't run: ${errorMessage(error)}`);
    }
  }, [projectCwd]);

  React.useEffect(() => {
    void runDoctor();
  }, [runDoctor]);

  // Only what is WRONG becomes a fault. A passing check is not news, and the
  // measurements behind it live in the copy report.
  /**
   * Warning-toned STATUS rows are faults too, and the split comes from
   * `cliStatusDisclosure` (VC-64) rather than being re-derived here.
   *
   * Without it the two halves of "is this install healthy" disagree: the Doctor
   * decides the headline while a warning discovered by detection sits inside a
   * collapsed disclosure, so the panel can say "Everything's working" over a
   * hidden row that says the CLI is not on PATH. Folding them into one fault
   * list means the headline counts everything wrong.
   *
   * A fault's detail is the REMEDY when the check computed one, never
   * `detail → remedy` glued together: the detail half is a measurement (a
   * path, a symlink target), which is diagnosis — our job, and already in the
   * copy report. What the user needs on screen is the one thing to do.
   */
  const { attentionRows } = React.useMemo(() => cliStatusDisclosure(rows), [rows]);

  const faults: readonly Fault[] = React.useMemo(
    () => [
      ...checks
        .filter((check) => check.status !== "ok")
        .map((check) => ({
          id: check.id,
          headline: check.title,
          detail: check.remedy ?? check.detail,
        })),
      ...attentionRows.map((row) => ({
        id: `cli-status:${row.key}`,
        headline: row.label,
        detail: row.detail ?? row.value,
      })),
    ],
    [attentionRows, checks],
  );

  const report = React.useMemo(
    () => buildAboutReport({ rows, checks, listings }),
    [checks, listings, rows],
  );
  const scopedStatusState: AboutFactStatus =
    loadedStatusScope === statusScope ? statusState : "loading";
  const reportAvailability: CopyReportAvailability =
    scopedStatusState === "unavailable" ||
    doctorState === "unavailable" ||
    harnesses.status === "unavailable"
      ? "unavailable"
      : scopedStatusState === "loading" ||
          doctorState === "loading" ||
          harnesses.status === "loading"
        ? "loading"
        : "ready";
  const checking = reportAvailability === "loading";
  const healthy = faults.length === 0;

  /**
   * One press that repairs instead of a wall that explains. `fix: true` runs
   * main's idempotent repair (regenerate + reinstall) before re-probing, and
   * the status read re-runs after it so the fault list reflects the repaired
   * install rather than the one that earned the button.
   */
  const [fixing, setFixing] = React.useState(false);
  const runFix = React.useCallback(async () => {
    setFixing(true);
    setDoctorState("loading");
    try {
      // Project-scoped like `runDoctor` — the repair re-probe must judge the
      // same directory the fault list was measured in (VC-157).
      const result = await window.api.cli.doctor(
        projectCwd === undefined ? { fix: true } : { fix: true, cwd: projectCwd },
      );
      if (!result.ok) {
        setDoctorState("unavailable");
        toastError(`Couldn't repair this install: ${result.error}`);
        return;
      }
      setChecks(result.checks);
      setDoctorState("ready");
      await load();
    } catch (error) {
      setDoctorState("unavailable");
      toastError(`Couldn't repair this install: ${errorMessage(error)}`);
    } finally {
      setFixing(false);
    }
  }, [load, projectCwd]);

  return (
    <HealthPanel
      healthy={healthy}
      headline={
        healthy
          ? "Everything's working"
          : `${faults.length} thing${faults.length === 1 ? "" : "s"} need attention`
      }
      faults={faults}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <CopyReportDialog report={report} availability={reportAvailability} />
          {healthy ? null : (
            <Button
              size="sm"
              variant="secondary"
              disabled={checking || fixing}
              onClick={() => void runFix()}
            >
              {fixing ? "Fixing…" : "Fix"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={checking || fixing}
            onClick={() => {
              harnesses.refresh();
              void load();
              void runDoctor();
            }}
          >
            {checking ? "Checking…" : "Re-check"}
          </Button>
        </div>
      }
    />
  );
}
