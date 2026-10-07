import { describe, expect, it } from "vite-plus/test";
import { answerFits } from "./remote-hosts";
import { harness, HOST_ID, questionOf, startAdd } from "./testing/remote-hosts-harness";

describe("the self-add question over the desktop wire", () => {
  it("scopes the existing open answer to Add anyway; Cancel uses the existing cancel command", () => {
    const question = { id: "q", kind: "self-add", step: "probe" as const };
    expect(answerFits(question, { kind: "open" })).toBe(true);
    expect(answerFits(question, { kind: "update" })).toBe(false);
    expect(answerFits({ ...question, kind: "existing-hostd" }, { kind: "open" })).toBe(false);
  });

  it("names the question and proceeds on Add anyway, rejecting stale or unrelated answers", async () => {
    const h = harness();
    try {
      const { flowId, view, w } = await startAdd(h, { target: "me@localhost:2222" });
      expect(view.question).toEqual({ id: expect.any(String), kind: "self-add", step: "probe" });
      expect(h.engine.snapshot().hosts).toEqual([]);
      await expect(h.engine.answerAdd(flowId, "stale", { kind: "open" })).rejects.toMatchObject({
        code: "flow-not-waiting",
      });
      await expect(
        h.engine.answerAdd(flowId, questionOf(h.engine, flowId), { kind: "update" }),
      ).rejects.toMatchObject({ code: "flow-not-waiting" });
      await h.engine.answerAdd(flowId, questionOf(h.engine, flowId), { kind: "open" });
      expect(w.views().at(-1)).toMatchObject({ status: "done", hostId: HOST_ID });
      expect(h.engine.snapshot().hosts).toHaveLength(1);
    } finally {
      await h.engine.close();
    }
  });

  it("cancels without delivering or keeping a host and releases its device key and SSH", async () => {
    const h = harness();
    try {
      const { flowId, w } = await startAdd(h, { target: "me@[::1]:2222" });
      await h.engine.cancelAdd(flowId);
      expect(w.views().at(-1)?.status).toBe("cancelled");
      expect(h.engine.snapshot().hosts).toEqual([]);
      expect(h.keys.keys.size).toBe(0);
      expect(h.box.transports.every((transport) => transport.closed)).toBe(true);
      expect(
        w
          .views()
          .at(-1)
          ?.steps.find((step) => step.id === "deliver")?.status,
      ).toBe("pending");
    } finally {
      await h.engine.close();
    }
  });
});
