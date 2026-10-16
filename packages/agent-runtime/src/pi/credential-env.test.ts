import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, NodeExecutionEnv } from "./harness-env";
import { describe, expect, it } from "vite-plus/test";
import { refusingCredentialReads } from "./credential-env";

describe("credential-file read refusal", () => {
  it("refuses stores and project .env even behind a symlink, independent of authority mode", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".credential-read-test-"));
    try {
      const env = refusingCredentialReads(new NodeExecutionEnv({ cwd: dir }), dir);
      for (const name of [
        ".env",
        ".env.production",
        "mcp-credentials.json",
        "session-secrets.enc",
        "auth.json",
      ]) {
        writeFileSync(join(dir, name), "credential-read-sentinel");
        for (const method of [
          "readTextFile",
          "readBinaryFile",
          "readTextLines",
          "openTextLineReader",
        ] as const) {
          const result =
            method === "readTextLines"
              ? env[method](name, undefined, BACKGROUND_CONTEXT)
              : env[method](name, BACKGROUND_CONTEXT);
          await expect(result).rejects.toThrow("refuses credential-file reads");
        }
      }
      symlinkSync(join(dir, ".env"), join(dir, "innocent.txt"));
      await expect(env.readTextFile("innocent.txt", BACKGROUND_CONTEXT)).rejects.toThrow(
        "refuses credential-file reads",
      );
      writeFileSync(join(dir, "readme.txt"), "safe");
      expect(await env.readTextFile("readme.txt", BACKGROUND_CONTEXT)).toMatchObject({
        ok: true,
        value: "safe",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("recognizes all credential-store shapes and preserves ordinary environment members and missing-file errors", async () => {
  const { credentialPath } = await import("./credential-env");
  for (const path of [
    "/home/.ssh/config",
    "/home/.aws/credentials",
    "/home/.gnupg/key",
    "/home/Keychains/a",
    "/work/credentials/key",
    "/home/mcp-auth.json",
    "/work/session-secrets.enc.123.tmp",
    "/data/session-secrets.key",
    "/data/host-credentials.enc",
    "/data/host-credentials.enc.123.abcdef012345.tmp",
    "/data/host-credentials.enc.locked-20261005T000000Z-abcd1234",
    "/data/host-credentials.lock",
    // Desktop's keychain-wrapped inventory key (VC-643).
    "/data/host-credentials.key",
  ])
    expect(credentialPath(path)).toBe(true);
  for (const path of ["/work/readme", "/work/.environment", "/work/code.ts"])
    expect(credentialPath(path)).toBe(false);
  const dir = mkdtempSync(join(process.cwd(), ".credential-read-test-"));
  try {
    const env = refusingCredentialReads(new NodeExecutionEnv({ cwd: dir }), dir);
    expect(env.cwd).toBe(dir);
    expect(await env.exists("missing.txt", BACKGROUND_CONTEXT)).toMatchObject({
      ok: true,
      value: false,
    });
    expect(await env.readTextFile("missing.txt", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
