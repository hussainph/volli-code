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

/** Escape on the card, without flushing a render between competing acts. */
function escape(node: HTMLElement, isComposing = false): KeyboardEvent {
  const event = new globalThis.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    isComposing,
  });
  node.dispatchEvent(event);
  return event;
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

    press(control(host, "Answer"));

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
    press(control(host, "Answer"));

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

    press(control(host, "Answer"));

    expect(sent).toEqual([]);
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Choose an option");
  });

  it("preserves historical mixed multi/custom answers in one submission", async () => {
    const prompts: SessionInteractionPrompt[] = [
      {
        id: "scope",
        label: "Which scope should this change cover?",
        detail: null,
        options: [
          { id: "tool", label: "Tool and adapter only", description: null },
          { id: "renderer", label: "Include renderer changes", description: null },
        ],
        multiple: false,
        custom: false,
      },
      {
        id: "checks",
        label: "Which checks should run before handoff?",
        detail: null,
        options: [
          { id: "tests", label: "Focused tests", description: null },
          { id: "types", label: "Typecheck", description: null },
        ],
        multiple: true,
        custom: true,
      },
      {
        id: "name",
        label: "What should the handoff be called?",
        detail: null,
        options: [],
        multiple: false,
        custom: true,
      },
    ];
    const first = prompts[0]!;
    // Match PiBinding.#askUser, not ask()'s legacy aggregate flat fields.
    const interaction: RendererSessionInteraction = {
      id: "ask-user:call-multi",
      attachmentId: "attach-1",
      kind: "question",
      title: first.label,
      detail: null,
      options: first.options,
      multiple: first.multiple,
      prompts,
      native: { id: null, detail: null },
    };
    const harness = slowResolver();
    const host = mount(<InteractionCard interaction={interaction} onResolve={harness.resolve} />);

    press(row(host, "Tool and adapter only"));
    expect(harness.calls).toEqual([]);
    press(control(host, "Next"));
    await settle();
    expect(host.querySelector("form")?.getAttribute("aria-label")).toBe(prompts[1]!.label);

    press(row(host, "Focused tests"));
    press(row(host, "Typecheck"));
    type(host.querySelector<HTMLTextAreaElement>("textarea")!, "Also check older readers");
    expect(harness.calls).toEqual([]);
    press(control(host, "Next"));
    await settle();

    type(host.querySelector<HTMLTextAreaElement>("textarea")!, "Multi-question handoff");
    expect(harness.calls).toEqual([]);
    press(control(host, "Answer"));

    expect(harness.calls).toHaveLength(1);
    expect(host.querySelector("form")?.getAttribute("aria-label")).toBe("3 questions");
    expect(harness.calls[0]).toEqual({
      // The existing renderer keeps the aggregate flat answer for old readers.
      optionIds: ["tool", "tests", "types"],
      response: "Also check older readers\n\nMulti-question handoff",
      answers: [
        { promptId: "scope", optionIds: ["tool"], response: null },
        {
          promptId: "checks",
          optionIds: ["tests", "types"],
          response: "Also check older readers",
        },
        { promptId: "name", optionIds: [], response: "Multi-question handoff" },
      ],
    });
    await harness.land(true);
    expect(harness.calls).toHaveLength(1);
  });

  it("answers three simplified Pi questions with shortcuts and one atomic submit", async () => {
    const prompts = [0, 1, 2].map((index) =>
      askPrompt({
        id: `prompt:${index}`,
        label: `Decision ${index + 1}`,
        custom: true,
        options: [
          { id: "choice:0", label: "First", description: null },
          { id: "choice:1", label: "Second", description: null },
        ],
      }),
    );
    const harness = slowResolver();
    const host = mount(<InteractionCard interaction={ask(prompts)} onResolve={harness.resolve} />);
    const shortcut = (key: string) =>
      act(() =>
        row(host, "First").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
      );
    shortcut("1");
    expect(row(host, "First").getAttribute("aria-checked")).toBe("true");
    expect(harness.calls).toEqual([]);
    press(control(host, "Next"));
    await settle();
    shortcut("2");
    expect(row(host, "Second").getAttribute("aria-checked")).toBe("true");
    press(control(host, "Next"));
    await settle();
    const box = host.querySelector<HTMLTextAreaElement>("textarea")!;
    type(box, "Another approach");
    const submit = control(host, "Answer");
    burst(
      () => submit.click(),
      () => commit(box),
    );
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.answers).toEqual([
      { promptId: "prompt:0", optionIds: ["choice:0"], response: null },
      { promptId: "prompt:1", optionIds: ["choice:1"], response: null },
      { promptId: "prompt:2", optionIds: [], response: "Another approach" },
    ]);
    await harness.land(true);
  });

  it("treats another answer as an alternative, never typing numeral shortcuts into a selection", () => {
    const sent: SessionInteractionResolution[] = [];
    const prompt = askPrompt({
      custom: true,
      options: [
        { id: "choice:0", label: "First", description: null },
        { id: "choice:1", label: "Second", description: null },
      ],
    });
    const host = mount(
      <InteractionCard
        interaction={ask([prompt])}
        onResolve={({ resolution }) => {
          sent.push(resolution);
        }}
      />,
    );
    press(row(host, "First"));
    const box = host.querySelector<HTMLTextAreaElement>("textarea")!;
    type(box, "My answer");
    expect(row(host, "First").getAttribute("aria-checked")).toBe("false");
    act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })));
    expect(row(host, "Second").getAttribute("aria-checked")).toBe("false");
    press(row(host, "Second"));
    expect(box.value).toBe("");
    type(box, "Final answer");
    press(control(host, "Answer"));
    expect(sent[0]?.answers).toEqual([
      { promptId: "prompt:0", optionIds: [], response: "Final answer" },
    ]);
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
    press(control(host, "Previous"));
    await settle();
    expect(row(host, "Detailed").getAttribute("aria-checked")).toBe("true");

    // Forward again: the walk sends once every question has something, and the
    // second question's own draft survived the trip too.
    press(control(host, "Next"));
    await settle();
    expect(row(host, "Brief").getAttribute("aria-checked")).toBe("true");
    press(control(host, "Answer"));

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
    const send = control(host, "Answer");
    burst(
      () => send.click(),
      () => send.click(),
      () => commit(send),
    );

    expect(harness.calls).toHaveLength(1);
    await harness.land(true);
    expect(harness.calls).toHaveLength(1);
  });

  it("blocks a competing decline and Escape until the answer settles", async () => {
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
    const send = control(host, "Answer");
    const decline = control(host, "Decline to answer");
    const form = host.querySelector("form")!;
    expect(() => control(host, "Withdraw question")).toThrow();
    burst(
      () => send.click(),
      () => decline.click(),
      () => escape(form),
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
    press(control(host, "Answer"));
    await harness.land(false);

    // The same draft, on the same question, with the failure said out loud.
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Not delivered");
    expect(row(host, "Detailed").getAttribute("aria-checked")).toBe("true");

    // And the retry is an ordinary press of the same control.
    press(control(host, "Answer"));
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
    press(control(host, "Answer"));

    const receipt = host.querySelector("[role='status']");
    expect(receipt?.textContent).toBe("Sent: Detailed");
    // The question it answered stays beside it, and nothing is left to press.
    expect(host.textContent).toContain("How much detail do you want?");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("says a decline and a stopped turn in their own words", () => {
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
    burst(() => escape(withdrawn.querySelector("form")!));

    expect(withdrawals).toEqual(["withdrawn"]);
    expect(withdrawn.querySelector("[role='status']")?.textContent).toBe("Stopped turn");
  });

  it("stops once when repeated Escape, decline and answer race", () => {
    // Inside one commit the form still has all its handlers; only the latch
    // can stop the competing acts before React renders the receipt.
    const withdrawals: string[] = [];
    const resolutions: SessionInteractionResolution[] = [];
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={({ resolution }) => {
          resolutions.push(resolution);
        }}
        onWithdraw={() => {
          withdrawals.push("withdrawn");
        }}
      />,
    );
    press(row(host, "Detailed"));
    const form = host.querySelector("form")!;
    const decline = control(host, "Decline to answer");
    const answer = control(host, "Answer");
    expect(() => control(host, "Withdraw question")).toThrow();

    burst(
      () => escape(form),
      () => escape(form),
      () => decline.click(),
      () => answer.click(),
    );

    expect(withdrawals).toEqual(["withdrawn"]);
    expect(resolutions).toEqual([]);
    expect(host.querySelector("[role='status']")?.textContent).toBe("Stopped turn");
  });
});

