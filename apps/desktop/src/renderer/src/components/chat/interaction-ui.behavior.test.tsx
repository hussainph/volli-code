// @vitest-environment jsdom
/**
 * What the question card *does* when it is pressed.
 *
 * The renderer suite runs under `node` and asserts markup, which is right for
 * everything a card SAYS and cannot reach the one thing VC-289 is about: which
 * of several controls actually calls the resolver, and how many times. A latch
 * that is taken synchronously is invisible to static markup by construction —
 * both presses render the same card — so this file gets a DOM, by docblock
 * rather than by a new test project, and drives the real component.
 *
 * No testing-library: React's own `act` plus `createRoot` is the whole harness,
 * and the queries below are `querySelector` against what the card renders. What
 * is being tested is the wiring, so the fewer layers between a click and
 * `onResolve` the better.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type {
  RendererSessionInteraction,
  SessionInteractionPrompt,
  SessionInteractionResolution,
} from "@volli/shared";

import { InteractionCard } from "./interaction-ui";

// React's own flag for "this environment can flush effects synchronously".
// Without it every `act` call warns, and the warning is the only thing that
// would tell us the assertions below were racing the renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function askPrompt(overrides: Partial<SessionInteractionPrompt> = {}): SessionInteractionPrompt {
  return {
    id: "prompt:0",
    label: "How much detail do you want?",
    detail: null,
    options: [
      { id: "question:0:YnJpZWY", label: "Brief", description: null },
      { id: "question:0:ZGV0YWlsZWQ", label: "Detailed", description: null },
    ],
    multiple: false,
    custom: false,
    ...overrides,
  };
}

const PERMISSION_OPTIONS = [
  { id: "once", label: "Allow once", description: null },
  { id: "always", label: "Allow always", description: null },
  { id: "reject", label: "Reject", description: null },
];

/** A permission: drawn on the verdict card, where a row's click is the press. */
function permission(): RendererSessionInteraction {
  return {
    id: "permission:p1",
    attachmentId: "attach-1",
    kind: "permission",
    title: "rm -rf node_modules",
    detail: "bash",
    options: PERMISSION_OPTIONS,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: "rm -rf node_modules",
        detail: "bash",
        options: PERMISSION_OPTIONS,
        multiple: false,
        custom: false,
      },
    ],
    native: { id: null, detail: null },
  };
}

/** A harness question: encoded ids, so none of them can read as a declared no. */
function ask(prompts: readonly SessionInteractionPrompt[]): RendererSessionInteraction {
  return {
    id: "ask-user:call-1",
    attachmentId: "attach-1",
    kind: "question",
    title: "How much detail do you want?",
    detail: null,
    options: prompts.flatMap((prompt) => prompt.options),
    multiple: prompts.some((prompt) => prompt.multiple),
    prompts,
    native: { id: null, detail: null },
  };
}

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(() => {
  if (mounted === null) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

/** The card, mounted for real, and the handle every helper below reads. */
function mount(element: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(element));
  return host;
}

function control(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no control labelled ${label}`);
  return found;
}

function row(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [
    ...host.querySelectorAll<HTMLButtonElement>("[role='radio'],[role='checkbox']"),
  ].find((option) => option.textContent?.includes(label));
  if (found === undefined) throw new Error(`no option row labelled ${label}`);
  return found;
}

/** A verdict card's row: a native radio, whose click is the whole decision. */
function verdict(host: HTMLElement, label: string): HTMLInputElement {
  const found = [...host.querySelectorAll<HTMLInputElement>("input[type='radio']")].find((input) =>
    input.closest("label")?.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no verdict row labelled ${label}`);
  return found;
}

function press(node: HTMLElement): void {
  act(() => node.click());
}

/**
 * Several activations inside one commit, which is the race worth testing.
 *
 * Pressing twice through {@link press} is not it: the first press re-renders,
 * the control it hit leaves the tree, and the second lands on a detached node
 * that React never hears — a test that would pass with no latch at all. Inside
 * one `act` the card has not re-rendered yet, every node is still mounted and
 * still wired, and both handlers run against the same state. That is exactly
 * the state `resolving` cannot help with, and what the latch is for.
 */
