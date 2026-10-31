import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_UPDATE_CONFIG,
  manifestUrlFor,
  readUpdateConfig,
  updateConfigPath,
} from "./config";
import { defaultInstallRoot, SYSTEM_INSTALL_ROOT, updateLayout, type UpdateLayout } from "./layout";

let root: string;
let layout: UpdateLayout;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-update-config-"));
  layout = updateLayout("user", root, join(root, "data"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the update layout", () => {
  it("puts releases, state and cache in the install root and the request in the data dir", () => {
    expect(updateLayout("system", SYSTEM_INSTALL_ROOT, "/var/lib/volli-runner")).toEqual({
      mode: "system",
      installRoot: "/opt/volli-runner",
      releasesDir: "/opt/volli-runner/releases",
      currentLink: "/opt/volli-runner/current",
      stateFile: "/opt/volli-runner/update-state.json",
      cacheDir: "/opt/volli-runner/.update-cache",
      dataDir: "/var/lib/volli-runner",
      requestFile: "/var/lib/volli-runner/update/request.json",
      nowFile: "/opt/volli-runner/update-now.json",
      reportedFile: "/var/lib/volli-runner/update/reported.json",
    });
  });

  it("defaults the install root by mode and XDG_DATA_HOME", () => {
    expect(defaultInstallRoot("system", "/home/p", {})).toBe("/opt/volli-runner");
    expect(defaultInstallRoot("user", "/home/p", {})).toBe("/home/p/.local/share/volli-runner");
    expect(defaultInstallRoot("user", "/home/p", { XDG_DATA_HOME: "/x" })).toBe("/x/volli-runner");
    expect(defaultInstallRoot("user", "/home/p", { XDG_DATA_HOME: "rel" })).toBe(
      "/home/p/.local/share/volli-runner",
    );
  });
});

describe("the update config", () => {
  it("is the default without a file", () => {
    expect(readUpdateConfig(layout)).toEqual(DEFAULT_UPDATE_CONFIG);
  });

  it("reads an origin and a provenance policy", () => {
    writeFileSync(
      updateConfigPath(layout),
      JSON.stringify({ releaseOrigin: "http://127.0.0.1:9000/releases", provenance: "sha-only" }),
    );
    expect(readUpdateConfig(layout)).toEqual({
      releaseOrigin: "http://127.0.0.1:9000/releases/",
      provenance: "sha-only",
    });
    writeFileSync(updateConfigPath(layout), JSON.stringify({}));
    expect(readUpdateConfig(layout)).toEqual(DEFAULT_UPDATE_CONFIG);
  });

  it("refuses a damaged one", () => {
    for (const value of [
      null,
      { other: 1 },
      { releaseOrigin: 1 },
      { provenance: "none" },
      { releaseOrigin: "http://example.com/" },
    ]) {
      writeFileSync(updateConfigPath(layout), JSON.stringify(value));
      expect(() => readUpdateConfig(layout)).toThrow();
    }
  });

  it("derives a release's manifest URL as GitHub serves it", () => {
    expect(manifestUrlFor(DEFAULT_UPDATE_CONFIG.releaseOrigin, "0.4.0")).toBe(
      "https://github.com/hussainph/volli-code/releases/download/v0.4.0/volli-runner-manifest.json",
    );
  });
});
