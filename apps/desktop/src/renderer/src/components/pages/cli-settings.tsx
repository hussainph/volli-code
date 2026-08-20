/**
 * Settings → CLI (VC-52): the detection surface over the silent background
 * install, plus the in-app `volli doctor` run.
 *
 * The pane's job is stated by the install's design: installation is background,
 * user-space, and dialog-free, so this is the ONE place its truth is readable.
 * Everything here is a measurement main took at request time — nothing is a
 * restatement of configuration (the doctor module's founding rule).
 *
 * View glue only: the fold from a measured status to rows/tones lives in
 * `cli-status-model.ts`, which is coverage-enrolled; this file draws it.
 * Status hues ride {@link StatusDot} so the pane cannot invent its own greens —
 * ok maps to the healthy family, warn to the asks-for-a-person amber, muted to
 * the quiet neutral, exactly the severity reading that component documents.
 */
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { StethoscopeIcon } from "@phosphor-icons/react/dist/csr/Stethoscope";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@volli/shared";
import type { DoctorCheck } from "@volli/shared";
import type { CliToolStatus } from "../../../../ipc/contract";

import {
  cliStatusRows,
  type CliRowTone,
  type CliStatusRow,
} from "@renderer/components/pages/cli-status-model";
import { SessionPathComparison } from "@renderer/components/pages/session-path-comparison";
import { SettingsRow, SettingsSection } from "@renderer/components/pages/settings-shell";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { Notice } from "@renderer/components/ui/notice";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";

/** Detection tone → the app's one status-dot vocabulary (see module header). */
const TONE_DOT: Record<CliRowTone, StatusDotState> = {
  ok: "ready",
  warn: "waiting",
  muted: "idle",
};

type StatusState =
  | { status: "loading" }
  | { status: "loaded"; rows: CliStatusRow[]; environment: CliToolStatus["environment"] }
  | { status: "error"; message: string };

type DoctorState =
  | { status: "idle" }
  | { status: "running"; fixing: boolean }
  | { status: "report"; checks: DoctorCheck[]; summary: string }
  | { status: "error"; message: string };

