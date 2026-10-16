// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { autoSelectRequest, type DecisionRequest } from "@volli/shared";
import BillingAutoSelect from "./billing-auto-select";
import { BILLING_LOG_KEY } from "../billing-run-log";

let container: HTMLElement;
let root: Root;
const fetchMock = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<BillingAutoSelect />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
const textarea = (label: string) =>
  [...container.querySelectorAll("textarea")].find((node) =>
    node.closest("label")?.textContent?.startsWith(label),
  )!;
async function type(node: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function respond(confidence = 0.8) {
  fetchMock.mockImplementation(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body)).request as DecisionRequest;
    const keys = Object.keys(
      (request.questions["model"] as { criteria: Record<string, string> }).criteria,
    );
    return {
      ok: true,
      json: async () => ({
        result: {
          model: { where: "cloud", providerId: "typesafe", modelId: "jev-latest" },
          elapsedMs: 123,
          answers: {
            model: {
              type: "choice",
              choice: "option_2",
              confidence,
              probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 1 ? 0.85 : 0.05])),
            },
          },
        },
        usage: [
          {
            cause: "decision",
            providerId: "typesafe",
            modelId: "jev-latest",
            inputTokens: 100,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.00001,
            costBasis: "catalog-estimate",
          },
        ],
        elapsedMs: 140,
      }),
    };
  });
}

describe("billing auto-select scratch", () => {
  it("does not spend on mount, candidate edits or prompt edits", async () => {
    expect(fetchMock).not.toHaveBeenCalled();
    await type(textarea("Request"), "hi");
    await type(
      textarea("Billing instructions"),
      "Prefer sufficient capability, then marginal cost.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(BILLING_LOG_KEY)).toBeNull();
  });
  it("makes exactly two guarded calls on a press, freezing the exact baseline and label", async () => {
    respond();
    await act(async () => button("Run comparison · 2 live calls").click());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("/__lab/auto-select");
      expect(options.method).toBe("POST");
      expect(options.headers["X-Volli-Lab"]).toBe("1");
    }
    const log = JSON.parse(localStorage.getItem(BILLING_LOG_KEY)!);
    const run = log.runs[0];
    expect(run.requests.baseline).toEqual(
      autoSelectRequest({ request: run.requestText, tierHint: null }, run.candidates),
    );
    expect(run.requests.billing.state.request).toBe(run.requests.baseline.state.request);
    expect(run.requests.baseline.state.billing).toBeUndefined();
    expect(run.requests.billing.state.billing).toBeDefined();
    expect(container.textContent).toContain("Confidence 80.0% · threshold 50.0% · cleared");
    expect(container.textContent).toContain("~$0.00001000 · catalog estimate");
    const label = container.querySelector<HTMLSelectElement>('[aria-label^="Right answer for"]')!;
    await act(async () => {
      label.value = "option_3";
      label.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(JSON.parse(localStorage.getItem(BILLING_LOG_KEY)!).runs[0].correctOption).toBe(
      "option_3",
    );
    await type(textarea("Candidate list"), "[]");
    expect(container.textContent).toContain("Right: option_3");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("shows low confidence fallback and every candidate probability", async () => {
    respond(0.3);
    await act(async () => button("Run comparison · 2 live calls").click());
    expect(container.textContent).toContain("Fall back to default (option_1)");
    expect(container.textContent).toContain("Confidence 30.0% · threshold 50.0% · not cleared");
    expect(container.querySelectorAll('[aria-label="Baseline"] li')).toHaveLength(4);
  });
  it("reports missing sign-in per arm, without claiming zero cost", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: { code: "needs-setup", message: "Sign in to typesafe." },
        usage: [],
        elapsedMs: 50,
      }),
    });
    await act(async () => button("Run comparison · 2 live calls").click());
    expect(container.textContent).toContain("Sign in to typesafe.");
    expect(container.textContent).toContain("classifier cost: Unknown");
    expect(container.textContent).toContain("Fall back to default");
  });
  it("reports malformed endpoint responses rather than crashing or claiming a free call", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ result: null, usage: [null], elapsedMs: 1 }),
    });
    await act(async () => button("Run comparison · 2 live calls").click());
    expect(container.textContent).toContain("Invalid lab endpoint response.");
    expect(container.textContent).toContain("classifier cost: Unknown");
  });
  it("survives a browser that refuses the localStorage getter", async () => {
    await act(async () => root.unmount());
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("Storage denied");
    });
    root = createRoot(container);
    await act(async () => root.render(<BillingAutoSelect />));
    expect(container.textContent).toContain("Could not read the saved run log.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("blocks malformed scenarios and oversized editable wording without spending", async () => {
    const validCandidates = textarea("Candidate list").value;
    await type(textarea("Candidate list"), "[null, null]");
    expect(button("Run comparison · 2 live calls").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Candidate 1");
    await type(textarea("Candidate list"), validCandidates);
    await type(textarea("Billing instructions"), "x".repeat(2001));
    expect(button("Run comparison · 2 live calls").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("instructions");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves an existing label changed while another comparison is in flight", async () => {
    respond();
    await act(async () => button("Run comparison · 2 live calls").click());
    const success = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (...args) => {
      await pending;
      return success(...args);
    });
    await act(async () => button("Run comparison · 2 live calls").click());
    const label = container.querySelector<HTMLSelectElement>('[aria-label^="Right answer for"]')!;
    await act(async () => {
      label.value = "option_4";
      label.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => release());
    const saved = JSON.parse(localStorage.getItem(BILLING_LOG_KEY)!).runs;
    expect(saved).toHaveLength(2);
    expect(saved[1].correctOption).toBe("option_4");
    expect(container.textContent).toContain("Right: option_4");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("recomputes pace and the run timestamp at button press after an idle reset", async () => {
    respond();
    const current = JSON.parse(textarea("Candidate list").value);
    const afterReset = Date.parse(current[0].weekly.resetsAt) + 1000;
    vi.spyOn(Date, "now").mockReturnValue(afterReset);
    await act(async () => button("Run comparison · 2 live calls").click());
    const run = JSON.parse(localStorage.getItem(BILLING_LOG_KEY)!).runs[0];
    expect(run.createdAt).toBe(new Date(afterReset).toISOString());
    expect(run.requests.billing.state.now).toBe(run.createdAt);
    expect(run.requests.billing.state.billing.option_1.weekly.pace).toBeNull();
    expect(run.requests.billing.questions.model.criteria.option_1).toContain(
      "expired; headroom unknown",
    );
  });
  it("keeps history across remount and never calls the provider to restore it", async () => {
    respond();
    await act(async () => button("Run comparison · 2 live calls").click());
    fetchMock.mockClear();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<BillingAutoSelect />));
    expect(container.textContent).toContain("Run log · 1/100");
    expect(container.textContent).toContain("Confidence 80.0%");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
