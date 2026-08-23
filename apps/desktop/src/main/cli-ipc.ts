/**
 * The Settings → CLI request surface (VC-52): a detection read and a doctor
 * run. Deliberately db-free — the CLI install is filesystem and process state,
 * so a degraded db must not take the one pane that can explain a broken
 * install down with it. The single db-backed fact (the removal tombstone)
 * arrives through a dep that answers `false` when it cannot be read.
 */
import type { CliDoctorResult, CliStatusInput, CliToolStatus } from "../ipc/contract";
import { CLI_IPC } from "./ipc-descriptors";
import { registerGuardedIpcHandlers } from "./ipc-registry";

export interface CliIpcDeps {
  /** Measures the install fresh — `src/main/cli-status.ts`. */
  status(input?: CliStatusInput): Promise<CliToolStatus>;
  /** Runs `volli doctor --json` through the user's login shell — `src/main/cli-doctor.ts`. */
  doctor(): Promise<CliDoctorResult>;
  /**
   * Main's idempotent repair: regenerate the harness runtime, then re-run the
   * background install (link, skills, PATH block) — the same work boot does,
   * which is what lets Fix be offered without a confirmation. Like File →
   * Install, it lifts the removal tombstone first: Fix is an explicit request
   * for working tools, and repairing behind a standing suppression would
   * leave the install present on disk yet skipped at every boot.
   */
  repair(): Promise<void>;
}

export function registerCliIpcHandlers(deps: CliIpcDeps): void {
  registerGuardedIpcHandlers(CLI_IPC, {
    "volli:cli-status": async (input) => ({ ok: true as const, status: await deps.status(input) }),
    "volli:cli-doctor": async (input) => {
      // Repair BEFORE the probe, so what gets reported is the world the repair
      // left behind — the same two-phase shape the CLI's own `--fix` keeps.
      if (input.fix) await deps.repair();
      return deps.doctor();
    },
    // The same repair, without the probe: the launch banner's Fix now button
    // re-measures with a plain status read afterwards, and must not spend the
    // doctor probe's login-shell timeout on a host whose login shell is the
    // thing that did not answer (VC-159). A repair that throws crosses as
    // `{ ok: false, error }` through the registry's envelope, and the banner
    // says so — a button that claims a repair it could not make must not exist.
    "volli:cli-repair": async () => {
      await deps.repair();
      return { ok: true as const };
    },
  });
}
