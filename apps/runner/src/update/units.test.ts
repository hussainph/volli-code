import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { SYSTEM_INSTALL_ROOT, updateLayout } from "./layout";
import { UPDATE_PATH_UNIT, UPDATE_SERVICE_UNIT, updateUnits } from "./units";

const packaging = (name: string): string =>
  readFileSync(join(import.meta.dirname, "..", "..", "packaging", name), "utf8");

describe("the update units", () => {
  it("ship as their system rendering", () => {
    const units = updateUnits(updateLayout("system", SYSTEM_INSTALL_ROOT, "/var/lib/volli-runner"));
    expect(packaging(UPDATE_PATH_UNIT)).toBe(units.path);
    expect(packaging(UPDATE_SERVICE_UNIT)).toBe(units.service);
    expect(units.service).toContain("ProtectHome=yes");
    expect(units.path).toContain("WantedBy=paths.target");
  });

  it("quote quotes and backslashes", () => {
    const units = updateUnits(updateLayout("user", '/r/a"b\\c', "/d"));
    expect(units.service).toContain('--install-root "/r/a\\"b\\\\c"');
  });

  it("render as user units without root's sandbox, quoting odd paths", () => {
    const units = updateUnits(
      updateLayout("user", "/home/p q/.local/share/volli-runner", "/home/p q/.local/state/v%$r"),
    );
    expect(units.path).toContain("PathChanged=/home/p q/.local/state/v%%$r/update/request.json");
    expect(units.path).toContain("WantedBy=default.target");
    expect(units.service).toContain(
      'ExecStart="/home/p q/.local/share/volli-runner/current/bin/volli-runner" update apply ' +
        '--install-root "/home/p q/.local/share/volli-runner" --data-dir "/home/p q/.local/state/v%%$$r"',
    );
    expect(units.service).not.toContain("ProtectHome");
    expect(units.service).toContain("UMask=0077");
  });
});
