import { describe, expect, it } from "vite-plus/test";

import { isSecretName } from "./secret-name";

describe("isSecretName", () => {
  it.each(["TOKEN", "API_KEY_2", "NPM_TOKEN", `A${"X".repeat(127)}`])("accepts %s", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    "",
    "lowercase",
    "2TOKEN",
    "TOKEN-X",
    "TOKEN\n",
    `A${"X".repeat(128)}`,
    "PATH",
    "HOME",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "VOLLI_TOKEN",
    "ELECTRON_RUN_AS_NODE",
    "BASH_FUNC_X",
    "NPM_CONFIG_PREFIX",
    "GIT_CONFIG_COUNT",
    "GIT_SSH_COMMAND",
  ])("refuses %s", (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  it.each([undefined, null, 1, {}])("refuses a non-string %s", (name) => {
    expect(isSecretName(name)).toBe(false);
  });
});
