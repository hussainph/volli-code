/**
 * A stdio MCP server leaves nothing running once Volli lets go of it (VC-470).
 *
 * Real processes, no fakes: a server started behind a launcher that keeps its
 * own child (the shape of `npx` and `uvx`), a server that starts a helper of
 * its own and would leave it behind on stdin close, and a host that exits
 * without closing anything. Each test reads the server's process group from
 * `ps` and waits for it to be empty.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerDraft } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createMcpProtocolClientOpener } from "./client";
import { MemoryMcpCredentialStore } from "./credential-store";
import { closeAllMcpSessionHosts, McpSessionHost } from "./session-host";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SERVER = join(FIXTURES, "stdio-server.mjs");
const WRAPPER = join(FIXTURES, "wrapper.mjs");
const QUITTING_HOST = join(FIXTURES, "quitting-host.mjs");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-mcp-stdio-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The process group a pid belongs to, read from `ps`. */
function groupOf(pid: number): number {
  return Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
}

/** Every pid still in a process group. */
function membersOf(group: number): number[] {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" }).stdout;
  return listed
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => pgid === group && pid !== undefined && !Number.isNaN(pid))
    .map(([pid]) => pid!);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 8_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

function pids(file: string): { server: number; sleeper: number } {
  return JSON.parse(readFileSync(file, "utf8")) as { server: number; sleeper: number };
}

function host(server: McpServerDraft, workspacePath = dir): McpSessionHost {
  return new McpSessionHost({
    workspacePath,
    servers: [server],
    open: createMcpProtocolClientOpener({
      sources: () => ({ store: new MemoryMcpCredentialStore(), environment: {} }),
    }),
  });
}

const call = { serverId: "stdio", toolName: "fixture_echo", arguments: {}, toolCallId: "one" };

