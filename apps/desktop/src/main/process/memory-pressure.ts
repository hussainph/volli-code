/**
 * Whether this machine is actually short of memory (VC-341).
 *
 * The one gate on automatic reaping that is about the MACHINE rather than about
 * a candidate. A stale dev server nobody is short of memory for is a tidiness
 * problem, and tidiness is not a reason for this app to kill a process while
 * its owner is not looking; a machine swapping because ten of them are still
 * resident is a different situation, and the one this gate is for.
 *
 * Two readings, because each alone lies in a way the other does not:
 *
 *  - `memory_pressure -Q` prints the system-wide free percentage. It is the
 *    number macOS itself reasons about, and it is the first thing to move.
 *  - `sysctl vm.swapusage` prints how much swap is in use. A machine that has
 *    already paged gigabytes out is under pressure even at a comfortable-looking
 *    free percentage, because the relief was already taken.
 *
 * Either can veto nothing and either can raise the flag; a reading that cannot
 * be taken is reported as no pressure, which is the conservative direction —
 * an unreadable machine never gets anything killed automatically.
 */
import type { MemoryPressureReading } from "@volli/shared";

import type { InventoryRunner } from "./inventory";
import { runInventoryTool } from "./inventory";

/** Below this much free memory, the machine is short. */
export const FREE_MEMORY_PRESSURE_PERCENT = 15;
/** Above this much swap in use, the machine has already paid for the shortage. */
export const SWAP_PRESSURE_BYTES = 4 * 1024 * 1024 * 1024;

/** The free percentage `memory_pressure -Q` reported, or null when it said nothing legible. */
export function parseFreePercentage(stdout: string): number | null {
  const match = /free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(stdout);
  if (match === null) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? percent : null;
}

/** Bytes of swap in use, from `sysctl vm.swapusage`, or null when unreadable. */
export function parseSwapUsedBytes(stdout: string): number | null {
  const match = /used\s*=\s*(\d+(?:\.\d+)?)([KMGT])/i.exec(stdout);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const scale: Record<string, number> = {
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };
  return value * (scale[match[2]!.toUpperCase()] ?? 1);
}

/** The verdict from whichever of the two readings could be taken. */
export function judgeMemoryPressure(
  freePercent: number | null,
  swapUsedBytes: number | null,
): MemoryPressureReading {
  const parts: string[] = [];
  if (freePercent !== null) parts.push(`free ${freePercent}%`);
  if (swapUsedBytes !== null) {
    parts.push(`swap ${(swapUsedBytes / 1024 ** 3).toFixed(1)} GB`);
  }
  if (parts.length === 0) {
    return { underPressure: false, detail: "memory pressure could not be measured" };
  }
  const underPressure =
    (freePercent !== null && freePercent < FREE_MEMORY_PRESSURE_PERCENT) ||
    (swapUsedBytes !== null && swapUsedBytes > SWAP_PRESSURE_BYTES);
  return { underPressure, detail: parts.join(", ") };
}

/** Takes both readings. */
export async function readMemoryPressure(
  run: InventoryRunner = runInventoryTool,
): Promise<MemoryPressureReading> {
  const [pressure, swap] = await Promise.all([
    run("memory_pressure", ["-Q"]),
    run("sysctl", ["vm.swapusage"]),
  ]);
  return judgeMemoryPressure(
    pressure === null ? null : parseFreePercentage(pressure),
    swap === null ? null : parseSwapUsedBytes(swap),
  );
}
