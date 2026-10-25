/**
 * A Volli Cloud project's folder on this Mac (VC-895 N2-3; wire types in
 * `@volli/shared`'s `cloud-checkout.ts`), for the desktop-only tier's
 * `checkouts.*` procedures. Exact outputs, no transforms, so they publish
 * with `z.toJSONSchema`. No schema has a field that could carry a path: the
 * folder stays in this Mac's runner-local registry.
 *
 * Its enums are closed on the wire: the `checkouts.*` entries are
 * client-local, so main and the window that reads them ship in one bundle.
 */
import {
  CLOUD_CHECKOUT_STATES,
  type CloudCheckoutChoice,
  type CloudCheckoutStatus,
} from "@volli/shared";
import { z } from "zod";

/** Bounds an id; main checks a project id's shape before it reaches Volli Cloud. */
const id = z.string().min(1).max(512);

export const cloudCheckoutInputSchema = z.strictObject({ projectId: id });

/** Outputs strip unknown fields, so nothing a port adds reaches the window. */
export const cloudCheckoutStatusSchema = z.object({
  state: z.enum(CLOUD_CHECKOUT_STATES),
}) satisfies z.ZodType<CloudCheckoutStatus>;

export const cloudCheckoutChoiceSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("chosen"), projectRepoId: id }),
  z.object({ outcome: z.literal("cancelled") }),
]) satisfies z.ZodType<CloudCheckoutChoice>;
