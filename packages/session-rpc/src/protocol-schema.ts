/** Build-time projection of both catalog tiers. Add area/desktop providers here,
 * never hand-write JSON Schema. Public providers exhaust the Verb Registry;
 * desktop-only providers publish the private bridge's schemas without new rows.
 */
import { HOST_PROTOCOL_VERSION } from "@volli/host-protocol";
import { CATALOG_ENTRIES } from "@volli/shared";
import { z } from "zod";

import { sessionProcedureSchemas, type SessionProcedureSchema } from "./index";

export interface ProtocolSchemaProvider {
  readonly tier: "public" | "desktop";
  readonly procedures: () => Readonly<Record<string, SessionProcedureSchema>>;
}

// VC-608 adds its desktop-only schema provider here. Do not filter its entries
// out of generation/diff just because they have no public ceremony.
export function generateProtocolSchema(
  providers: readonly ProtocolSchemaProvider[] = [
    { tier: "public", procedures: sessionProcedureSchemas },
  ],
  publicEntries: readonly { key: string }[] = CATALOG_ENTRIES,
) {
  const tiers: Record<string, Record<string, unknown>> = { public: {}, desktop: {} };
  const seen = new Set<string>();
  const publicKeys = new Set<string>();
  for (const { tier, procedures } of providers) {
    for (const [key, procedure] of Object.entries(procedures())) {
      if (seen.has(key)) throw new Error(`Duplicate schema provider for ${key}`);
      seen.add(key);
      if (tier === "public") publicKeys.add(key);
      tiers[tier]![key] = {
        kind: procedure.type,
        input: z.toJSONSchema(procedure.input, { io: "input" }),
        output: z.toJSONSchema(procedure.output, { io: "output" }),
        noInput: procedure.noInput,
        voidOutput: procedure.voidOutput,
        outputValidation: procedure.outputValidation,
      };
    }
  }
  const missing = publicEntries.filter(({ key }) => !publicKeys.has(key));
  const extra = [...publicKeys].filter((key) => !publicEntries.some((entry) => entry.key === key));
  if (missing.length || extra.length)
    throw new Error(
      `Schema/catalog mismatch: missing ${missing.map(({ key }) => key)}; extra ${extra}`,
    );
  return { protocolVersion: HOST_PROTOCOL_VERSION, tiers };
}
