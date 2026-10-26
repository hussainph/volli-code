import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";

import { api } from "../functions/_generated/api";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

describe("health.whoami", () => {
  test("refuses an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.health.whoami, {})).rejects.toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "unauthenticated" }) }),
    );
  });

  test("answers with the caller's identity", async () => {
    const t = convexTest(schema, modules);
    const asAlice = t.withIdentity({ subject: "user:alice", issuer: "https://issuer.test" });
    await expect(asAlice.query(api.health.whoami, {})).resolves.toEqual({
      subject: "user:alice",
      issuer: "https://issuer.test",
    });
  });
});