describe("Escape delivery and recovery on a question", () => {
  for (const failure of ["false", "reject", "throw"] as const) {
    it(`releases a failed ${failure} exit for retry, preserving the draft`, async () => {
      const delivery = Promise.withResolvers<boolean>();
      let attempts = 0;
      const resolutions: SessionInteractionResolution[] = [];
      const host = mount(
        <InteractionCard
          interaction={ask([askPrompt()])}
          onResolve={({ resolution }) => {
            resolutions.push(resolution);
          }}
          onWithdraw={() => {
            attempts += 1;
            if (attempts > 1) return Promise.resolve(true);
            if (failure === "throw") throw new Error("delivery failed");
            return delivery.promise;
          }}
        />,
      );
      press(row(host, "Detailed"));
      const form = host.querySelector("form")!;
      const decline = control(host, "Decline to answer");
      const answer = control(host, "Answer");
      burst(
        () => escape(form),
        // Throw releases the latch synchronously; pending promises hold it.
        ...(failure === "throw"
          ? []
          : [() => escape(form), () => decline.click(), () => answer.click()]),
      );
      expect(attempts).toBe(1);
      expect(resolutions).toEqual([]);
      if (failure === "false") delivery.resolve(false);
      if (failure === "reject") delivery.reject(new Error("delivery failed"));
      await flush();

      expect(host.querySelector("[role='alert']")?.textContent).toBe("Not delivered");
      expect(host.querySelector("[role='status']")).toBeNull();
      expect(row(host, "Detailed").getAttribute("aria-checked")).toBe("true");
      expect(() => control(host, "Withdraw question")).toThrow();
      const retry = host.querySelector("form")!;
      burst(
        () => escape(retry),
        () => escape(retry),
      );
      await flush();
      expect(attempts).toBe(2);
      expect(host.querySelector("[role='alert']")).toBeNull();
      expect(host.querySelector("[role='status']")?.textContent).toBe("Stopped turn");
      expect(resolutions).toEqual([]);
    });
  }

  it("lets a decline hold the latch against Escape", async () => {
    const harness = slowResolver();
    let exits = 0;
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={harness.resolve}
        onWithdraw={() => {
          exits += 1;
        }}
      />,
    );
    const form = host.querySelector("form")!;
    const decline = control(host, "Decline to answer");
    burst(
      () => decline.click(),
      () => escape(form),
    );
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.optionIds).toEqual([]);
    expect(exits).toBe(0);
    await harness.land(true);
  });

  it("keeps the same Escape exit when the question is minimized", () => {
    let exits = 0;
    const host = mount(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={() => undefined}
        onWithdraw={() => {
          exits += 1;
        }}
      />,
    );
    press(host.querySelector<HTMLButtonElement>("[aria-label='Minimize question']")!);
    expect(host.querySelector("[aria-label='Expand question']")).not.toBeNull();
    const form = host.querySelector("form")!;
    burst(
      () => expect(escape(form).defaultPrevented).toBe(true),
      () => escape(form),
    );
    expect(exits).toBe(1);
    expect(host.querySelector("[role='status']")?.textContent).toBe("Stopped turn");
  });

  it("leaves Escape unclaimed without an exit handler", () => {
    const host = mount(
      <InteractionCard interaction={ask([askPrompt()])} onResolve={() => undefined} />,
    );
    burst(() => expect(escape(host.querySelector("form")!).defaultPrevented).toBe(false));
    expect(host.querySelector("[role='status']")).toBeNull();
  });

  it("does not stop the turn during IME composition or external resolution", () => {
    let exits = 0;
    const props = {
      interaction: ask([askPrompt()]),
      onResolve: () => undefined,
      onWithdraw: () => {
        exits += 1;
      },
    };
    const host = mount(<InteractionCard {...props} />);
    burst(() => expect(escape(host.querySelector("form")!, true).defaultPrevented).toBe(false));
    act(() => mounted?.root.render(<InteractionCard {...props} resolving />));
    burst(() => expect(escape(host.querySelector("form")!).defaultPrevented).toBe(false));
    expect(exits).toBe(0);
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
