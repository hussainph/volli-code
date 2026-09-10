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
 *
 * WHAT IT MAY CLAIM IS NOT THIS FILE'S DECISION (VC-293). The pane holds three
 * async reads and the view they feed; `about-health-model.ts` decides what
 * their combination is allowed to say, and it is tested at 100% because the
 * failure it prevents — "Everything's working" over an install nothing had
 * measured yet — looks identical to success on screen.
 */
import * as React from "react";
import { errorMessage, type DoctorCheck } from "@volli/shared";

import type { HarnessListing } from "@renderer/components/pages/harness-catalog";
import { useHarnessListingsState } from "@renderer/components/pages/harness-picker";
import { HealthPanel } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { toastError } from "@renderer/lib/toast";
import { cliStatusRows, type CliStatusRow } from "@renderer/components/pages/cli-status-model";

import type { SupportInfo } from "../../../../../ipc/contract";
import {
  aboutHealth,
  aboutReportAvailability,
  scopedFactState,
  type AboutFactState,
} from "./about-health-model";
import { buildAboutReport } from "./about-report";
import { CopyReportDialog } from "./copy-report-dialog";

interface AboutReportSnapshot {
  support: SupportInfo;
  rows: readonly CliStatusRow[];
  checks: readonly DoctorCheck[];
  listings: readonly HarnessListing[];
  text: string;
}

