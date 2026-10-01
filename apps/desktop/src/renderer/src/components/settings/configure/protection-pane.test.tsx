// @vitest-environment jsdom
/**
 * Configure → Protection, the project's policy page (VC-480).
 *
 * Mounted for real rather than rendered to static markup, because what is
 * worth pinning here is what a click WRITES: the switch is a reading of the
 * stored policy, and the two directions write different departures — on
 * states `enforcement`, off clears hidden policy departures. The
 * list is the same: a revoke is a call, a removed row and a toast whose Undo is
 * another call. The bridge is a stub per test.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AuthorityApproval, Project } from "@volli/shared";

import { configureGroups } from "../configure-groups";
import { ProtectionPane } from "./protection-pane";

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const HOUR = 60 * 60 * 1000;

function project(authorityPolicy: Project["authorityPolicy"] = null): Project {
  return {
    id: "p1",
    name: "Volli Code",
    path: "/repo/volli",
    ticketPrefix: "VC",
    baseBranch: "trunk",
    setupCommand: null,
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    authorityPolicy,
  };
}

function approval(id: string, over: Partial<AuthorityApproval> = {}): AuthorityApproval {
  return {
    id,
    projectId: "p1",
    scope: "project",
    sessionId: null,
    operation: "write",
    key: `/Users/me/code/${id}`,
    summary: `Write to /Users/me/code/${id}`,
    rule: "path.outside-workspace",
    createdAt: Date.now() - 2 * HOUR,
    provenance: {
      sessionId: "s1",
      sessionTitle: "Fix the docs",
      ticketDisplayId: "VC-12",
      asked: `write /Users/me/code/${id}/README.md`,
      reason: "Writes outside the workspace need approval.",
      interactionId: "i1",
    },
    useCount: 3,
    lastUsedAt: Date.now() - 3 * HOUR,
    lastUsedBySessionId: null,
    ...over,
  };
}

type ApprovalsAnswer = { ok: true; approvals: AuthorityApproval[] } | { ok: false; error: string };

interface Bridge {
  setAuthorityPolicy: ReturnType<typeof vi.fn>;
  approvals: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
}

function stubBridge(listed: AuthorityApproval[] | ApprovalsAnswer = []): Bridge {
  const answer: ApprovalsAnswer = Array.isArray(listed) ? { ok: true, approvals: listed } : listed;
  const byId = (id: string) =>
    (Array.isArray(listed) ? listed : []).find((row) => row.id === id) ?? approval(id);
  const bridge: Bridge = {
    setAuthorityPolicy: vi.fn(
      async (input: { id: string; override: Project["authorityPolicy"] }) => ({
        ok: true,
        project: project(input.override),
      }),
    ),
    approvals: vi.fn(async () => answer),
    revoke: vi.fn(async (id: string) => ({ ok: true, approval: byId(id) })),
    restore: vi.fn(async (id: string) => ({ ok: true, approval: byId(id) })),
  };
  vi.stubGlobal("api", {
    projects: { setAuthorityPolicy: bridge.setAuthorityPolicy },
    protection: { approvals: bridge.approvals, revoke: bridge.revoke, restore: bridge.restore },
  });
  return bridge;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderPane(policy: Project["authorityPolicy"] = null): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<ProtectionPane project={project(policy)} />));
  return container;
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element, "nothing to click").toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}

function protectionSwitch(): HTMLElement | null {
  return document.querySelector('[role="switch"][aria-label="Protection"]');
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="protection-approval"]')];
}

function lastWrittenOverride(bridge: Bridge): unknown {
  const call = bridge.setAuthorityPolicy.mock.calls.at(-1)?.[0] as
    | { id: string; override: unknown }
    | undefined;
  expect(call?.id).toBe("p1");
  return call?.override;
}

describe("the switch", () => {
  it.each([null, {}, { enforcement: "off" as const }, { enforcement: "observe" as const }])(
    "reads off for a fresh or non-enforcing project: %j",
    async (policy) => {
      const bridge = stubBridge();
      const html = (await renderPane(policy)).innerHTML;

      expect(protectionSwitch()?.getAttribute("aria-checked")).toBe("false");
      expect(html).toContain("Protection is off");
      expect(html).toContain(
        "Agents run as you. They can read, change and run anything you can, without asking.",
      );
      if (policy?.enforcement === undefined) expect(html).not.toContain("Reset Protection");
      expect(bridge.setAuthorityPolicy).not.toHaveBeenCalled();
    },
  );

  it("reads on, in the on words, exactly when the policy enforces", async () => {
    stubBridge();
    const html = (await renderPane({ enforcement: "enforce" })).innerHTML;

    expect(protectionSwitch()?.getAttribute("aria-checked")).toBe("true");
    expect(html).toContain("Protection is on");
    expect(html).toContain(
      "File and command checks ask before allowing a refused action. This is not a sandbox: scripts can bypass these checks.",
    );
    expect(html).toContain("Reset Protection to the app-wide value, Off");
  });

  it("turns on by stating enforce, merged into what the project already says", async () => {
    const bridge = stubBridge();
    await renderPane({
      actors: { session: { peek: "project" } },
    });

    await click(protectionSwitch());

    expect(lastWrittenOverride(bridge)).toEqual({
      actors: { session: { peek: "project" } },
      enforcement: "enforce",
    });
  });

  it("turns off by clearing hidden restrictions, retaining only visible transcript policy", async () => {
    const bridge = stubBridge();
    await renderPane({
      enforcement: "enforce",
      judgmentMode: "auto",
      budgets: { delegationExceeded: "refuse" },
      actors: { session: { peek: "project", coordinationVerbs: [] } },
    });

    await click(protectionSwitch());

    expect(lastWrittenOverride(bridge)).toEqual({ actors: { session: { peek: "project" } } });
  });

  it("stores an emptied document as null", async () => {
    const bridge = stubBridge();
    await renderPane({ enforcement: "enforce" });

    await click(protectionSwitch());

    expect(lastWrittenOverride(bridge)).toBeNull();
  });

  it("offers the reset for an explicit observe override under a page that says off", async () => {
    const bridge = stubBridge();
    const html = (await renderPane({ enforcement: "observe" })).innerHTML;

    expect(html).toContain("Protection is off");
    await click(buttonLabelled("Reset Protection to the app-wide value, Off"));

    expect(lastWrittenOverride(bridge)).toBeNull();
  });

  it("says once, after a flip, that running Sessions keep their setting", async () => {
    stubBridge();
    const pane = await renderPane(null);
    const cue = "Sessions already running keep their setting until they next start.";

    expect(pane.textContent).not.toContain(cue);
    await click(protectionSwitch());
    expect(pane.textContent).toContain(cue);
  });

  it("surfaces a refused write and does not claim the flip", async () => {
    const bridge = stubBridge();
    bridge.setAuthorityPolicy.mockResolvedValue({ ok: false, error: "db closed" });
    const pane = await renderPane(null);

    await click(protectionSwitch());

    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't save this project's protection: db closed",
      expect.anything(),
    );
    expect(pane.textContent).not.toContain("Sessions already running");
  });
});

describe("Approved actions", () => {
  it("lists each row with its sentence, origin, reach and use", async () => {
    stubBridge([
      approval("docs"),
      approval("npmrc", {
        scope: "session",
        sessionId: "s1",
        summary: "Read /Users/me/.npmrc",
        provenance: { ...approval("npmrc").provenance, ticketDisplayId: null, sessionTitle: null },
        useCount: 1,
        lastUsedBySessionId: "child-1",
      }),
    ]);
    await renderPane();

    const [docs, npmrc] = rows();
    expect(docs?.textContent).toContain("Write to /Users/me/code/docs");
    expect(docs?.textContent).toContain("VC-12 · Fix the docs · approved 2h ago");
    expect(docs?.textContent).toContain("This project");
    expect(docs?.textContent).toContain("3× · 3h ago");
    expect(docs?.textContent).not.toContain("inherited by a subagent");

    expect(npmrc?.textContent).toContain("Read /Users/me/.npmrc");
    expect(npmrc?.textContent).toContain("No ticket · Session · approved 2h ago");
    expect(npmrc?.textContent).toContain("This Session");
    expect(npmrc?.textContent).toContain("inherited by a subagent");
  });

  it("sums what the ledger has passed without asking", async () => {
    stubBridge([approval("a", { useCount: 4 }), approval("b", { useCount: 1 })]);
    await renderPane();

    expect(
      document.querySelector('[data-testid="protection-approvals-summary"]')?.textContent,
    ).toBe("2 approved · passed 5 requests without asking");
  });

  it("reads the list for this project", async () => {
    const bridge = stubBridge();
    await renderPane();

    expect(bridge.approvals).toHaveBeenCalledWith("p1");
  });

  it("says what fills an empty list, and draws no summary or filter", async () => {
    stubBridge([]);
    const pane = await renderPane();

    const empty = document.querySelector('[data-testid="protection-approvals-empty"]');
    expect(empty?.textContent).toContain("Nothing approved yet");
    expect(empty?.textContent).toContain(
      'When you choose "Allow for this Session" or "Always allow" on a request, it\'s kept here.',
    );
    expect(document.querySelector('[data-testid="protection-approvals-summary"]')).toBeNull();
    expect(document.querySelector('[data-testid="protection-approvals-filter"]')).toBeNull();
    expect(pane.textContent).not.toContain("approved ·");
  });

  it("surfaces a failed read with a way to try again", async () => {
    const bridge = stubBridge({ ok: false, error: "db closed" });
    const pane = await renderPane();

    expect(pane.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't read approved actions: db closed",
    );
    bridge.approvals.mockResolvedValue({ ok: true, approvals: [approval("docs")] });
    await click(buttonLabelled("Try again"));
    expect(rows()).toHaveLength(1);
  });

  it("counts each filter and narrows the list to it", async () => {
    stubBridge([
      approval("a"),
      approval("b"),
      approval("c", { scope: "session", sessionId: "s1" }),
    ]);
    await renderPane();

    const filter = document.querySelector('[data-testid="protection-approvals-filter"]');
    const labels = [...(filter?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(["All 3", "This project 2", "Sessions 1"]);

    await click(buttonLabelled("Sessions 1"));
    expect(rows().map((row) => row.dataset.approvalId)).toEqual(["c"]);

    await click(buttonLabelled("This project 2"));
    expect(rows().map((row) => row.dataset.approvalId)).toEqual(["a", "b"]);
  });

  it("opens a row's provenance on click", async () => {
    stubBridge([approval("docs")]);
    const pane = await renderPane();
    const target = rows()[0]?.querySelector("button[aria-expanded]");

    expect(target?.getAttribute("aria-expanded")).toBe("false");
    expect(pane.textContent).not.toContain("Stopped by");

    await click(target);

    expect(target?.getAttribute("aria-expanded")).toBe("true");
    expect(pane.textContent).toContain("Asked");
    expect(pane.textContent).toContain("write /Users/me/code/docs/README.md");
    expect(pane.textContent).toContain("Stopped by");
    expect(pane.textContent).toContain("Writes outside the workspace need approval.");
    expect(pane.textContent).toMatch(/By you, .+ at .+, on the card in Fix the docs \(VC-12\)/);

    await click(target);
    expect(pane.textContent).not.toContain("Stopped by");
  });

  it("revokes with no confirm, drops the row and offers Undo", async () => {
    // Newest first, as main lists them; Undo must put the row back in its place.
    const bridge = stubBridge([
      approval("docs"),
      approval("npmrc", { createdAt: Date.now() - 5 * HOUR }),
    ]);
    await renderPane();

    await click(buttonLabelled("Revoke Write to /Users/me/code/docs"));

    expect(bridge.revoke).toHaveBeenCalledWith("docs");
    expect(rows().map((row) => row.dataset.approvalId)).toEqual(["npmrc"]);
    expect(toastMock).toHaveBeenCalledWith(
      'Revoked "Write to /Users/me/code/docs". Agents will ask again next time.',
      { action: { label: "Undo", onClick: expect.any(Function) } },
    );

    const undo = toastMock.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } };
    await act(async () => undo.action.onClick());

    expect(bridge.restore).toHaveBeenCalledWith("docs");
    expect(rows().map((row) => row.dataset.approvalId)).toEqual(["docs", "npmrc"]);
  });

  it("keeps the row and surfaces a refused revoke", async () => {
    const bridge = stubBridge([approval("docs")]);
    bridge.revoke.mockResolvedValue({ ok: false, error: "gone" });
    await renderPane();

    await click(buttonLabelled("Revoke Write to /Users/me/code/docs"));

    expect(rows()).toHaveLength(1);
    expect(toastMock).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't revoke that approval: gone",
      expect.anything(),
    );
  });

  it("keeps Revoke focusable while it is visually hidden", async () => {
    stubBridge([approval("docs")]);
    await renderPane();

    const revoke = buttonLabelled("Revoke Write to /Users/me/code/docs");
    expect(revoke?.className).toContain("opacity-0");
    expect(revoke?.className).toContain("focus-visible:opacity-100");
    expect(revoke?.tabIndex).toBe(0);
  });
});

describe("Advanced", () => {
  const label = "Transcripts a Session can read";

  it("is collapsed until asked", async () => {
    stubBridge();
    const pane = await renderPane();

    expect(pane.textContent).toContain("Advanced");
    expect(pane.textContent).not.toContain(label);

    await click(buttonLabelled("Advanced"));
    expect(pane.textContent).toContain(label);
    expect(pane.querySelector('[data-testid="protection-peek-session"]')).not.toBeNull();
  });

  it("resets a stated transcript posture by pruning it out of the actors", async () => {
    const bridge = stubBridge();
    await renderPane({ enforcement: "enforce", actors: { session: { peek: "project" } } });
    await click(buttonLabelled("Advanced"));

    await click(buttonLabelled(`Reset ${label} to the app-wide value, Its own only`));

    expect(lastWrittenOverride(bridge)).toEqual({ enforcement: "enforce" });
  });
});

/**
 * The rail's search index against what this page draws — the same rule
 * `settings-search-smoke.mjs` states in minutes. Section titles and row
 * labels, read off the kit's markers, with Advanced open so its row counts.
 */
