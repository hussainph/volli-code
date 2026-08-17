/**
 * The Settings → CLI request surface (VC-52): a detection read and a doctor
 * run. Deliberately db-free — the CLI install is filesystem and process state,
 * so a degraded db must not take the one pane that can explain a broken
 * install down with it. The single db-backed fact (the removal tombstone)
 * arrives through a dep that answers `false` when it cannot be read.
 */
import type { CliDoctorResult, CliToolStatus } from "../ipc/contract";
import { CLI_IPC } from "./ipc-descriptors";
import { registerGuardedIpcHandlers } from "./ipc-registry";

export interface CliIpcDeps {
  /** Measures the install fresh — `src/main/cli-status.ts`. */
  status(): Promise<CliToolStatus>;
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
    "volli:cli-status": async () => ({ ok: true as const, status: await deps.status() }),
    "volli:cli-doctor": async (input) => {
      // Repair BEFORE the probe, so what gets reported is the world the repair
      // left behind — the same two-phase shape the CLI's own `--fix` keeps.
      if (input.fix) await deps.repair();
      return deps.doctor();
    },
  });
}
