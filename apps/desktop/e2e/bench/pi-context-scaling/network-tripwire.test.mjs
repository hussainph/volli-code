import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const { describeConnect, isLoopbackHost, SELF_TEST_HOST } = createRequire(import.meta.url)(
  "./network-policy.cjs",
);
const execFileAsync = promisify(execFile);

describe("VC-445 network policy", () => {
  it("lets through loopback addresses and nothing that merely starts like one", () => {
    for (const host of [undefined, "", "localhost", "127.0.0.1", "127.9.8.7", "::1", "[::1]"]) {
      expect(isLoopbackHost(host), String(host)).toBe(true);
    }
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    for (const host of [
      "127.0.0.1.evil.com",
      "127.x.evil.com",
      "127.0.0.300",
      "localhost.evil.com",
      "api.openai.com",
      SELF_TEST_HOST,
      "10.0.0.1",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("reads every connect overload", () => {
    expect(describeConnect([{ path: "/tmp/volli.sock" }])).toEqual({
      kind: "unix",
      path: "/tmp/volli.sock",
    });
    expect(describeConnect(["/tmp/volli.sock"])).toEqual({ kind: "unix", path: "/tmp/volli.sock" });
    expect(describeConnect([{ host: "a.test", port: 443 }])).toEqual({
      kind: "tcp",
      host: "a.test",
      port: 443,
    });
    expect(describeConnect([443, "a.test"])).toEqual({ kind: "tcp", host: "a.test", port: 443 });
    expect(describeConnect(["443"])).toEqual({ kind: "tcp", host: undefined, port: "443" });
    expect(describeConnect([[{ host: "b.test", port: 80 }, null]])).toEqual({
      kind: "tcp",
      host: "b.test",
      port: 80,
    });
  });
});

/**
 * The tripwire patches `net` for the whole process, so it is exercised in a
 * child Node, never in the test runner's own.
 */
const probe = `
const net = require("node:net");
const state = globalThis.VOLLI_NETWORK_TRIPWIRE;
const connect = (options) => new Promise((resolve) => {
  const socket = net.connect(options);
  socket.once("connect", () => { socket.destroy(); resolve("connected"); });
  socket.once("error", (error) => resolve(error.code));
});
(async () => {
  const server = net.createServer((socket) => socket.end()).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const loopback = await connect({ host: "127.0.0.1", port: server.address().port });
  const refused = await connect({ host: "192.0.2.1", port: 80 });
  const fetched = await fetch("http://192.0.2.1/").then(() => "fetched", () => "rejected");
  state.selfTestArmed = true;
  const selfTest = await connect({ host: "192.0.2.1", port: 80 });
  state.selfTestArmed = false;
  server.close();
  process.stdout.write(JSON.stringify({
    loopback, refused, fetched, selfTest,
    blockedHosts: state.blocked.map((attempt) => attempt.host),
    selfTests: state.selfTests.length,
    allowedLoopback: state.allowedLoopback,
  }));
})();
`;

describe("VC-445 network tripwire", () => {
  it("refuses and records a non-loopback socket or fetch, allows loopback, and files self-tests apart", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--require", join(here, "network-tripwire.cjs"), "-e", probe],
      { timeout: 20_000 },
    );
    const result = JSON.parse(stdout);
    expect(result.loopback).toBe("connected");
    expect(result.refused).toBe("ECONNREFUSED");
    expect(result.fetched).toBe("rejected");
    expect(result.selfTest).toBe("ECONNREFUSED");
    // The socket and undici's fetch are both caught before DNS; the armed
    // self-test is recorded as a self-test, not as a violation.
    expect(result.blockedHosts).toEqual(["192.0.2.1", "192.0.2.1"]);
    expect(result.selfTests).toBe(1);
    expect(result.allowedLoopback).toBeGreaterThanOrEqual(1);
  });
});
