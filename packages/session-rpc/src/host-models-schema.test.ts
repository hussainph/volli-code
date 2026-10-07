import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { HANDLER_PROJECTION_KEYS } from "@volli/shared";
import { DESKTOP_IPC_PATHS, sessionProcedureSchemas } from "./index";

function enums(value: unknown): Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [...(Array.isArray(node.enum) ? [node] : []), ...Object.values(node).flatMap(enums)];
}

describe("the host-only Model Access wire projection", () => {
  it.each(HANDLER_PROJECTION_KEYS)(
    "%s reuses the existing grammar and is never local IPC",
    (path) => {
      const schemas = sessionProcedureSchemas();
      const alias = schemas[path]!;
      const original = schemas[path.replace("hostModels.", "modelAccess.")]!;
      expect(z.toJSONSchema(alias.input, { io: "input" })).toEqual(
        z.toJSONSchema(original.input, { io: "input" }),
      );
      expect(alias.output).toBe(original.output);
      expect(alias.type).toBe(original.type);
      expect(alias.noInput).toBe(original.noInput);
      expect(alias.outputValidation).toBe("network-and-tests");
      expect(DESKTOP_IPC_PATHS as readonly string[]).not.toContain(path);
      // Deliberately closed: the screen's strict readers cannot interpret future
      // availability, billing, reasoning, Code Mode or picker-view values.
      for (const scalar of enums(z.toJSONSchema(alias.output))) {
        expect(scalar["x-volli-open-enum"]).toBeUndefined();
      }
    },
  );

  it("rejects future output enum values rather than implying reader tolerance", () => {
    const schemas = sessionProcedureSchemas();
    expect(schemas["hostModels.pickerView"]!.output.safeParse("future-view").success).toBe(false);
    expect(
      schemas["hostModels.codeModePolicy"]!.output.safeParse({
        enabled: true,
        models: { "fixture/model": "future-mode" },
      }).success,
    ).toBe(false);
    expect(
      schemas["hostModels.defaults"]!.output.safeParse({
        global: { providerId: "fixture", modelId: "model", reasoningLevel: "future-level" },
      }).success,
    ).toBe(false);
    expect(
      schemas["hostModels.inspect"]!.output.safeParse({
        observedAt: 0,
        providers: [],
        models: [
          {
            providerId: "fixture",
            modelId: "model",
            label: "Model",
            state: "future-state",
            reasoningLevels: ["off"],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