function burst(...activations: readonly (() => void)[]): void {
  act(() => {
    for (const activate of activations) activate();
  });
}

/** ⌘⏎, as a native event React's root will hear. */
function commit(node: HTMLElement): void {
  node.dispatchEvent(
    new globalThis.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
  );
}

/** ⌘⏎ on the element that has it, on its own. */
function commitKey(node: HTMLElement): void {
  act(() => commit(node));
}

/**
 * Lets a step change finish leaving.
 *
 * `AnimatePresence` keeps the outgoing question mounted for the length of its
 * exit, so mid-walk the card really does hold two steps at once — in a browser
 * for 220ms, and here until the animation frames have run. Waiting is what
 * makes "the question in view" a single node again; without it a query for a
 * row finds the one the reader has just left.
 */
async function settle(): Promise<void> {
  await act(async () => {
    const stepExit = Promise.withResolvers<void>();
    setTimeout(() => stepExit.resolve(), 400);
    await stepExit.promise;
  });
}

/**
 * Lets every promise a press queued land inside `act`.
 *
 * A delivery that has already settled still reports two promises downstream
 * (the latch's `then`, then `useDelivery`'s), so a synchronous press over one
 * sets state after `act` has left and React says so. A macrotask is past every
 * microtask that chain can queue.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Controlled-input typing: the native setter, then the event React listens for. */
function type(node: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(node, text);
    node.dispatchEvent(new globalThis.Event("input", { bubbles: true }));
  });
}

/**
 * A resolver that has not answered yet, and the hand that answers it.
 *
 * The delivery has to be able to stay in flight across several presses, which
 * is the whole shape of the race: a harness that replies instantly can never
 * show a second press finding the first one still travelling.
 */
function slowResolver(): {
  calls: SessionInteractionResolution[];
  resolve(submission: { resolution: SessionInteractionResolution }): Promise<boolean>;
  land(outcome: boolean): Promise<void>;
} {
  const calls: SessionInteractionResolution[] = [];
  const delivery = Promise.withResolvers<boolean>();
  return {
    calls,
    resolve: (submission) => {
      calls.push(submission.resolution);
      return delivery.promise;
    },
    land: async (outcome) => {
      await act(async () => {
        delivery.resolve(outcome);
        // The card hears the landing two promises downstream of this one —
        // the latch's `then`, and then `useDelivery`'s over it — so waiting on
        // the delivery alone left `act` before the state it set, and the
        // assertions after it were racing the renderer (React said so). A
        // macrotask is past every microtask the chain can queue.
        await delivery.promise;
      });
      await flush();
    },
  };
}