describe("the Configure rail", () => {
  function entry(policy: Project["authorityPolicy"] = null) {
    for (const group of configureGroups(project(policy))) {
      for (const category of group.categories) {
        if (category.key === "authority") return category;
      }
    }
    throw new Error("no Configure category `authority`");
  }

  it.each([null, { enforcement: "enforce" as const }])(
    "always draws Protection, mapping the persisted policy without rewriting it: %j",
    async (policy) => {
      const bridge = stubBridge();
      const category = entry(policy);
      expect(category.label).toBe("Protection");
      expect(category.keywords).toContain("approved actions");
      expect(category.keywords).not.toContain("decision mode — not active yet");

      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root?.render(category.content));

      expect(protectionSwitch()?.getAttribute("aria-checked")).toBe(
        policy?.enforcement === "enforce" ? "true" : "false",
      );
      expect(container.textContent).toContain("Approved actions");
      expect(container.textContent).toContain("Advanced");
      expect(container.textContent).not.toContain("Transcripts a Session can read");
      expect(container.textContent).not.toContain("Rule enforcement");
      expect(container.textContent).not.toContain("experimental");
      expect(bridge.setAuthorityPolicy).not.toHaveBeenCalled();
    },
  );

  it("finds this page from every title and label it draws", async () => {
    stubBridge([approval("docs")]);
    for (const policy of [null, { enforcement: "enforce" as const }]) {
      await renderPane(policy);
      await click(buttonLabelled("Advanced"));
      const drawn = [
        ...document.querySelectorAll(
          '[data-slot="pref-section-title"], [data-slot="pref-row-label"]',
        ),
      ].map((node) => (node.textContent ?? "").trim());
      const terms = [entry().label, ...(entry().keywords ?? [])].map((term) => term.toLowerCase());

      expect(drawn.length).toBeGreaterThan(3);
      for (const label of drawn) {
        expect(
          terms.some((term) => term.includes(label.toLowerCase())),
          `"${label}" is drawn in Configure → Protection and nothing in the rail finds it`,
        ).toBe(true);
      }
      await act(async () => root?.unmount());
      container?.remove();
      root = null;
      container = null;
    }
  });
});
