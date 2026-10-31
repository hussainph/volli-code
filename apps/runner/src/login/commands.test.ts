import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { piHostCredentials } from "@volli/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { testContext } from "../testing/context";
import {
  asServiceUser,
  loginCommand,
  logoutCommand,
  runModelCommand,
  type LoginPorts,
} from "./commands";
import { runnerDeviceId } from "./device-id";
import { runnerModelAccess, runnerModelKeyPath } from "./model-access";
import { bufferedTerminal } from "./terminal";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const roots: string[] = [];
function fixture() {
  const base = resolve(".scratch/login-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "command-"));
  roots.push(root);
  const context = testContext({ root });
  const paths = {
    mode: "user" as const,
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
  };
  const access = runnerModelAccess({ ...paths, env: {} });
  const input = new PassThrough();
  const ports: LoginPorts = {
    models: () => access,
    terminal: () => bufferedTerminal(input, false, context.err, () => input.pause()),
    asServiceUser: vi.fn(() => 0),
  };
  return { root, context, paths, access, input, ports };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const commandInput = (
  provider: string | undefined,
  values: Record<string, string | boolean> = {},
) => ({ positionals: provider === undefined ? [] : [provider], values });

describe("runner login/logout commands", () => {
  it("drives Pi's real API-key flow into the sealed store and the daemon's availability read", async () => {
    const f = fixture();
    const result = runModelCommand(
      "login",
      commandInput("anthropic", { "api-key": true }),
      f.context,
      f.ports,
    );
    f.input.end("TEST-only-anthropic-key\n");
    expect(await result).toBe(0);
    expect(f.context.stderr()).not.toContain("TEST-only-anthropic-key");
    expect(existsSync(join(f.paths.dataDir, "models", "auth.json"))).toBe(false);
    expect(
      readFileSync(join(f.paths.dataDir, "host-credentials.enc")).includes(
        Buffer.from("TEST-only-anthropic-key"),
      ),
    ).toBe(false);
    const daemon = runnerModelAccess({ ...f.paths, env: {} });
    expect(await piHostCredentials(daemon.credentials).stored()).toContainEqual({
      providerId: "anthropic",
      type: "api-key",
      expiresAt: null,
    });
    expect(
      await runModelCommand("login", commandInput(undefined, { status: true }), f.context, f.ports),
    ).toBe(0);
    expect(f.context.stdout()).toContain("anthropic: stored API key");
    expect(await runModelCommand("logout", commandInput("anthropic"), f.context, f.ports)).toBe(0);
    expect(await daemon.credentials.list()).toEqual([]);
  });

  it("lists login methods without a provider and reports empty/filtered status", async () => {
    const f = fixture();
    expect(await runModelCommand("login", commandInput(undefined), f.context, f.ports)).toBe(0);
    expect(f.context.stdout()).toContain("anthropic:");
    expect(f.context.stdout()).toContain("--api-key");
    await f.access.credentials.modify("openai", async () => ({
      type: "oauth",
      access: "TEST-access",
      refresh: "TEST-refresh",
      expires: 9999999999999,
    }));
    expect(
      await runModelCommand("login", commandInput("openai", { status: true }), f.context, f.ports),
    ).toBe(0);
    expect(f.context.stdout()).toContain("stored OAuth sign-in");
    expect(
      await runModelCommand(
        "login",
        commandInput("anthropic", { status: true }),
        f.context,
        f.ports,
      ),
    ).toBe(0);
    expect(f.context.stdout()).toContain("No stored model sign-ins");
  });

  it("does not offer interactive login for ambient-only providers", async () => {
    const f = fixture();
    vi.spyOn(f.access.models, "getProviders").mockReturnValue([
      { ...f.access.models.getProvider("anthropic")!, auth: {} },
    ]);
    expect(await runModelCommand("login", commandInput(undefined), f.context, f.ports)).toBe(0);
    expect(f.context.stdout()).not.toContain("anthropic:");
  });

  it("refuses unknown providers, missing logout provider, and incompatible flags", async () => {
    const f = fixture();
    expect(await runModelCommand("login", commandInput("unknown"), f.context, f.ports)).toBe(2);
    expect(await runModelCommand("logout", commandInput(undefined), f.context, f.ports)).toBe(2);
    expect(
      await runModelCommand(
        "login",
        commandInput("anthropic", { status: true, "api-key": true }),
        f.context,
        f.ports,
      ),
    ).toBe(2);
  });

  it("switches root to the service account before opening any model store", async () => {
    const f = fixture();
    const models = vi.fn(f.ports.models);
    const context = { ...f.context, uid: 0 };
    expect(
      await runModelCommand("login", commandInput("anthropic", { "api-key": true }), context, {
        ...f.ports,
        models,
      }),
    ).toBe(0);
    expect(models).not.toHaveBeenCalled();
    expect(f.ports.asServiceUser).toHaveBeenCalledWith(
      "login",
      expect.anything(),
      { mode: "system", dataDir: "/var/lib/volli-runner", configDir: "/etc/volli-runner" },
      context,
    );
  });

  it("resolves system paths for a non-root service user and preserves explicit paths", async () => {
    const f = fixture();
    const models = vi.fn(f.ports.models);
    const context = { ...f.context, env: { VOLLI_RUNNER_INSTALL_MODE: "system" } };
    await runModelCommand(
      "login",
      commandInput(undefined, {
        status: true,
        "data-dir": f.paths.dataDir,
        "config-dir": f.paths.configDir,
      }),
      context,
      { ...f.ports, models },
    );
    expect(models).toHaveBeenCalledWith({ ...f.paths, mode: "system" }, context);
  });

  it("finds the system store when invoked directly as the service user", async () => {
    const f = fixture();
    const models = vi.fn(f.ports.models);
    const context = { ...f.context, home: "/var/lib/volli-runner" };
    expect(
      await runModelCommand("login", commandInput(undefined, { status: true }), context, {
        ...f.ports,
        models,
      }),
    ).toBe(0);
    expect(models).toHaveBeenCalledWith(
      { mode: "system", dataDir: "/var/lib/volli-runner", configDir: "/etc/volli-runner" },
      context,
    );
  });

  it("withholds setup and sign-out exceptions", async () => {
    const f = fixture();
    expect(
      await runModelCommand("login", commandInput(undefined), f.context, {
        ...f.ports,
        models: () => {
          throw new Error("secret");
        },
      }),
    ).toBe(1);
    vi.spyOn(f.access.models, "logout").mockRejectedValue(new Error("secret"));
    expect(await runModelCommand("logout", commandInput("anthropic"), f.context, f.ports)).toBe(1);
    expect(f.context.stderr()).not.toContain("secret\n");
  });

  it("chooses OAuth by default and supplies a stable installation id to Pi", async () => {
    const f = fixture();
    const login = vi
      .spyOn(f.access.models, "login")
      .mockImplementation(async (_id, type, interaction, options) => {
        expect(type).toBe("oauth");
        expect(options?.getDeviceId?.()).toBe(runnerDeviceId(f.paths.dataDir));
        interaction.notify({
          type: "device_code",
          userCode: "ABCD",
          verificationUri: "https://example.com/device",
        });
        return { type: "oauth", access: "TEST-access", refresh: "TEST-refresh", expires: 123 };
      });
    expect(
      await runModelCommand(
        "login",
        commandInput("anthropic", { "data-dir": f.paths.dataDir, "config-dir": f.paths.configDir }),
        f.context,
        f.ports,
      ),
    ).toBe(0);
    expect(login).toHaveBeenCalledOnce();
  });

  it("drives the paste-code selection through Pi's prompt codec and the sign-in service", async () => {
    const f = fixture();
    vi.spyOn(f.access.models, "login").mockImplementation(async (_id, _type, interaction) => {
      expect(
        await interaction.prompt({
          type: "select",
          message: "Login method",
          options: [{ id: "copy_code", label: "Copy code login (headless)" }],
        }),
      ).toBe("copy_code");
      interaction.notify({
        type: "auth_url",
        url: "https://example.com/oauth",
        instructions: "Copy the code",
      });
      expect(await interaction.prompt({ type: "manual_code", message: "Paste the code" })).toBe(
        "TEST-only-code",
      );
      return { type: "oauth", access: "TEST-access", refresh: "TEST-refresh", expires: 123 };
    });
    const run = runModelCommand("login", commandInput("anthropic"), f.context, f.ports);
    f.input.end("copy_code\nTEST-only-code\n");
    expect(await run).toBe(0);
    expect(f.context.stderr()).not.toContain("TEST-only-code");
    expect(f.context.stderr()).not.toContain("ssh -L");
  });

  it("withdraws a pasted URL when a real loopback callback wins through Pi's codec", async () => {
    const f = fixture();
    const callback = Promise.withResolvers<string>();
    const server = createServer((request, response) => {
      callback.resolve(new URL(request.url!, "http://localhost").searchParams.get("code")!);
      response.end("Signed in");
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback?code=TEST-callback-code`;
    vi.spyOn(f.access.models, "login").mockImplementation(async (_id, _type, interaction) => {
      const withdrawal = new AbortController();
      interaction.notify({
        type: "auth_url",
        url: "https://example.com/authorize",
        instructions: "Approve in browser",
      });
      const pasted = interaction
        .prompt({ type: "manual_code", message: "Paste redirect URL", signal: withdrawal.signal })
        .catch(() => "withdrawn");
      expect(await (await fetch(url)).text()).toBe("Signed in");
      expect(await callback.promise).toBe("TEST-callback-code");
      withdrawal.abort();
      expect(await pasted).toBe("withdrawn");
      return { type: "oauth", access: "TEST-access", refresh: "TEST-refresh", expires: 123 };
    });
    try {
      expect(await runModelCommand("login", commandInput("anthropic"), f.context, f.ports)).toBe(0);
      expect(f.context.stderr()).not.toContain("TEST-callback-code");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("falls back to the API key flow for API-only providers", async () => {
    const f = fixture();
    const run = runModelCommand("login", commandInput("deepseek"), f.context, f.ports);
    f.input.end("TEST-deepseek-key\n");
    expect(await run).toBe(0);
  });

  it("runs the live command descriptor over stdin into the sealed store", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      err: (text: string) => {
        f.context.err(text);
        if (text.includes("Enter Anthropic API key"))
          queueMicrotask(() => process.stdin.emit("data", Buffer.from("TEST-live-command-key\n")));
      },
    };
    const input = commandInput("anthropic", {
      "api-key": true,
      "data-dir": f.paths.dataDir,
      "config-dir": f.paths.configDir,
    });
    expect(await loginCommand.run(input, context)).toBe(0);
    expect(await f.access.credentials.list()).toContainEqual({
      providerId: "anthropic",
      type: "api_key",
    });
    expect(f.context.stderr()).not.toContain("TEST-live-command-key");
  });

  it("command descriptors route to the live factory for provider listings/status", async () => {
    const f = fixture();
    const input = commandInput(undefined, {
      "data-dir": f.paths.dataDir,
      "config-dir": f.paths.configDir,
      status: true,
    });
    expect(await loginCommand.run(input, f.context)).toBe(0);
    expect(await logoutCommand.run(commandInput(undefined), f.context)).toBe(2);
  });
});

describe("runner model profile", () => {
  it("uses a stable device id without reading the person's Pi directory", () => {
    const f = fixture();
    expect(runnerDeviceId(f.paths.dataDir)).toBe(runnerDeviceId(f.paths.dataDir));
    writeFileSync(join(f.paths.dataDir, "model-device-id"), "invalid");
    expect(() => runnerDeviceId(f.paths.dataDir)).toThrow("Invalid model device id");
    rmSync(join(f.paths.dataDir, "model-device-id"));
    mkdirSync(join(f.paths.dataDir, "model-device-id"));
    expect(() => runnerDeviceId(f.paths.dataDir)).toThrow();
    expect(() => runnerDeviceId(join(f.root, "missing"))).toThrow();
  });
  it("re-execs as volli with the original pipe/tty and explicit service paths, never a key argument", () => {
    const f = fixture();
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    expect(
      asServiceUser(
        "login",
        commandInput("anthropic", { "api-key": true, status: true }),
        f.paths,
        f.context,
      ),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      "runuser",
      expect.arrayContaining([
        "-u",
        "volli",
        "--",
        "VOLLI_RUNNER_INSTALL_MODE=system",
        `VOLLI_SECRET_KEY_FILE=${join(f.paths.configDir, "session-secrets.key")}`,
        "--api-key",
        "--status",
        "--data-dir",
        f.paths.dataDir,
      ]),
      { stdio: "inherit" },
    );
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      error: new Error("no runuser"),
    } as ReturnType<typeof spawnSync>);
    expect(asServiceUser("logout", commandInput("anthropic"), f.paths, f.context)).toBe(1);
    expect(f.context.stderr()).toContain("service user");
  });

  it("uses the service key override and refuses relative key paths", () => {
    const f = fixture();
    expect(runnerModelKeyPath({ ...f.paths, env: {} })).toBe(
      join(f.paths.configDir, "session-secrets.key"),
    );
    expect(runnerModelKeyPath({ ...f.paths, env: { VOLLI_SECRET_KEY_FILE: "" } })).toBe(
      join(f.paths.configDir, "session-secrets.key"),
    );
    expect(runnerModelKeyPath({ ...f.paths, env: { VOLLI_SECRET_KEY_FILE: "/service/key" } })).toBe(
      "/service/key",
    );
    expect(() =>
      runnerModelAccess({ ...f.paths, env: { VOLLI_SECRET_KEY_FILE: "relative" } }),
    ).toThrow("absolute path");
  });
});