describe("choosing an answer, and sending it", () => {
  it("selects on the click and sends only when the reader says so", () => {
    // The fault: a single choice used to resolve on the click that chose it, so
    // the gesture a reader makes while still reading the list was the one that
    // put the answer on the wire.
    const sent: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={(submission) => {
          sent.push(submission.resolution);
        }}
      />,
    );

    press(row(host, "Detailed"));

    expect(row(host, "Detailed").getAttribute("aria-checked")).toBe("true");
    expect(sent).toEqual([]);

    press(control(host, "Send answer"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.optionIds).toEqual(["question:0:ZGV0YWlsZWQ"]);
  });

  it("sends the words a free-text question was answered with", () => {
    const sent: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt({ options: [], custom: true })])}
        onResolve={(submission) => {
          sent.push(submission.resolution);
        }}
      />,
    );
    const box = host.querySelector("textarea");
    expect(box).not.toBeNull();

    type(box!, "cut a patch instead");
    commitKey(box!);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.response).toBe("cut a patch instead");
  });

  it("accumulates a multi-select and sends it in one press", () => {
    const sent: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt({ multiple: true })])}
        onResolve={(submission) => {
          sent.push(submission.resolution);
        }}
      />,
    );

    press(row(host, "Brief"));
    press(row(host, "Detailed"));
    press(control(host, "Send answer"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.optionIds).toEqual(["question:0:YnJpZWY", "question:0:ZGV0YWlsZWQ"]);
  });

  it("refuses a press that has nothing to send, and says what it wants", () => {
    const sent: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={(submission) => {
          sent.push(submission.resolution);
        }}
      />,
    );

    press(control(host, "Send answer"));

    expect(sent).toEqual([]);
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Choose an option");
  });

  it("keeps each question's draft while the reader walks between them", async () => {
    const sent: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt(), askPrompt({ id: "prompt:1", label: "Which branch?" })])}
        onResolve={(submission) => {
          sent.push(submission.resolution);
        }}
      />,
    );

    press(row(host, "Detailed"));
    // Mid-walk the control steps rather than sending, and says so.
    press(control(host, "Next"));
    await settle();
    press(row(host, "Brief"));

    // Back, and the first answer is still standing where it was left.
    press(host.querySelector<HTMLButtonElement>("[aria-label='Previous question']")!);
    await settle();
    expect(row(host, "Detailed").getAttribute("aria-checked")).toBe("true");

    // Forward again: the walk sends once every question has something, and the
    // second question's own draft survived the trip too.
    press(control(host, "Next"));
    await settle();
    expect(row(host, "Brief").getAttribute("aria-checked")).toBe("true");
    press(control(host, "Send answer"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.answers).toEqual([
      { promptId: "prompt:0", optionIds: ["question:0:ZGV0YWlsZWQ"], response: null },
      { promptId: "prompt:1", optionIds: ["question:0:YnJpZWY"], response: null },
    ]);
  });
});

describe("the one submission latch, from the chair", () => {
  it("resolves once however fast the control and the key are pressed", async () => {
    // A slow harness and a reader who double-clicks: `resolving` is set inside
    // the act it guards and read a render later, so both presses used to find
    // it false and both reached the resolver.
    const harness = slowResolver();
    const host = mount(
      <InteractionCard interaction={ask([askPrompt()])} onResolve={harness.resolve} />,
    );

    press(row(host, "Detailed"));
    const send = control(host, "Send answer");
    burst(
      () => send.click(),
      () => send.click(),
      () => commit(send),
    );

    expect(harness.calls).toHaveLength(1);
    await harness.land(true);
    expect(harness.calls).toHaveLength(1);
  });

  it("blocks a competing decline and withdrawal until the first act settles", async () => {
    const harness = slowResolver();
    const withdrawn: string[] = [];
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={harness.resolve}
        onWithdraw={() => {
          withdrawn.push("withdrawn");
        }}
      />,
    );

    press(row(host, "Brief"));
    const send = control(host, "Send answer");
    const decline = control(host, "Decline to answer");
    const withdraw = control(host, "Withdraw question");
    burst(
      () => send.click(),
      () => decline.click(),
      () => withdraw.click(),
    );

    // One resolver call, and it is the answer: the two acts that would have
    // ended the same question another way found the latch held.
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.optionIds).toEqual(["question:0:YnJpZWY"]);
    expect(withdrawn).toEqual([]);

    await harness.land(true);

    // Landed, so it stays that way: the harness's own reply clears the card,
    // and the controls are gone from it in the meantime.
    expect(harness.calls).toHaveLength(1);
    expect(withdrawn).toEqual([]);
    expect(() => control(host, "Decline to answer")).toThrow();
    expect(() => control(host, "Withdraw question")).toThrow();
  });

  it("gives the card and its draft back when the delivery does not land", async () => {
    const harness = slowResolver();
    const host = mount(
      <InteractionCard interaction={ask([askPrompt()])} onResolve={harness.resolve} />,
    );

    press(row(host, "Detailed"));
    press(control(host, "Send answer"));
    await harness.land(false);

    // The same draft, on the same question, with the failure said out loud.
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Not delivered");
    expect(row(host, "Detailed").getAttribute("aria-checked")).toBe("true");

    // And the retry is an ordinary press of the same control.
    press(control(host, "Send answer"));
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]?.optionIds).toEqual(["question:0:ZGV0YWlsZWQ"]);
    // The same delivery, still refused: the card is given back again, with the
    // draft it was retried from.
    await flush();
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Not delivered");
    expect(row(host, "Detailed").getAttribute("aria-checked")).toBe("true");
  });
});

