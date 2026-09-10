// @vitest-environment jsdom
/**
 * What About is allowed to SAY, driven through the real reads (VC-293).
 *
 * The defect this file exists for is invisible in a screenshot of a healthy
 * install: the pane opened on "Everything's working" because its fault lists
 * started empty, and returned to that claim whenever a read failed. So every
 * test here is about a FRAME — what is on screen before the reads land, after
 * one of them fails, and only then what a completed pair is allowed to claim.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DoctorCheck } from "@volli/shared";

import type {
  CliDoctorResult,
  CliStatusResult,
  CliToolStatus,
  HarnessRegisteredResult,
  SupportInfoResult,
} from "../../../../../ipc/contract";
import { useProjectsStore } from "@renderer/stores/projects";

import { AboutPane } from "./about-pane";

function project(id: string, path: string) {
  return {
    id,
    name: id,
    path,
    ticketPrefix: "VC",
    baseBranch: null,
    setupCommand: null,
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

const STATUS: CliToolStatus = {
  link: { path: "/Users/ada/.local/bin/volli", state: "ours", target: "/shim/volli" },
  path: { binDir: "/Users/ada/.local/bin", state: "reachable" },
  environment: {
    loginPath: "/usr/bin:/Users/ada/.local/bin",
    session: {
      path: "/volli/bin:/usr/bin",
      provenance: "adopted",
      interactiveProvenance: "already-complete",
      tools: {
        git: "/usr/bin/git",
        gh: null,
        node: "/opt/homebrew/bin/node",
        npm: null,
        pnpm: "/opt/homebrew/bin/pnpm",
        yarn: null,
        bun: null,
      },
      requiredTools: ["git"],
      dependencies: null,
      installCommand: null,
    },
    systemPathIssues: [],
  },
  socket: { path: "/profiles/volli.sock", live: true },
  wrappers: { commands: ["claude"] },
  shell: { name: "zsh", supported: true, chainActive: true },
  legacy: { path: "/usr/local/bin/volli", state: "absent" },
  installSuppressed: false,
};

const PASSING: DoctorCheck[] = [
  { id: "volli-cli", title: "`volli` is this app's CLI", status: "ok", detail: "/bin/volli" },
];

const FAILING: DoctorCheck[] = [
  {
    id: "shell-init",
    title: "Shell integration is active",
    failureTitle: "Shell integration files are missing",
    status: "fail",
    detail: "/Users/ada/.volli/shell is missing",
    remedy: "Run `volli doctor --fix`.",
  },
];

const SUPPORT: SupportInfoResult = {
  ok: true,
  info: {
    appVersion: "0.2.0-canary.4",
    channel: "canary",
    platform: "darwin",
    arch: "arm64",
    schemaVersion: 34,
  },
};

type AsyncAnswer<T> = T | Promise<T>;

interface Api {
  /** One answer, or one per call in order — the last is repeated. */
  status: AsyncAnswer<CliStatusResult> | AsyncAnswer<CliStatusResult>[];
  /** One answer, or one per call in order — the last is repeated. */
  doctor: AsyncAnswer<CliDoctorResult> | AsyncAnswer<CliDoctorResult>[];
  /** One answer, or one per call in order — the last is repeated. */
  support: AsyncAnswer<SupportInfoResult> | AsyncAnswer<SupportInfoResult>[];
  harnesses: AsyncAnswer<HarnessRegisteredResult>;
}

let container: HTMLElement | null = null;
let root: Root | null = null;
let clipboard: string[] = [];

function nextAnswer<T>(queue: AsyncAnswer<T>[]): AsyncAnswer<T> {
  const answer = queue.length > 1 ? queue.shift() : queue[0];
  if (answer === undefined) throw new Error("no stub answer");
  return answer;
}

function stubApi(overrides: Partial<Api> = {}): void {
  const answers: Api = {
    status: { ok: true, status: STATUS },
    doctor: { ok: true, checks: PASSING, summary: "All 1 checks passed." },
    support: SUPPORT,
    harnesses: { ok: true, harnesses: [], channels: [] },
    ...overrides,
  };
  const statusAnswers = Array.isArray(answers.status) ? [...answers.status] : [answers.status];
  const doctorAnswers = Array.isArray(answers.doctor) ? [...answers.doctor] : [answers.doctor];
  const supportAnswers = Array.isArray(answers.support) ? [...answers.support] : [answers.support];
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      cli: {
        status: () => Promise.resolve(nextAnswer(statusAnswers)),
        doctor: () => Promise.resolve(nextAnswer(doctorAnswers)),
      },
      support: { info: () => Promise.resolve(nextAnswer(supportAnswers)) },
      harness: { registered: () => Promise.resolve(answers.harnesses) },
    },
  });
}

/** Renders the pane and lets every queued read settle. */
async function render(): Promise<HTMLElement> {
  await act(async () => {
    root?.render(<AboutPane />);
  });
  return container as HTMLElement;
}

