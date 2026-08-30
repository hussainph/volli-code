/**
 * The armed window as it actually behaves over time: the timer, the re-reads,
 * and the one control. `armed-move-model.test.ts` beside this owns the
 * arithmetic; this file owns the claim that the arithmetic is what runs.
 */
import { ARMED_RUN_DELAY_MS } from "@volli/shared";
import type { Automation, ColumnArming, Ticket, TicketStatus } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { cancelArmedRun, noteDeliberateMove, resetArmedRuns, useArmedRunStore } from "./armed-run";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}));

const AUTOMATION: Automation = {
  id: "a1",
  projectId: "p1",
  name: "Review sweep",
  instructions: "/review",
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  createdAt: 0,
  updatedAt: 0,
};

const ARMING: ColumnArming = {
  projectId: "p1",
  status: "doing",
  automationId: "a1",
  armedAt: 0,
};

function ticket(status: TicketStatus): Ticket {
  return {
    id: "t1",
    projectId: "p1",
    ticketNumber: 12,
    title: "Ticket",
    body: "",
    status,
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The Run door, plus the surfaces a started Run touches. */
let run: ReturnType<typeof vi.fn>;
/** The three reads a cold cache fills itself from. */
let list: ReturnType<typeof vi.fn>;
let armings: ReturnType<typeof vi.fn>;
let enablement: ReturnType<typeof vi.fn>;

function seed(
  options: {
    armings?: readonly ColumnArming[];
    status?: TicketStatus;
    /** Which Automations are switched on here; the armed one by default. */
    enabledIds?: readonly string[];
  } = {},
) {
  useAutomationsStore.setState({
    byProject: { p1: [AUTOMATION] },
    armingByProject: { p1: options.armings ?? [ARMING] },
    enabledIds: options.enabledIds ?? [AUTOMATION.id],
    // Warm: these tests are about a board someone is already looking at. The
    // cold-cache path has its own describe below.
    enablementRead: true,
  });
  useBoardStore.getState().hydrate({ p1: [ticket(options.status ?? "doing")] }, { p1: [] });
  useProjectsStore.setState({
    projects: [
      {
        id: "p1",
        name: "Probe",
        path: "/repo",
        ticketPrefix: "VC",
        order: 0,
        createdAt: 0,
        updatedAt: 0,
      } as never,
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  run = vi.fn(() =>
    Promise.resolve({
      ok: true,
      run: { sessionId: "s1" },
      projectId: "p1",
      receipt: { id: "r", commandId: "c", status: "completed", recordedAt: 0 },
    }),
  );
  list = vi.fn(() => Promise.resolve({ ok: true, automations: [AUTOMATION] }));
  armings = vi.fn(() => Promise.resolve({ ok: true, armings: [ARMING] }));
  enablement = vi.fn(() => Promise.resolve({ ok: true, enabledAutomationIds: [AUTOMATION.id] }));
  vi.stubGlobal("window", {
    api: {
      automations: { run, list, armings, enablement },
      sessions: { list: vi.fn(() => Promise.resolve({ ok: true, sessions: [] })) },
      // Adopting the fresh Session opens the RPC link. Stubbed rather than
      // avoided: a Run that could not be adopted is a Run nothing on screen
      // would show, so the adopt belongs in what this file exercises.
      sessionRpc: {
        onEvent: () => () => {},
        request: vi.fn(() => Promise.resolve({ ok: true })),
        subscribe: vi.fn(() => () => {}),
      },
    },
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
  });
  vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
});

afterEach(() => {
  resetArmedRuns();
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    enabledIds: [],
    enablementRead: false,
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("noteDeliberateMove", () => {
  it("opens a window naming the Automation and the ticket, and starts nothing yet", () => {
    seed();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });

    const open = useArmedRunStore.getState().pending["t1"];
    expect(open?.automationName).toBe("Review sweep");
    expect(open?.ticketDisplayId).toBe("VC-12");
    expect(open?.startAt).toBe(open!.openedAt + ARMED_RUN_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("opens nothing for a move into an unarmed column — a pure status change", () => {
    seed({ armings: [] });
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });

    expect(useArmedRunStore.getState().pending).toEqual({});
  });

  it("replaces an earlier window for the same ticket rather than queueing behind it", async () => {
    seed();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });
    const first = useArmedRunStore.getState().pending["t1"];
    vi.advanceTimersByTime(1_000);
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "backlog", to: "doing" });
    const second = useArmedRunStore.getState().pending["t1"];

    expect(second).not.toBe(first);
    // The replaced window's own deadline passes without firing anything: only
    // the live one can, and only when ITS delay is up.
    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS - 1_000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("the delay", () => {
  it("starts the Run once, and only after the whole 3500 ms", async () => {
    seed();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });

    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "automation", automationId: "a1" },
        ticketId: "t1",
        // Never on the drag path (VC-112) — an armed column's Run takes the
        // Runtime its record resolves, and nothing overrides it from a drop.
        modelOverride: null,
      }),
    );
    expect(useArmedRunStore.getState().pending).toEqual({});
  });

  it("keeps the move and starts nothing when Cancel is the answer", async () => {
    seed();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });
    cancelArmedRun("t1");

    expect(useArmedRunStore.getState().pending).toEqual({});
    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS * 2);
    expect(run).not.toHaveBeenCalled();
    // The move itself is untouched — Cancel is about the Run, never the card.
    expect(useBoardStore.getState().ticketsByProject["p1"]?.[0]?.status).toBe("doing");
  });

  it("starts nothing when the ticket is dragged out again inside the window", async () => {
    seed();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });
    useBoardStore.getState().hydrate({ p1: [ticket("todo")] }, { p1: [] });

    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("starts nothing when the column is disarmed inside the window", async () => {
    seed();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });
    useAutomationsStore.setState({ armingByProject: { p1: [] } });

    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("starts nothing when the ticket left this renderer entirely", async () => {
    seed();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });
    useBoardStore.getState().hydrate({ p1: [] }, { p1: [] });

    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("reschedules a timer that woke early instead of starting on its say-so", async () => {
    seed();
    const openedAt = Date.now();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });

    // The wall clock jumps backwards under the timer — a resumed machine, an
    // NTP correction. The timeout still fires on its own tick count, and this
    // is the moment a Run could start against a delay that has not elapsed.
    vi.setSystemTime(openedAt - 3_000);
    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
    // Still open, still counting: the window was not abandoned either.
    expect(useArmedRunStore.getState().pending["t1"]).toBeDefined();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("arming is not retroactive", () => {
  it("leaves the tickets already sitting in the column alone", async () => {
    // The column is armed with a ticket already in it, and nothing moves.
    seed({ status: "doing" });

    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS * 2);
    expect(useArmedRunStore.getState().pending).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });
});