describe("the receipt the card leaves in its own place", () => {
  it("reads the answer back once it has gone", () => {
    const host = mount(
      <InteractionCard interaction={ask([askPrompt()])} onResolve={() => undefined} />,
    );

    press(row(host, "Detailed"));
    press(control(host, "Send answer"));

    const receipt = host.querySelector("[role='status']");
    expect(receipt?.textContent).toBe("Sent: Detailed");
    // The question it answered stays beside it, and nothing is left to press.
    expect(host.textContent).toContain("How much detail do you want?");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("says a decline and a withdrawal in their own words", () => {
    const declined = mount(
      <InteractionCard interaction={ask([askPrompt()])} onResolve={() => undefined} />,
    );
    press(control(declined, "Decline to answer"));
    expect(declined.querySelector("[role='status']")?.textContent).toBe("Declined to answer");

    act(() => {
      mounted?.root.unmount();
    });
    mounted = null;

    const withdrawals: string[] = [];
    const withdrawn = mount(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={() => undefined}
        onWithdraw={() => {
          withdrawals.push("withdrawn");
        }}
      />,
    );
    press(control(withdrawn, "Withdraw question"));

    expect(withdrawals).toEqual(["withdrawn"]);
    expect(withdrawn.querySelector("[role='status']")?.textContent).toBe("Withdrew question");
  });

  it("withdraws once, whether by control or by Escape", () => {
    // Inside one commit, or the test proves nothing: pressed and then keyed,
    // the first press has already re-rendered the card as a receipt with no
    // key handler on it, and Escape would find nothing to reach whether or not
    // a latch stood in the way. In one `act` the form is still the form, the
    // key still lands on it, and only the latch says no.
    const withdrawals: string[] = [];
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={() => undefined}
        onWithdraw={() => {
          withdrawals.push("withdrawn");
        }}
      />,
    );
    const form = host.querySelector("form")!;
    const withdraw = control(host, "Withdraw question");

    burst(
      () => withdraw.click(),
      () =>
        form.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );

    expect(withdrawals).toEqual(["withdrawn"]);
  });
});

describe("the verdict card, on the same latch", () => {
  it("ends a permission once when a verdict and a withdrawal race", async () => {
    // The same footer, the same latch: a permission's row sends on the click
    // that chooses it, and a withdrawal pressed in the same commit — by the
    // control or by Escape — finds that click already holding the request.
    const harness = slowResolver();
    const withdrawn: string[] = [];
    const host = mount(
      <InteractionCard
        interaction={permission()}
        onResolve={harness.resolve}
        onWithdraw={() => {
          withdrawn.push("withdrawn");
        }}
      />,
    );
    const form = host.querySelector("form")!;
    const allow = verdict(host, "Allow once");
    const withdraw = control(host, "Withdraw request");

    burst(
      () => allow.click(),
      () => withdraw.click(),
      () =>
        form.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.optionIds).toEqual(["once"]);
    expect(withdrawn).toEqual([]);
    await harness.land(true);
    expect(withdrawn).toEqual([]);
  });

  it("lets a refused withdrawal be pressed again", async () => {
    // A cancel the client refused resolves `false` rather than throwing, and
    // that `false` is what gives the latch back: the request is still standing,
    // so the control must be too.
    const outcomes = [false, true];
    const attempts: number[] = [];
    const host = mount(
      <InteractionCard
        interaction={permission()}
        onResolve={() => undefined}
        onWithdraw={() => {
          attempts.push(attempts.length);
          return Promise.resolve(outcomes[attempts.length - 1]);
        }}
      />,
    );

    press(control(host, "Withdraw request"));
    await flush();
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Not delivered");

    press(control(host, "Withdraw request"));
    await flush();
    expect(attempts).toEqual([0, 1]);
    expect(host.querySelector("[role='alert']")).toBeNull();
  });
});
