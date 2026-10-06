/** Build-time grammar from the same validators each area router binds. */
import type { AnyProcedure, AnyRouter } from "@trpc/server";
import { z } from "zod";

export interface ProcedureSchema {
  readonly type: "query" | "mutation" | "subscription";
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly noInput: boolean;
  readonly voidOutput: boolean;
  readonly outputValidation: "network-and-tests" | "documented-yield" | "legacy-documentation";
}

export function procedureSchemas(
  router: AnyRouter,
  supplementalOutputs: Readonly<Record<string, z.ZodType>> = {},
  inputView: (key: string, input: z.ZodType | undefined) => z.ZodType = (_key, input) =>
    input ?? z.null(),
  voidOutputs: readonly string[] = [],
): Record<string, ProcedureSchema> {
  // oxlint-disable-next-line no-underscore-dangle -- tRPC's pinned introspection door.
  const procedures = router._def.procedures as Readonly<Record<string, AnyProcedure>>;
  return Object.fromEntries(
    Object.entries(procedures).map(([key, procedure]): [string, ProcedureSchema] => {
      // oxlint-disable-next-line no-underscore-dangle -- as above.
      const definition = procedure._def as unknown as {
        type: "query" | "mutation" | "subscription";
        inputs: readonly z.ZodType[];
        output?: z.ZodType;
      };
      const inputs = definition.inputs;
      if (inputs.length > 1) throw new Error(`Procedure ${key} has multiple input schemas`);
      const output = definition.output ?? supplementalOutputs[key];
      if (output === undefined)
        throw new Error(`Procedure ${key} has no publishable output schema`);
      return [
        key,
        {
          type: definition.type,
          input: inputView(key, inputs[0]),
          output,
          noInput: inputs.length === 0,
          voidOutput: voidOutputs.includes(key),
          outputValidation:
            definition.type === "subscription"
              ? "documented-yield"
              : definition.output
                ? "network-and-tests"
                : "legacy-documentation",
        },
      ];
    }),
  );
}