/**
 * Renders the pane over reads that never answer — the first frame a user sees,
 * held still. Nothing settles, so nothing can quietly fill the panel behind
 * the assertions.
 */
function renderFirstFrame(): HTMLElement {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      cli: { status: pending, doctor: pending },
      support: { info: pending },
      harness: { registered: pending },
    },
  });
  act(() => {
    root?.render(<AboutPane />);
  });
  return container as HTMLElement;
}

function panel(host: HTMLElement): HTMLElement {
  const section = host.querySelector<HTMLElement>("[data-health-state]");
  if (section === null) throw new Error("no health panel");
  return section;
}

function button(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    ) ?? null
  );
}

/** A read that never answers — the state the pane is in for its whole first frame. */
const pending = () => new Promise<never>(() => {});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The dialog's own Copy, by its exact label — the trigger says "Copy report…" too. */
function exactButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboard.push(text);
        return Promise.resolve();
      },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useProjectsStore.setState({ projects: [], selectedProjectId: null });
  stubApi();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

describe("AboutPane — before the checks land", () => {
  it("shows a neutral checking state, with no health claim and no Fix", () => {
    const host = renderFirstFrame();

    expect(panel(host).dataset["healthState"]).toBe("checking");
    expect(host.textContent).toContain("Checking…");
    expect(host.textContent).not.toContain("Everything's working");
    expect(button(host, "Fix")).toBeNull();
    expect(host.querySelector('[data-slot="status-dot"]')?.getAttribute("data-state")).not.toBe(
      "ready",
    );
  });

  it("does not offer a partial report before its facts have loaded", () => {
    // The very first paint, before any effect has run: still no report.
    const html = renderToStaticMarkup(<AboutPane />);

    expect(html).toContain("Preparing report…");
    expect(html).not.toContain("Copy report…");
  });
});

describe("AboutPane — once the checks land", () => {
  it("claims health only after both reads complete with nothing wrong", async () => {
    const host = await render();

    expect(panel(host).dataset["healthState"]).toBe("healthy");
    expect(host.textContent).toContain("Everything's working");
    expect(button(host, "Fix")).toBeNull();
    expect(button(host, "Copy report…")?.disabled).toBe(false);
  });

  it("names each fault by what is wrong and offers the repair", async () => {
    stubApi({ doctor: { ok: true, checks: FAILING, summary: "1 failed of 1 checks." } });

    const host = await render();

    expect(panel(host).dataset["healthState"]).toBe("attention");
    expect(host.textContent).toContain("1 thing needs attention");
    expect(host.textContent).toContain("Shell integration files are missing");
    expect(host.textContent).not.toContain("Shell integration is active");
    expect(button(host, "Fix")?.disabled).toBe(false);
  });

  // The repair puts the doctor read back in flight, so the panel returns to
  // checking — but the button the person pressed has to stay long enough to
  // say what it is doing.
  it("keeps the pressed Fix on screen while it repairs, then reports the result", async () => {
    const repair = deferred<CliDoctorResult>();
    stubApi({
      doctor: [{ ok: true, checks: FAILING, summary: "1 failed of 1 checks." }, repair.promise],
    });
    const host = await render();
    expect(button(host, "Fix")).not.toBeNull();

    act(() => {
      button(host, "Fix")?.click();
    });

    expect(panel(host).dataset["healthState"]).toBe("checking");
    expect(host.textContent).not.toContain("Everything's working");
    expect(button(host, "Fixing…")?.disabled).toBe(true);

    await act(async () => {
      repair.resolve({ ok: true, checks: PASSING, summary: "All 1 checks passed." });
    });

    expect(panel(host).dataset["healthState"]).toBe("healthy");
    expect(host.textContent).toContain("Everything's working");
    expect(button(host, "Fix")).toBeNull();
  });

  it("folds a status warning into the same fault list, headed by its state", async () => {
    stubApi({
      status: {
        ok: true,
        status: { ...STATUS, socket: { path: "/profiles/volli.sock", live: false } },
      },
    });

    const host = await render();

    expect(host.textContent).toContain("App socket: Not running");
  });
});

describe("AboutPane — a check that could not run", () => {
  it("says the checks are incomplete, offers Re-check, and never claims health", async () => {
    stubApi({ doctor: { ok: false, error: "the login shell did not answer" } });

    const host = await render();

    expect(panel(host).dataset["healthState"]).toBe("unavailable");
    expect(host.textContent).toContain("Couldn't complete these checks");
    expect(host.textContent).not.toContain("Everything's working");
    expect(button(host, "Fix")).toBeNull();
    expect(button(host, "Re-check")?.disabled).toBe(false);
  });

  it("refuses the report when the status read failed", async () => {
    stubApi({ status: { ok: false, error: "no socket" } });

    const host = await render();

    expect(button(host, "Report unavailable")?.disabled).toBe(true);
  });

  // The metadata is part of the report gate, exactly like the three data sets
  // it now leads (VC-293).
  it("refuses the report when the support metadata could not be read", async () => {
    stubApi({ support: { ok: false, error: "database is closed" } });

    const host = await render();

    // The install itself is fine — only the report is short of an input.
    expect(panel(host).dataset["healthState"]).toBe("healthy");
    expect(button(host, "Report unavailable")?.disabled).toBe(true);
  });
});

