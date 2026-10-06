import { initTRPC, type AnyRouter } from "@trpc/server";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { procedureSchemas } from "./procedure-schema";

const rpc = initTRPC.create();

describe("area-neutral procedure schema projection", () => {
  it("publishes no-input sentinels and input validators through the default view", () => {
    const router = rpc.router({
      read: rpc.procedure.output(z.string()).query(() => "ready"),
      echo: rpc.procedure
        .input(z.string())
        .output(z.string())
        .query(({ input }) => input),
    });
    const schemas = procedureSchemas(router);
    expect(schemas.read!.noInput).toBe(true);
    expect(z.toJSONSchema(schemas.read!.input)).toMatchObject({ type: "null" });
    expect(schemas.read!.outputValidation).toBe("network-and-tests");

    expect(schemas.echo!.noInput).toBe(false);
    expect(schemas.echo!.input.parse("value")).toBe("value");
  });
  it("never claims that a bound subscription output validates its individual yields", () => {
    const router = {
      _def: {
        procedures: {
          events: {
            _def: {
              type: "subscription",
              inputs: [],
              output: z.string(),
            },
          },
        },
      },
    } as unknown as AnyRouter;
    expect(procedureSchemas(router).events!.outputValidation).toBe("documented-yield");
  });
});
