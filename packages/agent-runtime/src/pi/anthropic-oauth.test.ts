import { normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vite-plus/test";

// Exercise the installed pnpm patch through Pi and the real Anthropic SDK.
// The injected transport captures the request without credentials or network.
describe("Anthropic OAuth client identity", () => {
  it("advertises Claude Code 2.1.321 on subscription requests", async () => {
    const requests: Request[] = [];
    const response = await stream(
      getBuiltinModel("anthropic", "claude-fable-5-1"),
      normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
      {
        apiKey: "sk-ant-oat-test-token",
        maxRetries: 0,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "test" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      },
    ).result();

    expect(response.stopReason).toBe("error");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-ant-oat-test-token");
    expect(requests[0]?.headers.get("user-agent")).toBe("claude-cli/2.1.321");
    expect(requests[0]?.headers.get("x-app")).toBe("cli");
  });
});