export function AboutPane() {
  const harnesses = useHarnessListingsState();
  const { listings } = harnesses;
  const projectCwd = useSelectedProject()?.path;
  const statusScope = projectCwd ?? null;
  const [rows, setRows] = React.useState<readonly CliStatusRow[]>([]);
  const [checks, setChecks] = React.useState<readonly DoctorCheck[]>([]);
  const [statusState, setStatusState] = React.useState<AboutFactState>("loading");
  const [loadedStatusScope, setLoadedStatusScope] = React.useState<string | null | undefined>(
    undefined,
  );
  const [doctorState, setDoctorState] = React.useState<AboutFactState>("loading");
  const [loadedDoctorScope, setLoadedDoctorScope] = React.useState<string | null | undefined>(
    undefined,
  );
  const [support, setSupport] = React.useState<SupportInfo | null>(null);
  const [supportState, setSupportState] = React.useState<AboutFactState>("loading");
  const statusFetch = useLatestAsync();
  // The doctor probe spawns a login shell and can take seconds, so two runs
  // overlap easily — a project switch, or Re-check pressed twice. Without its
  // own guard the slower answer wins, and the pane shows a measurement of a
  // directory the user has left (VC-293's stale-result acceptance).
  const doctorFetch = useLatestAsync();
  const supportFetch = useLatestAsync();

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
    const token = doctorFetch.claim();
    setDoctorState("loading");
    try {
      // The same project scope the status read uses: which tool absences are
      // faults is a fact about a directory (VC-157), and the probe judges it
      // from its own cwd.
      const result = await window.api.cli.doctor(
        projectCwd === undefined ? { fix: false } : { fix: false, cwd: projectCwd },
      );
      if (!doctorFetch.isCurrent(token)) return;
      if (!result.ok) {
        setLoadedDoctorScope(statusScope);
        setDoctorState("unavailable");
        toastError(`Doctor couldn't run: ${result.error}`);
        return;
      }
      setChecks(result.checks);
      setLoadedDoctorScope(statusScope);
      setDoctorState("ready");
    } catch (error) {
      if (doctorFetch.isCurrent(token)) {
        setLoadedDoctorScope(statusScope);
        setDoctorState("unavailable");
        toastError(`Doctor couldn't run: ${errorMessage(error)}`);
      }
    }
  }, [doctorFetch, projectCwd, statusScope]);

  React.useEffect(() => {
    void runDoctor();
    return () => doctorFetch.invalidate();
  }, [doctorFetch, runDoctor]);

  /**
   * The build, release line, OS and schema version (VC-293). Host-wide, not
   * project-scoped — a project cannot change which build is running — so it is
   * read once per mount and only re-read when the user asks for a re-check.
   */
  const loadSupport = React.useCallback(async () => {
    const token = supportFetch.claim();
    setSupportState("loading");
    try {
      const result = await window.api.support.info();
      if (!supportFetch.isCurrent(token)) return;
      if (!result.ok) {
        setSupportState("unavailable");
        toastError(`Couldn't read this build's details: ${result.error}`);
        return;
      }
      setSupport(result.info);
      setSupportState("ready");
    } catch (error) {
      if (supportFetch.isCurrent(token)) {
        setSupportState("unavailable");
        toastError(`Couldn't read this build's details: ${errorMessage(error)}`);
      }
    }
  }, [supportFetch]);

  React.useEffect(() => {
    void loadSupport();
    return () => supportFetch.invalidate();
  }, [loadSupport, supportFetch]);

  // A read answers the project it was made in. One that lands after the
  // selection moved is an answer to a different question, and reads as still
  // loading until this scope's own read returns.
  const scopedStatusState = scopedFactState(loadedStatusScope, statusScope, statusState);
  const scopedDoctorState = scopedFactState(loadedDoctorScope, statusScope, doctorState);

  const health = React.useMemo(
    () =>
      aboutHealth({
        status: scopedStatusState,
        doctor: scopedDoctorState,
        rows,
        checks,
      }),
    [checks, rows, scopedDoctorState, scopedStatusState],
  );

  const reportAvailability = aboutReportAvailability([
    scopedStatusState,
    scopedDoctorState,
    supportState,
    harnesses.status,
  ]);

  /**
   * ONE SNAPSHOT, held in state rather than recomputed per render: the preview
   * a person reads and the text their clipboard receives must be the same
   * bytes, timestamp included, and a `useMemo` React is free to discard would
   * have re-stamped the clock between the two (VC-293). It is re-taken when an
   * input changes — a re-check, a project switch — and cleared while the
   * report is incomplete, which is also when Copy is disabled.
   */
  const [reportSnapshot, setReportSnapshot] = React.useState<AboutReportSnapshot | null>(null);
  React.useEffect(() => {
    if (reportAvailability !== "ready" || support === null) {
      setReportSnapshot(null);
      return;
    }
    setReportSnapshot({
      support,
      rows,
      checks,
      listings,
      text: buildAboutReport({
        generatedAt: new Date().toISOString(),
        support,
        rows,
        checks,
        listings,
      }),
    });
  }, [checks, listings, reportAvailability, rows, support]);

  // Building the snapshot is itself part of preparing a complete report. Tag
  // it with the exact input references so a ready transition cannot briefly
  // enable Copy with an empty or superseded snapshot from the previous read.
  const snapshotIsCurrent =
    reportSnapshot !== null &&
    reportSnapshot.support === support &&
    reportSnapshot.rows === rows &&
    reportSnapshot.checks === checks &&
    reportSnapshot.listings === listings;
  const report = snapshotIsCurrent ? reportSnapshot.text : "";
  const copyReportAvailability = aboutReportAvailability([
    reportAvailability,
    snapshotIsCurrent ? "ready" : "loading",
  ]);

  /**
   * One press that repairs instead of a wall that explains. `fix: true` runs
   * main's idempotent repair (regenerate + reinstall) before re-probing, and
   * the status read re-runs after it so the fault list reflects the repaired
   * install rather than the one that earned the button.
   */
  const [fixing, setFixing] = React.useState(false);
  const runFix = React.useCallback(async () => {
    setFixing(true);
    const token = doctorFetch.claim();
    setDoctorState("loading");
    try {
      // Project-scoped like `runDoctor` — the repair re-probe must judge the
      // same directory the fault list was measured in (VC-157).
      const result = await window.api.cli.doctor(
        projectCwd === undefined ? { fix: true } : { fix: true, cwd: projectCwd },
      );
      if (!doctorFetch.isCurrent(token)) return;
      if (!result.ok) {
        setLoadedDoctorScope(statusScope);
        setDoctorState("unavailable");
        toastError(`Couldn't repair this install: ${result.error}`);
        return;
      }
      setChecks(result.checks);
      setLoadedDoctorScope(statusScope);
      setDoctorState("ready");
      await load();
    } catch (error) {
      if (doctorFetch.isCurrent(token)) {
        setLoadedDoctorScope(statusScope);
        setDoctorState("unavailable");
        toastError(`Couldn't repair this install: ${errorMessage(error)}`);
      }
    } finally {
      setFixing(false);
    }
  }, [doctorFetch, load, projectCwd, statusScope]);

  const checking = health.state === "checking";

  return (
    <HealthPanel
      state={health.state}
      headline={health.headline}
      faults={health.faults}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <CopyReportDialog report={report} availability={copyReportAvailability} />
          {/*
            Fix appears only over a completed pair of reads with something
            wrong in it: a repair offered under an unfinished or failed check
            is a button for a fault nobody has established. Re-check stays,
            which is what a failed read actually needs. It survives its own
            press — the repair puts the doctor read back in flight, and a
            button that vanished the moment it was clicked would take its
            progress with it.
          */}
          {health.canFix || fixing ? (
            <Button size="sm" variant="secondary" disabled={fixing} onClick={() => void runFix()}>
              {fixing ? "Fixing…" : "Fix"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={checking || fixing}
            onClick={() => {
              harnesses.refresh();
              void load();
              void runDoctor();
              void loadSupport();
            }}
          >
            {checking ? "Checking…" : "Re-check"}
          </Button>
        </div>
      }
    />
  );
}
