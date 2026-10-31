import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

import { testContext } from "../testing/context";
import { revokeRunner } from "./uninstall";

it("the unprivileged purge helper empties only owned contents and leaves empty directories for root's rmdir", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-purge-child-"));
  try {
    const dataDir = join(root, "data");
    const configDir = join(root, "config");
    const outside = join(root, "outside");
    mkdirSync(join(dataDir, "work"), { recursive: true });
    mkdirSync(configDir);
    writeFileSync(join(dataDir, "work/commit"), "work");
    writeFileSync(join(configDir, "session-secrets.key"), "key");
    writeFileSync(outside, "not deleted");
    symlinkSync(outside, join(dataDir, "work/link"));
    const context = testContext({ root });
    const values = { "data-dir": dataDir, "config-dir": configDir, purge: true, yes: true };
    expect(await revokeRunner({ values, positionals: [] }, context)).toBe(0);
    expect(readdirSync(dataDir)).toEqual([]);
    expect(readdirSync(configDir)).toEqual([]);
    expect(readFileSync(outside, "utf8")).toBe("not deleted");
    expect(existsSync(dataDir)).toBe(true);
    await expect(revokeRunner({ values, positionals: [] }, { ...context, uid: 0 })).rejects.toThrow(
      "never root",
    );
    await expect(
      revokeRunner({ values: { ...values, yes: false }, positionals: [] }, context),
    ).rejects.toThrow("confirmed --yes");
    rmSync(dataDir, { recursive: true });
    rmSync(configDir, { recursive: true });
    expect(await revokeRunner({ values, positionals: [] }, context)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
