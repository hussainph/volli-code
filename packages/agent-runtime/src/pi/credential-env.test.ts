import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, NodeExecutionEnv } from "./harness-env";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
    // Tool stores at their other platform and relocated paths (VC-840).
    "/work/project/_netrc",
    "/home/u/.config/git/credentials",
    "/xdg/gh/hosts.yml",
    "/home/u/.kube/config-staging",
    "/home/u/.config/gcloud/credentials.db",
    "/data/volli.db.backup-v58",
  ])
    expect(credentialPath(path)).toBe(true);
  for (const path of [
    "/work/readme",
    "/work/.environment",
    "/work/code.ts",
    "/work/.npmrc",
    "/work/ansible/hosts.yml",
    "/work/docker/config.json",
    "/work/kubernetes/config",
  ])
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

describe("home and tool credential stores (VC-840)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses each store directly and through a workspace symlink, and keeps ordinary dotfiles and a project .npmrc readable", async () => {
    const root = mkdtempSync(join(process.cwd(), ".credential-read-test-"));
    const home = join(root, "home");
    const workspace = join(home, "project");
    mkdirSync(workspace, { recursive: true });
    // `os.homedir()` reads HOME at call time on POSIX.
    vi.stubEnv("HOME", home);
    try {
      const env = refusingCredentialReads(new NodeExecutionEnv({ cwd: workspace }), workspace);
      const stores = [
        ".netrc",
        "_netrc",
        ".git-credentials",
        ".config/gh/hosts.yml",
        ".npmrc",
        ".pypirc",
        ".docker/config.json",
        ".kube/config",
        ".claude/.credentials.json",
        ".config/gcloud/application_default_credentials.json",
        "Library/Application Support/Volli/volli.db",
        "Library/Application Support/Volli/volli.db-wal",
        "Library/Application Support/Volli/volli.db-shm",
      ];
      for (const [index, store] of stores.entries()) {
        const target = join(home, store);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "credential-read-sentinel");
        await expect(env.readTextFile(target, BACKGROUND_CONTEXT), store).rejects.toThrow(
          "refuses credential-file reads",
        );
        const link = `innocent-${index}.txt`;
        symlinkSync(target, join(workspace, link));
        await expect(env.readTextFile(link, BACKGROUND_CONTEXT), store).rejects.toThrow(
          "refuses credential-file reads",
        );
      }
      writeFileSync(join(home, ".zshrc"), "export EDITOR=vi");
      expect(await env.readTextFile(join(home, ".zshrc"), BACKGROUND_CONTEXT)).toMatchObject({
        ok: true,
        value: "export EDITOR=vi",
      });
      symlinkSync(join(home, ".zshrc"), join(workspace, "shell.txt"));
      expect(await env.readTextFile("shell.txt", BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
      // A project's registry config is ordinary project material.
      writeFileSync(join(workspace, ".npmrc"), "registry=https://registry.npmjs.org/");
      writeFileSync(join(workspace, ".pypirc"), "[distutils]\nindex-servers = pypi");
      expect(await env.readTextFile(".npmrc", BACKGROUND_CONTEXT)).toMatchObject({
        ok: true,
        value: "registry=https://registry.npmjs.org/",
      });
      expect(await env.readTextFile(".pypirc", BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
