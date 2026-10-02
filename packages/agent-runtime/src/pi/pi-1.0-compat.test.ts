/** Provider replay fixes relied on by the Pi 1.0 migration. */
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { describe, expect, it } from "vite-plus/test";

const model = getBuiltinModel("openai", "gpt-6.1-sol") as Model<"openai-responses">;
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("Pi 1.0 grammar tool replay", () => {
  it.each(["radius", "openai"])(
    "does not send an fc_ item id for a grammar call recorded by %s",
    (provider) => {
      const callId = "call_saved|fc_saved";
      const assistant: AssistantMessage = {
        role: "assistant",
        api: "openai-responses",
        provider,
        model: model.id,
        content: [
          { type: "toolCall", id: callId, name: "codemode", arguments: { code: "return 7;" } },
        ],
        usage,
        stopReason: "toolUse",
        timestamp: 0,
      };
      const converted = convertResponsesMessages(
        model,
        normalizeContext({
          messages: [
            assistant,
            {
              role: "toolResult",
              toolName: "codemode",
              toolCallId: callId,
              content: [{ type: "text", text: "Returned: 7" }],
              isError: false,
              timestamp: 0,
            },
          ],
        }),
        new Set(["openai"]),
        { grammarToolInputProperties: new Map([["codemode", "code"]]) },
      );
      const call = converted.find((item) => item.type === "custom_tool_call");
      const result = converted.find((item) => item.type === "custom_tool_call_output");
      expect(call).toMatchObject({
        type: "custom_tool_call",
        name: "codemode",
        call_id: "call_saved",
        input: "return 7;",
      });
      expect(call?.id).toBeUndefined();
      expect(result).toMatchObject({
        type: "custom_tool_call_output",
        call_id: "call_saved",
        output: "Returned: 7",
      });
    },
  );
});
