import { boardProcedureSchemas } from "./board-router";
import { desktopProcedureSchemas } from "./desktop-router";
/** Build-time projection of both catalog tiers. Add area/desktop providers here,
 * never hand-write JSON Schema. Public providers exhaust the Verb Registry;
 * desktop-only providers publish the private bridge's schemas without new rows.
 */
import {
  HOST_PROTOCOL_VERSION,
  HOST_BASE_OPERATIONS,
  HOST_FEATURE_OPERATIONS,
  HOST_TRACE_FIELD,
} from "@volli/host-protocol";
import { CATALOG_ENTRIES, DESKTOP_ENTRIES } from "@volli/shared";
import { z } from "zod";

import { sessionProcedureSchemas, type ProcedureSchema } from "./index";

/**
 * The optional fields a JSON-RPC frame may carry beside `id`, `method` and
 * `params` (HP § Tracing and logs). Published so the gate holds them to the
 * same rule as an input: a field may be added, never removed or narrowed.
 */
export const ENVELOPE_FIELD_SCHEMAS = {
  [HOST_TRACE_FIELD]: z
    .object({
      traceId: z.string().regex(/^[0-9a-f]{32}$/u),
      spanId: z.string().regex(/^[0-9a-f]{16}$/u),
    })
    .describe(
      "Optional. The operation this request belongs to (traceId) and this request (spanId), W3C Trace Context shaped. The host echoes it in every log line it writes while serving the request; a malformed one is ignored.",
    ),
} as const;

export interface ProtocolSchemaProvider {
  readonly tier: "public" | "desktop";
  readonly procedures: () => Readonly<Record<string, ProcedureSchema>>;
}

// The desktop-only tier (VC-608) is generated and diffed like the public one:
// no public ceremony, but the same additive-only gate.
export function generateProtocolSchema(
  providers: readonly ProtocolSchemaProvider[] = [
    { tier: "public", procedures: sessionProcedureSchemas },
    { tier: "public", procedures: boardProcedureSchemas },
    { tier: "desktop", procedures: desktopProcedureSchemas },
  ],
  publicEntries: readonly { key: string }[] = CATALOG_ENTRIES,
  desktopEntries: readonly { key: string }[] = DESKTOP_ENTRIES,
) {
  const tiers: Record<string, Record<string, unknown>> = { public: {}, desktop: {} };
  const seen = new Set<string>();
  const publicKeys = new Set<string>();
  const desktopKeys = new Set<string>();
  for (const { tier, procedures } of providers) {
    for (const [key, procedure] of Object.entries(procedures())) {
      if (seen.has(key)) throw new Error(`Duplicate schema provider for ${key}`);
      seen.add(key);
      (tier === "public" ? publicKeys : desktopKeys).add(key);
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
  // The desktop-only tier publishes exactly its declared entries, too.
  const unpublished = desktopEntries.filter(({ key }) => !desktopKeys.has(key));
  const undeclared = [...desktopKeys].filter(
    (key) => !desktopEntries.some((entry) => entry.key === key),
  );
  if (unpublished.length || undeclared.length)
    throw new Error(
      `Schema/desktop-tier mismatch: missing ${unpublished.map(({ key }) => key)}; extra ${undeclared}`,
    );
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    baseOperations: HOST_BASE_OPERATIONS,
    features: HOST_FEATURE_OPERATIONS,
    envelope: Object.fromEntries(
      Object.entries(ENVELOPE_FIELD_SCHEMAS).map(([field, schema]) => [
        field,
        z.toJSONSchema(schema, { io: "input" }),
      ]),
    ),
    tiers,
  };
}
