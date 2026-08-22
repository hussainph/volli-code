/**
 * Settings → About: is this install working, and what is it made of.
 *
 * ABSORBS THREE CATEGORIES. "CLI", "Harness Runtimes" and the Doctor were
 * separate rail entries, and two of them had nothing to change — a settings
 * category with no settings in it is a page that teaches people the rail is
 * not worth reading. What they had in common is that they are all *facts about
 * this install*, which is what About is.
 *
 * The shape inverts the old one. `cli-settings.tsx` listed every check it ran,
 * pass and fail alike, at equal weight — so "everything is fine" and "two
 * things are broken" drew the same wall of rows. Here the healthy case is one
 * line, anything wrong is a fault with its remedy beside it, and the raw
 * measurements are behind a disclosure for whoever wants them.
 *
 * `cli-status-model.ts` already computes a per-check remedy, so the fault list
 * is a fold over what it returns rather than a second opinion about it.
 */
import * as React from "react";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { errorMessage, type DoctorCheck } from "@volli/shared";

import { useHarnessListingsState } from "@renderer/components/pages/harness-picker";
import {
  DetailLine,
  HealthPanel,
  ItemRow,
  PrefSection,
  Provenance,
  type Fault,
} from "@renderer/components/settings/kit";
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
  const runDoctor = React.useCallback(async (fix: boolean) => {
    setDoctorState("loading");
    try {
      const result = await window.api.cli.doctor({ fix });
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
  }, []);

  React.useEffect(() => {
    void runDoctor(false);
  }, [runDoctor]);

  // Only what is WRONG becomes a fault. A passing check is not news, and the
  // measurements behind it are one disclosure away.
  /**
   * Warning-toned STATUS rows are faults too, and the split comes from
   * `cliStatusDisclosure` (VC-64) rather than being re-derived here.
   *
   * Without it the two halves of "is this install healthy" disagree: the Doctor
   * decides the headline while a warning discovered by detection sits inside a
   * collapsed disclosure, so the panel can say "Everything's working" over a
   * hidden row that says the CLI is not on PATH. Folding them into one fault
   * list means the headline counts everything wrong, and — because the same
   * function hands back `detailRows` — a promoted row is not ALSO repeated in
   * the details behind it.
   */
  const { attentionRows, detailRows } = React.useMemo(() => cliStatusDisclosure(rows), [rows]);

  const faults: readonly Fault[] = React.useMemo(
    () => [
      ...checks
        .filter((check) => check.status !== "ok")
        .map((check) => ({
          id: check.id,
          headline: check.title,
          detail: check.remedy ? `${check.detail} → ${check.remedy}` : check.detail,
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

  return (
    <>
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
            {faults.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={checking}
                onClick={() => void runDoctor(true)}
              >
                <WrenchIcon />
                Fix
              </Button>
            ) : null}
            <CopyReportDialog report={report} availability={reportAvailability} />
            <Button
              size="sm"
              variant="outline"
              disabled={checking}
              onClick={() => {
                harnesses.refresh();
                void load();
                void runDoctor(false);
              }}
            >
              {checking ? "Checking…" : "Re-check"}
            </Button>
          </div>
        }
      >
        {detailRows.map((row) => (
          <DetailLine key={row.key} label={row.label} value={row.detail ?? row.value} />
        ))}
      </HealthPanel>

      {/*
       * Harness INVENTORY — small enough to stay a list. `DataTable`'s rule is
       * that a table is for a collection that GROWS; this is three or four
       * entries and a table would be ceremony around them.
       *
       * Every harness is listed, including ones with nothing to configure. A
       * list pruned to the configurable one would quietly claim this host can
       * launch exactly one harness.
       */}
      <PrefSection
        title="Harnesses"
        icon={CpuIcon}
        hint={<>Agent binaries Volli can launch. Pick one per project in Configure.</>}
      >
        {listings.map((listing) => (
          <ItemRow
            key={listing.id}
            name={listing.label}
            meta={listing.command}
            badges={
              <Provenance mine={listing.origin !== "built-in"}>
                {listing.origin === "built-in" ? "Built-in" : "Registered"}
              </Provenance>
            }
          />
        ))}
      </PrefSection>
    </>
  );
}
