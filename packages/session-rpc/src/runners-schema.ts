/**
 * This Mac's runner validators (VC-895; wire types in `@volli/shared`'s
 * `this-mac-runner.ts`), for the desktop-only tier's `runners.*` procedures.
 * Exact outputs, no transforms, so they publish with `z.toJSONSchema`. A
 * snapshot never carries the runner's credential: the schema has no field
 * that could hold one.
 *
 * Its two enums are closed on the wire: the `runners.*` entries are
 * client-local, so main and the window that reads them ship in one bundle
 * and always agree on the vocabulary. A problem this window does not name
 * still reaches the person through `message`.
 */
import {
  THIS_MAC_RUNNER_PROBLEMS,
  THIS_MAC_RUNNER_STATES,
  type ThisMacRunnerSnapshot,
} from "@volli/shared";
import { z } from "zod";

/** Bounds every text field; ids, names and one-sentence messages fit well inside it. */
const THIS_MAC_RUNNER_TEXT_MAX = 512;
const text = z.string().max(THIS_MAC_RUNNER_TEXT_MAX);

export const thisMacRunnerSnapshotSchema = z.object({
  state: z.enum(THIS_MAC_RUNNER_STATES),
  runnerId: text.min(1).nullable(),
  runnerName: text.nullable(),
  since: z.number().nullable(),
  waitingFacts: z.number().int().nonnegative(),
  problem: z.enum(THIS_MAC_RUNNER_PROBLEMS).nullable(),
  message: text.nullable(),
}) satisfies z.ZodType<ThisMacRunnerSnapshot>;
