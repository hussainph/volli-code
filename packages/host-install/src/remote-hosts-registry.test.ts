import { describe, expect, it } from "vite-plus/test";

import {
  deviceKeyName,
  EMPTY_REGISTRY,
  flowKeyName,
  readRegistry,
  readRegistryHost,
  type RegistryHost,
} from "./remote-hosts-registry";

const HOST: RegistryHost = {
  id: "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  name: "box",
  target: "deploy@box:2222",
  os: "linux",
  mode: "system",
  version: "1.1.0",
  deviceId: "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  addedAt: "2026-01-01T00:00:00.000Z",
  listen: { host: "127.0.0.1", port: 7420 },
  workspaceIds: ["2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f"],
};

describe("a registry host", () => {
  it("reads one written whole, and copies it", () => {
    const read = readRegistryHost({ ...HOST, extra: "ignored" });
    expect(read).toEqual(HOST);
    expect(readRegistryHost({ ...HOST, os: null, version: null, mode: "user", os2: 1 })).toEqual({
      ...HOST,
      os: null,
      version: null,
      mode: "user",
    });
    expect(readRegistryHost({ ...HOST, os: "macos" })?.os).toBe("macos");
  });

  it("keeps each Workspace once", () => {
    const workspace = HOST.workspaceIds[0]!;
    expect(
      readRegistryHost({ ...HOST, workspaceIds: [workspace, workspace] })?.workspaceIds,
    ).toEqual([workspace]);
  });

  it.each([
    ["not an object", null],
    ["an array", [HOST]],
    ["a host id that is not a UUID", { ...HOST, id: "this-mac" }],
    ["an empty name", { ...HOST, name: "" }],
    ["a target that is not text", { ...HOST, target: 7 }],
    ["a target ssh would take as an option", { ...HOST, target: "-oProxyCommand=x" }],
    ["an unknown os", { ...HOST, os: "windows" }],
    ["an unknown mode", { ...HOST, mode: "root" }],
    ["an empty version", { ...HOST, version: "" }],
    ["a device id that is not a UUID", { ...HOST, deviceId: "mac" }],
    ["no addedAt", { ...HOST, addedAt: undefined }],
    ["no listen", { ...HOST, listen: null }],
    ["a listen host that is not text", { ...HOST, listen: { host: 1, port: 7420 } }],
    ["a fractional port", { ...HOST, listen: { host: "127.0.0.1", port: 1.5 } }],
    ["port zero", { ...HOST, listen: { host: "127.0.0.1", port: 0 } }],
    ["a port past 65535", { ...HOST, listen: { host: "127.0.0.1", port: 70_000 } }],
    ["workspaces that are not a list", { ...HOST, workspaceIds: "ws" }],
    ["a workspace that is not a UUID", { ...HOST, workspaceIds: ["ws"] }],
  ])("refuses %s", (_, value) => {
    expect(readRegistryHost(value)).toBeNull();
  });
});

describe("a registry file", () => {
  it("is empty, with one problem, when it is not a v1 registry", () => {
    for (const value of [null, "text", { v: 2, hosts: [] }, { v: 1, hosts: {} }]) {
      expect(readRegistry(value)).toEqual({
        file: EMPTY_REGISTRY,
        problems: ["not a v1 registry"],
      });
    }
  });

  it("keeps every valid host once and names what it dropped", () => {
    expect(readRegistry({ v: 1, hosts: [HOST, { ...HOST, name: "" }, HOST] })).toEqual({
      file: { v: 1, hosts: [HOST] },
      problems: ["host 1 is malformed", `host 2 repeats ${HOST.id}`],
    });
  });

  it("names a key-store entry by host or by flow", () => {
    expect(deviceKeyName(HOST.id)).toBe(`host:${HOST.id}`);
    expect(flowKeyName("f1")).toBe("flow:f1");
  });
});
