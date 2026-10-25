import { describe, expect, test } from "vite-plus/test";

import { api } from "../functions/_generated/api";
import { TEST_ISSUER } from "../functions/auth.config";
import { createTestIssuer, mintTestToken } from "../fixture/jwt";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();

describe("health.whoami on the pinned local backend", () => {
  test("refuses an anonymous caller", async () => {
    await expect(backend.client().query(api.health.whoami, {})).rejects.toThrow("Unauthenticated");
  });

  test("accepts a token from the test issuer, for any user", async () => {
    for (const subject of ["user:alice", "user:bob"]) {
      await expect(backend.client(subject).query(api.health.whoami, {})).resolves.toEqual({
        subject,
        issuer: TEST_ISSUER,
      });
    }
  });

  test("rejects a token signed by any other key", async () => {
    const forged = mintTestToken(createTestIssuer().privateKeyPem, "user:mallory");
    const client = backend.client();
    client.setAuth(forged);
    await expect(client.query(api.health.whoami, {})).rejects.toThrow();
  });

  test("rejects an expired token", async () => {
    const client = backend.client("user:alice", { ttlSeconds: -60 });
    await expect(client.query(api.health.whoami, {})).rejects.toThrow();
  });
});
