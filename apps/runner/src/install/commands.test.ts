import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";

import { testContext } from "../testing/context";
import { installCommand, liveInstallPorts, runManagedCommand, uninstallCommand } from "./commands";
import type { InstallPorts } from "./manage";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-managed-command-"));
  roots.push(root);
  const source = join(root, "release");
  mkdirSync(join(source, "bin"), { recursive: true });
  for (const file of ["node", "volli-runner"]) writeFileSync(join(source, "bin", file), "fixture");
  writeFileSync(
    join(source, "MANIFEST.json"),
    JSON.stringify({
      name: "volli-runner",
      version: "9.9.9-test",
      revision: "abc123",
      target: "linux-arm64",
    }),
  );
  const context = testContext({ root });
  const ports: InstallPorts = {
    platform: "linux",
    systemd: false,
    systemInstallPresent: false,
    ownRelease: source,
    run: () => ({ status: 0, stdout: "" }),
    confirmPurge: () => false,
  };
  return { root, context, ports };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("routes install, uninstall, errors and the credential-owner subprocess without expanding CommandContext", async () => {
  const { root, context, ports } = fixture();
  expect(
    await runManagedCommand(
      "install",
      { values: { "no-start": true, "no-link": true }, positionals: [] },
      context,
      ports,
    ),
  ).toBe(0);
  expect(
    await runManagedCommand("uninstall", { values: {}, positionals: [] }, context, ports),
  ).toBe(0);
  expect(
    await runManagedCommand(
      "install",
      { values: { user: true, system: true }, positionals: [] },
      context,
      ports,
    ),
  ).toBe(1);
  expect(context.stderr()).toContain("not both");
  expect(
    await runManagedCommand(
      "uninstall",
      {
        values: {
          "revoke-only": true,
          "config-dir": join(root, "empty-config"),
          "data-dir": join(root, "empty-data"),
        },
        positionals: [],
      },
      context,
    ),
  ).toBe(0);
});

it("wires both registry entries to live ports and refuses unsafe modes before touching a box", async () => {
  const { context } = fixture();
  for (const command of [installCommand, uninstallCommand]) {
    expect(
      await command.run({ values: { user: true, system: true }, positionals: [] }, context),
    ).toBe(1);
  }
  expect(liveInstallPorts()).toMatchObject({
    platform: process.platform,
    ownRelease: expect.any(String),
    systemd: expect.any(Boolean),
  });
});