export function CliSettings() {
  const [state, setState] = useState<StatusState>({ status: "loading" });
  const [doctor, setDoctor] = useState<DoctorState>({ status: "idle" });

  // Re-entrant read (mount, the refresh button, a post-fix refresh) —
  // token-guarded so the answer that lands is the one asked for last.
  const statusFetch = useLatestAsync();
  const load = useCallback(async () => {
    const token = statusFetch.claim();
    setState({ status: "loading" });
    try {
      const result = await window.api.cli.status();
      if (!statusFetch.isCurrent(token)) return;
      if (!result.ok) {
        setState({ status: "error", message: result.error });
        return;
      }
      setState({
        status: "loaded",
        rows: cliStatusRows(result.status),
        environment: result.status.environment,
      });
    } catch (error) {
      if (statusFetch.isCurrent(token)) {
        setState({ status: "error", message: errorMessage(error) });
      }
    }
  }, [statusFetch]);

  useEffect(() => {
    void load();
    return () => statusFetch.invalidate();
  }, [load, statusFetch]);

  async function runDoctor(fix: boolean): Promise<void> {
    if (doctor.status === "running") return;
    setDoctor({ status: "running", fixing: fix });
    try {
      const result = await window.api.cli.doctor({ fix });
      if (!result.ok) {
        setDoctor({ status: "error", message: result.error });
        return;
      }
      setDoctor({ status: "report", checks: result.checks, summary: result.summary });
      // A fix regenerates what the detection rows describe; re-measure them.
      if (fix) void load();
    } catch (error) {
      setDoctor({ status: "error", message: errorMessage(error) });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="Command-line tool"
        icon={TerminalWindowIcon}
        action={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh CLI status"
            disabled={state.status === "loading"}
            onClick={() => void load()}
          >
            <ArrowsClockwiseIcon
              className={state.status === "loading" ? "animate-spin" : undefined}
            />
          </Button>
        }
      >
        {state.status === "loading" ? (
          <p className={EMPTY_INLINE}>Checking…</p>
        ) : state.status === "error" ? (
          <Notice
            announce
            tone="error"
            icon={WarningIcon}
            title="Couldn't check the CLI install"
            detail={state.message}
            actions={
              <Button size="xs" variant="outline" onClick={() => void load()}>
                <ArrowsClockwiseIcon />
                Retry
              </Button>
            }
          />
        ) : (
          <>
            {state.rows.map((row) => (
              <SettingsRow key={row.key} label={row.label} align="start">
                <div className="flex max-w-96 flex-col items-end gap-1">
                  <span className="flex items-center gap-2 text-ui text-foreground">
                    <StatusDot state={TONE_DOT[row.tone]} />
                    {row.value}
                  </span>
                  {row.detail ? (
                    <span
                      className="break-all text-right font-mono text-ui text-muted-foreground"
                      title={row.detail}
                    >
                      {row.detail}
                    </span>
                  ) : null}
                </div>
              </SettingsRow>
            ))}
            <SessionPathComparison environment={state.environment} />
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Doctor"
        icon={StethoscopeIcon}
        action={
          <Button
            size="xs"
            variant="outline"
            disabled={doctor.status === "running"}
            onClick={() => void runDoctor(false)}
          >
            {doctor.status === "running" && !doctor.fixing ? "Running…" : "Run Doctor"}
          </Button>
        }
      >
        <DoctorBody doctor={doctor} onFix={() => void runDoctor(true)} />
      </SettingsSection>
    </div>
  );
}

const CHECK_MARK: Record<
  DoctorCheck["status"],
  { icon: typeof CheckCircleIcon; className: string }
> = {
  ok: { icon: CheckCircleIcon, className: "text-positive" },
  warn: { icon: WarningIcon, className: "text-attention" },
  fail: { icon: XCircleIcon, className: "text-destructive" },
};

function DoctorBody({ doctor, onFix }: { doctor: DoctorState; onFix: () => void }) {
  if (doctor.status === "idle") {
    return <p className={EMPTY_INLINE}>Not run yet.</p>;
  }
  if (doctor.status === "running") {
    return <p className={EMPTY_INLINE}>{doctor.fixing ? "Fixing and re-running…" : "Running…"}</p>;
  }
  if (doctor.status === "error") {
    return (
      <Notice
        announce
        tone="error"
        icon={WarningIcon}
        title="Doctor couldn't run"
        detail={doctor.message}
        actions={
          <Button size="xs" variant="outline" onClick={onFix}>
            <WrenchIcon />
            Fix & Re-run
          </Button>
        }
      />
    );
  }
  const needsFix = doctor.checks.some((check) => check.status !== "ok");
  return (
    <div className="flex flex-col gap-2 py-2">
      {doctor.checks.map((check) => {
        const mark = CHECK_MARK[check.status];
        const Mark = mark.icon;
        return (
          <div key={check.id} className="flex items-start gap-2">
            <Mark weight="fill" className={`mt-0.5 size-4 shrink-0 ${mark.className}`} />
            <div className="min-w-0">
              <p className="text-ui text-foreground">{check.title}</p>
              <p className="break-words text-ui text-muted-foreground">{check.detail}</p>
              {check.remedy ? (
                <p className="text-ui text-muted-foreground">→ {check.remedy}</p>
              ) : null}
            </div>
          </div>
        );
      })}
      <div className="mt-1 flex items-center justify-between gap-4 border-t border-border/50 pt-2">
        <p className="text-ui text-muted-foreground">{doctor.summary}</p>
        {needsFix ? (
          <Button size="xs" variant="outline" onClick={onFix}>
            <WrenchIcon />
            Fix & Re-run
          </Button>
        ) : null}
      </div>
    </div>
  );
}