describe("a switched-off Automation", () => {
  it("fires nothing on its Trigger, and leaves the column armed", async () => {
    // VC-112: a new machine sees the Skills and fires nothing until someone
    // turns something on there. Running by hand is unaffected and is not this
    // door — the palette and the rail never come through here.
    seed({ enabledIds: [] });
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });

    expect(useArmedRunStore.getState().pending).toEqual({});
    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS * 2);
    expect(run).not.toHaveBeenCalled();
    // The arming itself is untouched: the switch is about the Automation.
    expect(useAutomationsStore.getState().armingByProject["p1"]).toEqual([ARMING]);
  });

  it("abandons a window when the switch goes off inside it", async () => {
    seed();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });
    useAutomationsStore.setState({ enabledIds: [] });

    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("a cold cache", () => {
  /** Everything seed() sets, minus the Automations caches: nothing read yet. */
  function seedCold() {
    seed();
    useAutomationsStore.setState({
      byProject: {},
      armingByProject: {},
      enabledIds: [],
      enablementRead: false,
    });
  }

  it("waits for the reads instead of calling the arrival unarmed", async () => {
    // The race the board could not win: it renders as interactive and starts
    // its reads in an effect, so a drop a heartbeat later — or a CLI move into
    // a project no window has opened — arrives before any of them resolved.
    seedCold();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });

    // Nothing decided yet: the answer is not knowable, so it is not guessed.
    expect(useArmedRunStore.getState().pending).toEqual({});
    expect(list).toHaveBeenCalledTimes(1);
    expect(armings).toHaveBeenCalledTimes(1);
    expect(enablement).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    // Reconsidered once they landed, and the window opens with its WHOLE
    // delay: the wait can only make the Run later than the arrival, never
    // earlier, and the person still gets 3500 ms to reach Cancel.
    const open = useArmedRunStore.getState().pending["t1"];
    expect(open?.startAt).toBe(open!.openedAt + ARMED_RUN_DELAY_MS);

    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shares one read across a burst of arrivals", async () => {
    seedCold();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });
    noteDeliberateMove({ projectId: "p1", ticketId: "t2", from: "todo", to: "doing" });
    noteDeliberateMove({ projectId: "p1", ticketId: "t3", from: "todo", to: "doing" });

    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(armings).toHaveBeenCalledTimes(1);
    expect(enablement).toHaveBeenCalledTimes(1);
  });

  it("lets a second move for the same ticket win the classification", async () => {
    seedCold();
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });
    // The card is dragged straight out again while the reads are in flight.
    // The first arrival must not open a window for a column it has left.
    noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "doing", to: "todo" });
    useBoardStore.getState().hydrate({ p1: [ticket("todo")] }, { p1: [] });

    await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS * 2);
    expect(useArmedRunStore.getState().pending).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });
});
