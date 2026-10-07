/** Schema and handler-boundary contracts, not project-registration service tests. */
import {
  HOST_WORKSPACE_BOUNDS as BOUNDS,
  HOST_WORKSPACE_FAILURE_CODES,
  type HostWorkspace,
  type HostWorkspaceCreateResult,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { LOCAL_DESKTOP_CALLER, type RouterCaller } from "./catalog";
import { RpcDiagnosticLog } from "./index";
import { createWorkspacesRouter, workspacesProcedureSchemas } from "./workspaces-router";

const COMMAND = "0f8fad5b-d9cb-469f-a165-70867728950e";
const DEVICE = "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d";
const workspace: HostWorkspace = {
  id: COMMAND,
  name: "Project",
  path: "/work/project",
  gitRemoteUrl: null,
};
const input = { commandId: COMMAND, source: { path: workspace.path } };
const schemas = workspacesProcedureSchemas();
const createInput = schemas["workspaces.create"]!.input;
const createOutput = schemas["workspaces.create"]!.output;
const listOutput = schemas["workspaces.list"]!.output;

function fixture(caller: RouterCaller = LOCAL_DESKTOP_CALLER) {
  const list = vi.fn(() => ({ workspaces: [workspace], omitted: 0 }));
  const create = vi.fn<() => HostWorkspaceCreateResult>(() => ({ ok: true, workspace }));
  return {
    list,
    create,
    caller: createWorkspacesRouter().createCaller({
      caller,
      handlers: { "workspaces.list": list, "workspaces.create": create },
      diagnostics: new RpcDiagnosticLog(),
      transport: "websocket",
    }),
  };
}

describe("host Workspace router projection", () => {
  it("publishes just the list query and create mutation from their real validators", () => {
    expect(Object.keys(schemas)).toEqual(["workspaces.list", "workspaces.create"]);
    expect(schemas["workspaces.list"]).toMatchObject({
      type: "query",
      noInput: true,
      outputValidation: "network-and-tests",
    });
    expect(schemas["workspaces.create"]).toMatchObject({
      type: "mutation",
      noInput: false,
      outputValidation: "network-and-tests",
    });
  });

  it("projects list and both create sources, attributing them to the authenticated person", async () => {
    const f = fixture({
      actor: { kind: "device", deviceId: DEVICE, scope: "host" },
      current: () => true,
    });
    expect(await f.caller.workspaces.list()).toEqual({ workspaces: [workspace], omitted: 0 });
    expect(f.list).toHaveBeenCalledWith(undefined, { actor: { kind: "user" } });
    expect(await f.caller.workspaces.create({ ...input, name: "  Project  " })).toEqual({
      ok: true,
      workspace,
    });
    expect(f.create).toHaveBeenLastCalledWith(
      { ...input, name: "Project" },
      { actor: { kind: "user" } },
    );
    await f.caller.workspaces.create({
      commandId: COMMAND,
      source: { gitUrl: "https://example.test/repo.git" },
    });
    expect(f.create).toHaveBeenLastCalledWith(
      { commandId: COMMAND, source: { gitUrl: "https://example.test/repo.git" } },
      { actor: { kind: "user" } },
    );
  });

  it("refuses a Session and a lapsed grant before malformed input or handlers", async () => {
    for (const caller of [
      {
        actor: { kind: "session", sessionId: "session", workspaceId: COMMAND },
        current: () => true,
      },
      { actor: { kind: "device", deviceId: DEVICE, scope: "host" }, current: () => false },
    ] satisfies RouterCaller[]) {
      const f = fixture(caller);
      await expect(f.caller.workspaces.list()).rejects.toMatchObject({
        code: caller.actor.kind === "session" ? "FORBIDDEN" : "UNAUTHORIZED",
      });
      await expect(f.caller.workspaces.create({} as typeof input)).rejects.toMatchObject({
        code: caller.actor.kind === "session" ? "FORBIDDEN" : "UNAUTHORIZED",
      });
      expect(f.list).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    }
  });

  it("enforces create input and output on the actual network router", async () => {
    const f = fixture();
    await expect(
      f.caller.workspaces.create({ ...input, source: { path: "" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.create).not.toHaveBeenCalled();
    f.create.mockReturnValueOnce({ ok: false, failure: { code: "capacity", message: "Full" } });
    expect(await f.caller.workspaces.create(input)).toEqual({
      ok: false,
      failure: { code: "capacity", message: "Full" },
    });
    f.create.mockReturnValueOnce({ ok: true, workspace: { ...workspace, id: "not-uuid" } });
    await expect(f.caller.workspaces.create(input)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    f.list.mockReturnValueOnce({ workspaces: [workspace], omitted: -1 });
    await expect(f.caller.workspaces.list()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});

describe("closed, bounded Workspace schemas", () => {
  it("requires one strict source, never both, neither, or source options", () => {
    for (const source of [
      undefined,
      null,
      {},
      { path: "x", gitUrl: "y" },
      { path: "x", force: true },
      { gitUrl: "y", token: "secret" },
    ]) {
      expect(createInput.safeParse({ ...input, source }).success).toBe(false);
    }
    for (const source of [{ path: "x" }, { gitUrl: "y" }]) {
      expect(createInput.safeParse({ ...input, source }).success).toBe(true);
    }
  });

  it("requires a v4 command UUID, with no implicit identity", () => {
    for (const commandId of [
      undefined,
      null,
      "",
      "command",
      "0f8fad5b-d9cb-169f-a165-70867728950e",
      "00000000-0000-0000-0000-000000000000",
    ]) {
      expect(createInput.safeParse({ ...input, commandId }).success).toBe(false);
    }
    expect(createInput.safeParse(input).success).toBe(true);
  });

  it("bounds both source locators and the trimmed optional name", () => {
    for (const [field, max] of [
      ["path", BOUNDS.path],
      ["gitUrl", BOUNDS.gitUrl],
    ] as const) {
      for (const [size, valid] of [
        [0, false],
        [1, true],
        [max, true],
        [max + 1, false],
      ] as const) {
        expect(
          createInput.safeParse({ ...input, source: { [field]: "x".repeat(size) } }).success,
        ).toBe(valid);
      }
    }
    for (const [name, valid] of [
      ["", false],
      ["   ", false],
      ["x", true],
      ["x".repeat(BOUNDS.name), true],
      ["x".repeat(BOUNDS.name + 1), false],
    ] as const) {
      expect(createInput.safeParse({ ...input, name }).success).toBe(valid);
    }
    expect(createInput.parse({ ...input, name: "  x  " })).toEqual({ ...input, name: "x" });
  });

  it("bounds every Workspace field identically in list and create output", () => {
    for (const [field, max] of [
      ["name", BOUNDS.name],
      ["path", BOUNDS.path],
      ["gitRemoteUrl", BOUNDS.gitUrl],
    ] as const) {
      for (const size of [0, 1, max, max + 1]) {
        const row = { ...workspace, [field]: "x".repeat(size) };
        const valid = size <= max && (size > 0 || field === "gitRemoteUrl");
        expect(listOutput.safeParse({ workspaces: [row], omitted: 0 }).success).toBe(valid);
        expect(createOutput.safeParse({ ok: true, workspace: row }).success).toBe(valid);
      }
    }
    for (const id of ["", "bad", "0f8fad5b-d9cb-169f-a165-70867728950e"]) {
      const row = { ...workspace, id };
      expect(listOutput.safeParse({ workspaces: [row], omitted: 0 }).success).toBe(false);
      expect(createOutput.safeParse({ ok: true, workspace: row }).success).toBe(false);
    }
    expect(createOutput.safeParse({ ok: true, workspace }).success).toBe(true);
    expect(
      createOutput.safeParse({ ok: true, workspace: { ...workspace, gitRemoteUrl: undefined } })
        .success,
    ).toBe(false);
  });

  it("bounds the roster and its explicit omitted count", () => {
    for (const count of [0, BOUNDS.rows, BOUNDS.rows + 1]) {
      expect(
        listOutput.safeParse({
          workspaces: Array.from({ length: count }, () => workspace),
          omitted: 0,
        }).success,
      ).toBe(count <= BOUNDS.rows);
    }
    for (const omitted of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "0", null]) {
      expect(listOutput.safeParse({ workspaces: [], omitted }).success).toBe(false);
    }
    for (const omitted of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(listOutput.safeParse({ workspaces: [], omitted }).success).toBe(true);
    }
    expect(listOutput.safeParse({ workspaces: [] }).success).toBe(false);
  });

  it("closes the outcome discriminator and every failure code, bounding the message", () => {
    expect(HOST_WORKSPACE_FAILURE_CODES).toEqual([
      "invalid-source",
      "path-unreadable",
      "target-exists",
      "clone-failed",
      "clone-timeout",
      "registration-failed",
      "still-running",
      "interrupted",
      "capacity",
    ]);
    for (const code of HOST_WORKSPACE_FAILURE_CODES) {
      for (const size of [0, BOUNDS.message, BOUNDS.message + 1]) {
        expect(
          createOutput.safeParse({ ok: false, failure: { code, message: "x".repeat(size) } })
            .success,
        ).toBe(size <= BOUNDS.message);
      }
    }
    for (const code of ["future", "", undefined, null, 0]) {
      expect(createOutput.safeParse({ ok: false, failure: { code, message: "x" } }).success).toBe(
        false,
      );
    }
    for (const output of [
      { ok: "true", workspace },
      { ok: 1, workspace },
      { ok: null },
      {},
      { ok: true },
      { ok: false },
      { ok: false, failure: { code: "capacity" } },
    ]) {
      expect(createOutput.safeParse(output).success).toBe(false);
    }
  });
});
