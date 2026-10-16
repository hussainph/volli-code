import { describe, expect, it } from "vite-plus/test";
import type { SessionRuntimeSpec } from "@volli/shared";
import { retainOmitted, sameToolSpec } from "./refresh-tools";

const spec: SessionRuntimeSpec = {
  identity: {
    role: "project",
    sessionId: "session",
    rootThreadId: "thread",
    attachmentId: "attachment",
    projectId: "project",
    ticketId: null,
  },
  workspacePath: "/workspace",
  venue: "local",
  model: { providerId: "anthropic", modelId: "fixture", reasoningLevel: "off" },
  brief: { text: "fixture" },
  tools: { tools: ["read"] },
  observer: async () => {},
};

describe("runtime tool adoption", () => {
  it("compares effective and declared bytes, ordered wired membership, not port identities", () => {
    expect(sameToolSpec(spec, { ...spec, declarationTools: spec.tools })).toBe(true);
    expect(
      sameToolSpec(spec, { ...spec, tools: { tools: ["read"], refreshDescriptions: true } }),
    ).toBe(false);
    expect(sameToolSpec(spec, { ...spec, declarationTools: { tools: [] } })).toBe(false);
    const web = {
      ...spec,
      webFetch: async () => {
        throw new Error("not called");
      },
    };
    expect(sameToolSpec(spec, web)).toBe(false);
    expect(
      sameToolSpec(web, {
        ...web,
        webFetch: async () => {
          throw new Error("not called");
        },
      }),
    ).toBe(true);
    expect(
      sameToolSpec(
        { ...spec, tools: { tools: ["read", "write"] } },
        { ...spec, tools: { tools: ["write", "read"] } },
      ),
    ).toBe(false);
  });

  it("uses canonical rebuilt order and retains unexpected omissions", () => {
    const old = [
      { name: "read", value: "old" },
      { name: "codemode", value: "old" },
      { name: "retained", value: "old" },
    ];
    const fresh = [
      { name: "read", value: "new" },
      { name: "todo", value: "new" },
      { name: "codemode", value: "new" },
    ];
    expect(retainOmitted(old, fresh, (entry) => entry.name)).toEqual([...fresh, old[2]]);
  });
});