describe.skipIf(process.platform === "win32")("stdio MCP server lifecycle", () => {
  it("ends the launcher, the server and the server's own children when a Session detaches", async () => {
    const pidFile = join(dir, "pids.json");
    const attachment = host({
      id: "stdio",
      name: "Wrapped",
      enabled: true,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [WRAPPER, SERVER, "--pid-file", pidFile],
      },
    });

    await expect(attachment.port.call(call, new AbortController().signal)).resolves.toMatchObject({
      isError: false,
    });
    const { server, sleeper } = pids(pidFile);
    const group = groupOf(server);
    // The launcher leads its own group, and everything it started is in it —
    // the reason one signal to the group reaches all of them.
    expect(groupOf(sleeper)).toBe(group);
    expect(group).not.toBe(groupOf(process.pid));
    expect(membersOf(group).length).toBeGreaterThanOrEqual(3);

    await attachment.close();

    expect(await until(() => membersOf(group).length === 0)).toBe(true);
    expect(alive(server)).toBe(false);
    expect(alive(sleeper)).toBe(false);
  });

  it.skipIf(spawnSync("npx", ["--version"]).status !== 0)(
    "leaves no process behind for a server started through npx",
    async () => {
      // A project whose local bin is the fixture, so `npx --no-install` runs
      // it through npm's real launcher without touching the registry.
      const project = join(dir, "project");
      const bin = join(project, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "fixture", private: true }),
      );
      const pidFile = join(dir, "npx-pids.json");
      const launcher = join(bin, "volli-fixture-mcp");
      writeFileSync(
        launcher,
        `#!/bin/sh\n"${process.execPath}" "${SERVER}" --pid-file "${pidFile}"\n`,
      );
      chmodSync(launcher, 0o755);
      const attachment = host(
        {
          id: "stdio",
          name: "Through npx",
          enabled: true,
          transport: { type: "stdio", command: "npx", args: ["--no-install", "volli-fixture-mcp"] },
        },
        project,
      );

      await expect(attachment.port.call(call, new AbortController().signal)).resolves.toMatchObject(
        { isError: false },
      );
      const { server, sleeper } = pids(pidFile);
      const group = groupOf(server);
      expect(groupOf(sleeper)).toBe(group);
      expect(membersOf(group).length).toBeGreaterThanOrEqual(3);

      await attachment.close();

      expect(await until(() => membersOf(group).length === 0)).toBe(true);
    },
    20_000,
  );

  it("ends every server's group when the host process exits without closing (app quit)", async () => {
    const pidFile = join(dir, "quit-pids.json");
    const child = spawn(process.execPath, [QUITTING_HOST, WRAPPER, SERVER, pidFile], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    expect(await exited).toBe(0);
    expect(output).toContain("connected");
    expect(existsSync(pidFile)).toBe(true);
    const { server, sleeper } = pids(pidFile);

    expect(await until(() => !alive(server) && !alive(sleeper))).toBe(true);
  });

  it("closes every live attachment's servers on quit, the backstop for one whose own close never ran", async () => {
    const pidFile = join(dir, "backstop-pids.json");
    const attachment = host({
      id: "stdio",
      name: "Forgotten",
      enabled: true,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [WRAPPER, SERVER, "--pid-file", pidFile],
      },
    });
    await attachment.port.call(call, new AbortController().signal);
    const { server, sleeper } = pids(pidFile);
    const group = groupOf(server);

    await closeAllMcpSessionHosts();

    expect(await until(() => membersOf(group).length === 0)).toBe(true);
    expect(alive(sleeper)).toBe(false);
    await expect(attachment.port.call(call, new AbortController().signal)).rejects.toThrow(
      "MCP attachment is closed",
    );
  });

  it("ends a server's leftover helpers when the server had already exited on its own", async () => {
    const pidFile = join(dir, "exited-pids.json");
    const attachment = host({
      id: "stdio",
      name: "Exits",
      enabled: true,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [SERVER, "--pid-file", pidFile],
      },
    });
    await attachment.port.call({ ...call, toolName: "fixture_exit" }, new AbortController().signal);
    const { server, sleeper } = pids(pidFile);
    expect(await until(() => !alive(server))).toBe(true);
    // pi-mcp signals the group only when it closes a live server: the helper
    // is still running here.
    expect(alive(sleeper)).toBe(true);

    await attachment.close();

    expect(await until(() => !alive(sleeper))).toBe(true);
  });

  it("refuses a stdio message over the bound at once, saying so, rather than waiting out the call", async () => {
    const attachment = host({
      id: "stdio",
      name: "Huge",
      enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [SERVER] },
    });
    const started = Date.now();

    const result = await attachment.port.call(
      { ...call, toolName: "fixture_too_large" },
      new AbortController().signal,
    );
    await attachment.close();

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("larger than the 8 MiB limit");
  }, 30_000);

  it("starts a local server in the project root with only the allowlist and the person's own env entries", async () => {
    process.env["VOLLI_TEST_PARENT_ONLY"] = "must-not-leak";
    try {
      const sentinel = `stdio-secret-${Date.now()}`;
      const store = new MemoryMcpCredentialStore();
      store.update("stdio", () => ({ secrets: { "env:FIXTURE_SECRET": sentinel } }));
      const attachment = new McpSessionHost({
        workspacePath: dir,
        servers: [
          {
            id: "stdio",
            name: "Env",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [SERVER],
              env: [{ name: "FIXTURE_SECRET", source: { kind: "secret" } }],
            },
          },
        ],
        open: createMcpProtocolClientOpener({
          sources: () => ({ store, environment: process.env }),
        }),
      });

      const result = await attachment.port.call(
        { ...call, toolName: "fixture_env" },
        new AbortController().signal,
      );
      await attachment.close();

      const { createHash } = await import("node:crypto");
      expect(result.structuredContent).toEqual({
        secretSha256: createHash("sha256").update(sentinel).digest("hex"),
        parentOnlyLeaked: false,
        cwd: expect.stringContaining("volli-mcp-stdio-"),
      });
      expect(JSON.stringify(result)).not.toContain(sentinel);
    } finally {
      delete process.env["VOLLI_TEST_PARENT_ONLY"];
    }
  });
});
