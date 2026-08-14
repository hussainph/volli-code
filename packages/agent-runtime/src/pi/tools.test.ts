import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { RuntimeAskUserRequest, SessionInteractionResolution } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { ASK_USER_TOOL_NAME, createAskUserTool, type AskUserPort } from "./tools";

/** What the host was asked, and with which signal, so both can be read back. */
interface RecordedAsk {
  request: RuntimeAskUserRequest;
  signal: AbortSignal;
}

function recordingHost(resolution: SessionInteractionResolution): {
  asks: RecordedAsk[];
  askUser: AskUserPort;
} {
  const asks: RecordedAsk[] = [];
  return {
    asks,
    askUser: async (request, signal) => {
      asks.push({ request, signal });
      return resolution;
    },
  };
}

/** A host that parks, so a signal can fire while the question is still up. */
function holdingHost(): {
  asks: RecordedAsk[];
  askUser: AskUserPort;
  answer: (resolution: SessionInteractionResolution) => void;
} {
  const asks: RecordedAsk[] = [];
  const held = Promise.withResolvers<SessionInteractionResolution>();
  return {
    asks,
    askUser: async (request, signal) => {
      asks.push({ request, signal });
      return held.promise;
    },
    answer: held.resolve,
  };
}

/** The one answer shape most of these tests do not care about. */
const CHOSE_ONE: SessionInteractionResolution = { optionIds: ["one"], response: null };

/** The text a tool result carries back to the model. */
function resultText(result: AgentToolResult<undefined>): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("The tool answered with something other than text");
  return first.text;
}

describe("ask_user tool", () => {
  it("offers the model one question and tells it when asking is warranted", () => {
    const tool = createAskUserTool(async () => CHOSE_ONE);

    expect(tool.name).toBe(ASK_USER_TOOL_NAME);
    expect(tool.name).toBe("ask_user");
    // The description is the whole of the model's instruction for this tool, so
    // the two things that keep it from becoming a chat channel are asserted:
    // ask only about a decision that blocks, and offer a small set of options.
    expect(tool.description).toContain("blocks");
    expect(tool.description).toContain("2-5");
  });

  it("declares one required question beside optional options and multiplicity", () => {
    const tool = createAskUserTool(async () => CHOSE_ONE);

    expect(tool.parameters.required).toEqual(["question"]);
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "question",
      "options",
      "multiple",
      "allowOther",
    ]);
  });

  it("puts the model's own question, options and multiplicity to the host unread", async () => {
    const host = recordingHost({ optionIds: ["spike"], response: null });
    const tool = createAskUserTool(host.askUser);

    const result = await tool.execute(
      "call-3",
      {
        question: "Ship the spike or the full migration?",
        options: [
          { id: "spike", label: "Spike first" },
          { id: "migration", label: "Full migration", description: "Two more days" },
        ],
        multiple: true,
        allowOther: false,
      },
      new AbortController().signal,
    );

    expect(host.asks[0]?.request).toEqual({
      toolCallId: "call-3",
      question: "Ship the spike or the full migration?",
      options: [
        { id: "spike", label: "Spike first" },
        { id: "migration", label: "Full migration", description: "Two more days" },
      ],
      multiple: true,
      // Carried rather than read: whether a person may say something the model
      // did not list is the host's to honour, and its default is not this
      // layer's to invent.
      allowOther: false,
    });
    expect(resultText(result)).toBe("Chose: spike");
  });

  it("asks for prose when the model offered nothing to choose between", async () => {
    const host = recordingHost({ optionIds: [], response: "  Call it Sessions.  " });
    const tool = createAskUserTool(host.askUser);

    const result = await tool.execute("call-4", { question: "What should the page be called?" });

    expect(host.asks[0]?.request).toEqual({
      toolCallId: "call-4",
      question: "What should the page be called?",
      options: undefined,
      multiple: undefined,
      allowOther: undefined,
    });
    expect(resultText(result)).toBe("Call it Sessions.");
  });

  it("carries a choice and the words beside it back together", async () => {
    const tool = createAskUserTool(async () => ({
      optionIds: ["spike", "migration"],
      response: "in that order",
    }));

    expect(resultText(await tool.execute("call-5", { question: "Which one?" }))).toBe(
      "Chose: spike, migration\n\nin that order",
    );
  });

  /**
   * A person can dismiss a card having chosen nothing and typed nothing, and the
   * model still has to be told something it can act on. Reporting the absence is
   * the only honest reading — inventing a default would answer on their behalf.
   */
  it("says so when a person answered with neither a choice nor any words", async () => {
    const tool = createAskUserTool(async () => ({ optionIds: [], response: "   " }));

    expect(resultText(await tool.execute("call-6", { question: "Which one?" }))).toBe(
      "The question was answered with no choice and no reply.",
    );
  });

  it("withdraws the question when the turn it belongs to is cancelled", async () => {
    const held = holdingHost();
    const tool = createAskUserTool(held.askUser);
    const turn = new AbortController();

    const answered = tool.execute("call-7", { question: "Which one?" }, turn.signal);
    turn.abort();
    held.answer(CHOSE_ONE);
    await answered;

    expect(held.asks[0]?.signal.aborted).toBe(true);
  });

  it("withdraws the question when the attachment itself ends", async () => {
    const held = holdingHost();
    const attachment = new AbortController();
    const tool = createAskUserTool(held.askUser, attachment.signal);

    const answered = tool.execute(
      "call-8",
      { question: "Which one?" },
      new AbortController().signal,
    );
    attachment.abort();
    held.answer(CHOSE_ONE);
    await answered;

    // Both signals are watched rather than only Pi's, which today aborts the run
    // when the attachment does. That chaining is somebody else's implementation
    // detail, and a question that outlived its attachment would park forever.
    expect(held.asks[0]?.signal.aborted).toBe(true);
  });

  it("hands the host a withdrawn question when the turn had already given up", async () => {
    const host = recordingHost(CHOSE_ONE);
    const tool = createAskUserTool(host.askUser);

    // Adding a listener to an already-aborted signal never fires it, so the
    // state is read rather than waited on — otherwise a question raised into a
    // cancelled turn would be shown with no way left to withdraw it.
    await tool.execute("call-9", { question: "Which one?" }, AbortSignal.abort());

    expect(host.asks[0]?.signal.aborted).toBe(true);
  });

  it("stops watching a signal once the question has been answered", async () => {
    const host = recordingHost(CHOSE_ONE);
    const attachment = new AbortController();
    const tool = createAskUserTool(host.askUser, attachment.signal);

    await tool.execute("call-10", { question: "First?" });
    await tool.execute("call-11", { question: "Second?" });
    attachment.abort();

    // One attachment outlives every question asked against it, so a listener
    // left behind by an answered question is one leak per ask for the life of
    // the Session. A withdrawal that still reached two settled questions is what
    // that leak would look like from here.
    expect(host.asks.map((ask) => ask.signal.aborted)).toEqual([false, false]);
  });

  it("fails the call when the host cannot obtain an answer at all", async () => {
    const tool = createAskUserTool(async () => {
      throw new Error("nobody is holding this Session open");
    });

    await expect(tool.execute("call-12", { question: "Which one?" })).rejects.toThrow(
      "nobody is holding this Session open",
    );
  });
});