/**
 * The reads are scoped to a project (VC-157), so an answer that lands after
 * the selection moved answers a question nobody is asking any more. Showing it
 * as the current result is the stale-read failure VC-293's acceptance names.
 */
describe("AboutPane — when the project changes", () => {
  it("returns to checking rather than presenting the previous project's result", async () => {
    useProjectsStore.setState({
      projects: [project("p1", "/work/one"), project("p2", "/work/two")],
      selectedProjectId: "p1",
    });
    const host = await render();
    expect(panel(host).dataset["healthState"]).toBe("healthy");

    // The second project's reads never answer: whatever is on screen now is
    // what the pane believes with no current measurement at all.
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        cli: { status: pending, doctor: pending },
        support: { info: pending },
        harness: { registered: pending },
      },
    });
    act(() => {
      useProjectsStore.setState({ selectedProjectId: "p2" });
    });

    expect(panel(host).dataset["healthState"]).toBe("checking");
    expect(host.textContent).not.toContain("Everything's working");
  });

  it("does not let late reads from the previous project replace the current result", async () => {
    const oldStatus = deferred<CliStatusResult>();
    const oldDoctor = deferred<CliDoctorResult>();
    stubApi({
      status: [oldStatus.promise, { ok: true, status: STATUS }],
      doctor: [oldDoctor.promise, { ok: true, checks: PASSING, summary: "All 1 checks passed." }],
    });
    useProjectsStore.setState({
      projects: [project("p1", "/work/one"), project("p2", "/work/two")],
      selectedProjectId: "p1",
    });
    const host = await render();
    expect(panel(host).dataset["healthState"]).toBe("checking");

    await act(async () => {
      useProjectsStore.setState({ selectedProjectId: "p2" });
    });
    expect(panel(host).dataset["healthState"]).toBe("healthy");

    await act(async () => {
      oldStatus.resolve({
        ok: true,
        status: { ...STATUS, socket: { path: "/old/volli.sock", live: false } },
      });
      oldDoctor.resolve({ ok: true, checks: FAILING, summary: "1 failed of 1 checks." });
    });

    expect(panel(host).dataset["healthState"]).toBe("healthy");
    expect(host.textContent).toContain("Everything's working");
    expect(host.textContent).not.toContain("App socket: Not running");
    expect(host.textContent).not.toContain("Shell integration files are missing");
  });
});

describe("AboutPane — the report snapshot", () => {
  it("hands the preview and the clipboard one identical report", async () => {
    const host = await render();

    await act(async () => {
      button(host, "Copy report…")?.click();
    });
    const preview = document.querySelector<HTMLElement>('[aria-label="Report preview"]');
    const shown = preview?.textContent ?? "";

    await act(async () => {
      exactButton("Copy")?.click();
    });

    expect(shown).toContain("Generated at: ");
    expect(shown).toContain("App version: 0.2.0-canary.4");
    expect(shown).toContain("Release channel: canary");
    expect(shown).toContain("OS: darwin arm64");
    expect(shown).toContain("Database schema: 34");
    expect(shown).toContain("CLI status");
    expect(clipboard).toEqual([shown]);
  });

  it("stamps the report with an ISO 8601 UTC instant", async () => {
    const host = await render();

    await act(async () => {
      button(host, "Copy report…")?.click();
    });
    const shown = document.querySelector('[aria-label="Report preview"]')?.textContent ?? "";
    const stamped = /Generated at: (?<instant>\S+)/u.exec(shown)?.groups?.["instant"] ?? "";

    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(new Date(stamped).toISOString()).toBe(stamped);
  });

  it("keeps a superseded support read out of the current report", async () => {
    const first = deferred<SupportInfoResult>();
    const second = deferred<SupportInfoResult>();
    stubApi({ support: [first.promise, second.promise] });
    const host = await render();
    expect(panel(host).dataset["healthState"]).toBe("healthy");
    expect(button(host, "Preparing report…")?.disabled).toBe(true);

    act(() => {
      button(host, "Re-check")?.click();
    });
    await act(async () => {
      second.resolve({
        ok: true,
        info: { ...SUPPORT.info, appVersion: "0.2.0-current" },
      });
    });

    await act(async () => {
      button(host, "Copy report…")?.click();
    });
    const preview = document.querySelector<HTMLElement>('[aria-label="Report preview"]');
    expect(preview?.textContent).toContain("App version: 0.2.0-current");

    await act(async () => {
      first.resolve({ ok: true, info: { ...SUPPORT.info, appVersion: "0.2.0-stale" } });
    });

    expect(preview?.textContent).toContain("App version: 0.2.0-current");
    expect(preview?.textContent).not.toContain("0.2.0-stale");
  });
});
