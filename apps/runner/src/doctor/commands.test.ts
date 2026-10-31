import { describe, expect, it } from "vite-plus/test";

import type { CommandInput } from "../commands";
import { testContext } from "../testing/context";
import { doctorCommand, doctorCommandWith } from "./commands";
import type { DoctorPorts } from "./ports";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const GIB = 1024 ** 3;
const DEPLOYMENT = { url: "https://a.convex.cloud", siteUrl: "https://a.convex.site" };

function ports(overrides: Partial<DoctorPorts> = {}): DoctorPorts {
  return {
    run: (command) =>
      command === "git"
        ? { status: 0, stdout: "git version 2.43.0\n" }
        : { status: 0, stdout: "yes\n" },
    reach: async () => ({ reachable: true, status: 404, date: NOW }),
    freeBytes: () => 8 * GIB,
    exists: () => true,
    storedCredentials: async () => ({
      state: "listed",
      providers: [{ providerId: "anthropic", kind: "subscription" }],
    }),
    readLink: async () => ({
      state: "linked",
      name: "hetzner-1",
      runnerId: "11111111-1111-4111-8111-111111111111",
      deployment: DEPLOYMENT,
    }),
    ...overrides,
  };
}

function context() {
  return testContext({ root: "/box", env: { USER: "volli" }, now: () => NOW });
}

const input = (values: Record<string, string | boolean> = {}): CommandInput => ({
  values,
  positionals: [],
});

describe("volli-runner doctor", () => {
  it("is the registry row the command table lists", () => {
    expect(doctorCommand.name).toBe("doctor");
    expect(doctorCommand.usage).toContain("--json");
    expect(doctorCommand.stub).toBeUndefined();
  });

  it("prints the report and exits 0 when nothing failed", async () => {
    const command = doctorCommandWith(ports());
    const output = context();
    expect(await command.run(input(), output)).toBe(0);
    expect(output.stdout()).toContain("volli-runner doctor — hetzner-1");
    expect(output.stdout()).toContain("No failed checks");
    expect(output.stderr()).toBe("");
  });

  it("exits 1 when a check failed, and says what to do", async () => {
    const command = doctorCommandWith(
      ports({
        run: (program) =>
          program === "git"
            ? { status: 0, stdout: "git version 2.30.0" }
            : { status: 0, stdout: "yes\n" },
      }),
    );
    const output = context();
    expect(await command.run(input(), output)).toBe(1);
    expect(output.stdout()).toContain("checks failed");
    expect(output.stdout()).toContain("git 2.30.0 is older than 2.31");
    expect(output.stdout()).toContain("fix: Install git 2.31 or newer from");
  });

  it("prints the same report as JSON on --json, and never a credential", async () => {
    const command = doctorCommandWith(
      ports({
        storedCredentials: async () => ({
          state: "listed",
          providers: [{ providerId: "anthropic", kind: "subscription" }],
        }),
      }),
    );
    const output = context();
    expect(await command.run(input({ json: true }), output)).toBe(0);
    const report = JSON.parse(output.stdout()) as {
      v: number;
      checks: { id: string; status: string }[];
      counts: Record<string, number>;
      host: { hostname: string };
    };
    expect(report.v).toBe(1);
    expect(report.host.hostname).toBe("hetzner-1");
    expect(report.checks.every((check) => check.status !== "fail")).toBe(true);
    expect(report.counts.fail).toBe(0);
    expect(output.stdout()).not.toContain("secret");
    expect(output.stdout().endsWith("}\n")).toBe(true);
  });

  it("takes --data-dir and --config-dir, and writes nothing to stderr", async () => {
    const seen: string[] = [];
    const command = doctorCommandWith(
      ports({
        readLink: async (configDir) => {
          seen.push(configDir);
          return { state: "unlinked" };
        },
      }),
    );
    const output = context();
    const code = await command.run(
      input({ "data-dir": "/tmp/box/data", "config-dir": "/tmp/box/config" }),
      output,
    );
    expect(code).toBe(0);
    expect(seen).toEqual(["/tmp/box/config"]);
    expect(output.stdout()).toContain("this box is not linked to a Volli account");
  });
});
