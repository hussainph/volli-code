import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { COMMANDS, EXIT_UNAVAILABLE } from "./commands";
import { doctorCommand } from "./doctor/commands";
import { installCommand, uninstallCommand } from "./install/commands";
import { testContext } from "./testing/context";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-commands-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const command = (name: string) => COMMANDS.find((entry) => entry.name === name)!;

describe("the command registry", () => {
  it("names each command once", () => {
    const names = COMMANDS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("answers a command this build does not have yet with EX_UNAVAILABLE", async () => {
    const stubs = COMMANDS.filter((entry) => entry.stub === true).map((entry) => entry.name);
    expect(stubs).toEqual(["logs"]);
    for (const name of stubs) {
      const context = testContext({ root });
      expect(await command(name).run({ values: {}, positionals: [] }, context)).toBe(
        EXIT_UNAVAILABLE,
      );
      expect(context.stderr()).toBe(
        `volli-runner: \`${name}\` is not available in this build yet.\n`,
      );
    }
  });

  it("routes install, uninstall and doctor to their production entries", () => {
    expect(command("install")).toBe(installCommand);
    expect(command("uninstall")).toBe(uninstallCommand);
    expect(command("doctor")).toBe(doctorCommand);
  });

  it("prints the version", async () => {
    const context = testContext({ root });
    expect(await command("version").run({ values: {}, positionals: [] }, context)).toBe(0);
    expect(context.stdout()).toBe("9.9.9-test\n");
  });
});
