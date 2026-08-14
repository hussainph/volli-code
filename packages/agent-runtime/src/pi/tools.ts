/**
 * Product tool names to Pi core's context-injected file tools.
 *
 * Volli names the file tools this slice is willing to load; Pi's spellings stay
 * behind this map so nothing above the runtime dispatches on them.
 *
 * The bundle is the only limit here. Every tool is bound to the same
 * environment the runtime resolved, which today is Pi's own and reaches the
 * whole machine — so what a Session cannot do is what it was never handed, not
 * what something downstream would refuse.
 *
 * {@link createAskUserTool} sits outside that map on purpose. It is not a coding
 * tool and must not become one: {@link CodingToolId} is the vocabulary the
 * Authority rules are written in, and a name added there is a name every rule,
 * every durable Snapshot and every bundle then has an opinion about. Asking a
 * person a question needs no environment, touches no file, and reaches the
 * policy lexer as an unmapped name — which is exactly how an unknown tool is
 * meant to arrive there.
 */

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type AgentTool,
  type AgentToolResult,
  type ExecutionEnv,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type {
  CodingToolId,
  RuntimeToolBundle,
  SessionInteractionResolution,
  SessionRuntimeSpec,
} from "@volli/shared";

function bindContext<TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  env: ExecutionEnv,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate, { env }),
  };
}

function createTool(tool: CodingToolId, env: ExecutionEnv): AgentTool {
  switch (tool) {
    case "read":
      return bindContext(createReadTool(), env);
    case "edit":
      return bindContext(createEditTool(), env);
    case "write":
      return bindContext(createWriteTool(), env);
    case "execute":
      return bindContext(createBashTool(), env);
  }
}

/** Explicit Pi tool allowlist, in the order the product declared it. */
export function createPiTools(bundle: RuntimeToolBundle, env: ExecutionEnv): AgentTool[] {
  return bundle.tools.map((tool) => createTool(tool, env));
}

/** The name the model calls, and the name the Authority lexer will not recognise. */
export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * When to interrupt a person, in the only place the model will ever read it.
 *
 * A tool that can talk to the driver is a tool that will be used to talk to the
 * driver unless the description says otherwise, so most of this is about what
 * not to do with it. The option guidance is the same concern from the other
 * side: a question with twenty answers is a question that should have been a
 * sentence, and one with none is a question the card renders as an empty box.
 */
const ASK_USER_DESCRIPTION = [
  "Ask the person driving this session a question, and wait for their answer.",
  "Use it only for a decision that genuinely blocks you and is theirs to make: a product or scope choice, an ambiguity in what they asked for, a trade-off with no defensible default.",
  "Do not use it for anything you can find out by reading the workspace, to narrate progress, or to confirm work you were already told to do.",
  "Keep the question to one or two sentences. Offer 2-5 concrete options when the answer is a choice; omit options entirely when you need them to write something.",
  "The turn is blocked until they answer.",
].join(" ");

const askUserSchema = Type.Object({
  question: Type.String({ description: "The question to put to them, in one or two sentences." }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ description: "Stable id for this option; returned when it is chosen." }),
        label: Type.String({ description: "The answer itself, in a few words." }),
        description: Type.Optional(
          Type.String({ description: "One line of extra context for this option." }),
        ),
      }),
      { description: "2-5 answers to choose between. Omit entirely to ask for free text." },
    ),
  ),
  multiple: Type.Optional(
    Type.Boolean({ description: "Whether more than one option may be chosen. Defaults to false." }),
  ),
});

/** Ask a person and block until they answer, exactly as the Session spec supplies it. */
export type AskUserPort = NonNullable<SessionRuntimeSpec["askUser"]>;

/**
 * What the model is told a person decided.
 *
 * Their option ids rather than the labels beside them, because the model wrote
 * both and the id is the half it chose to be stable. Nothing here reads the
 * answer for meaning: an id that happens to spell `reject` is one of the model's
 * own answers and not a refusal of anything.
 *
 * An answer can be empty on both halves — a card dismissed with nothing chosen
 * and nothing typed — and the model still needs something it can act on. Saying
 * so is the only honest reading; a default invented here would answer on a
 * person's behalf in their own transcript.
 */
function answerText(resolution: SessionInteractionResolution): string {
  const said = resolution.response?.trim() ?? "";
  const lines = [
    ...(resolution.optionIds.length > 0 ? [`Chose: ${resolution.optionIds.join(", ")}`] : []),
    ...(said.length > 0 ? [said] : []),
  ];
  if (lines.length === 0) return "The question was answered with no choice and no reply.";
  return lines.join("\n\n");
}

/**
 * Let the model stop and ask, for as long as it takes.
 *
 * Two signals reach one question and both are watched. Pi hands `execute` the
 * cancellation belonging to the run the call is part of; the attachment has its
 * own, which today reaches Pi's through `agent.abort()`. Racing only the second
 * would be racing on somebody else's implementation continuing to chain the two,
 * and a question that outlived its attachment parks forever. `AbortSignal.any`
 * composes them in one line at the cost of leaving the attachment signal holding
 * a dependent for the life of every question ever asked against it; one listener
 * per signal, removed in a `finally`, leaves it holding nothing.
 *
 * The composed signal is what the host is handed, and it is that host's only
 * notice that the card it opened must be withdrawn. An abort that already
 * happened is read rather than waited for: adding a listener to an aborted
 * signal never fires it, so a question raised into a cancelled turn would
 * otherwise be shown with nothing left to take it down.
 */
export function createAskUserTool(
  askUser: AskUserPort,
  signal?: AbortSignal,
): AgentTool<typeof askUserSchema, undefined> {
  return {
    name: ASK_USER_TOOL_NAME,
    label: "ask",
    description: ASK_USER_DESCRIPTION,
    parameters: askUserSchema,
    async execute(toolCallId, params, callSignal): Promise<AgentToolResult<undefined>> {
      const withdrawn = new AbortController();
      const abandon = (): void => withdrawn.abort();
      const signals = [signal, callSignal].filter((one) => one !== undefined);
      for (const one of signals) {
        if (one.aborted) abandon();
        else one.addEventListener("abort", abandon, { once: true });
      }
      try {
        const resolution = await askUser(
          {
            toolCallId,
            question: params.question,
            options: params.options,
            multiple: params.multiple,
          },
          withdrawn.signal,
        );
        return { content: [{ type: "text", text: answerText(resolution) }], details: undefined };
      } finally {
        for (const one of signals) one.removeEventListener("abort", abandon);
      }
    },
  };
}
