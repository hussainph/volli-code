import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionMessageList } from "./session-message-list";

describe("SessionMessageList", () => {
  it("bundles inspectable tools and shows provider reasoning separately from answer text", () => {
    const html = renderToStaticMarkup(
      <SessionMessageList
        frames={[
          {
            sequence: 7,
            transcript: {
              message: {
                role: "assistant",
                parts: [
                  { type: "reasoning", text: "Inspecting the Session projection." },
                  { type: "text", text: "The projection is durable." },
                  {
                    type: "dynamic-tool",
                    toolName: "read",
                    toolCallId: "call-read",
                    title: "Read transcript mapping",
                    state: "output-available",
                    input: { path: "src/session-runtime.ts", offset: 1149 },
                    output: { content: "case transcript.message", truncated: false },
                    toolMetadata: { opencode: { metadata: { bytes: 42 } } },
                  },
                  {
                    type: "dynamic-tool",
                    toolName: "write",
                    toolCallId: "call-write",
                    title: "Write missing file",
                    state: "output-error",
                    input: { path: "src/missing.ts" },
                    errorText: "File not found",
                  },
                ],
              },
            },
          },
        ]}
      />,
    );

    expect(html).toContain("0007 assistant");
    expect(html).toContain("The projection is durable.");
    expect(html).toMatch(/<summary[^>]*>Reasoning summary<\/summary>/);
    expect(html).toContain("Inspecting the Session projection.");
    expect(html).toMatch(/<summary[^>]*>2 tool calls<\/summary>/);
    expect(html).toContain("Read transcript mapping");
    expect(html).toContain("read · output-available");
    expect(html).toContain("call-read");
    expect(html).toContain("src/session-runtime.ts");
    expect(html).toContain("case transcript.message");
    expect(html).toContain("bytes");
    expect(html).toContain("Write missing file");
    expect(html).toContain("write · output-error");
    expect(html).toContain("File not found");
    expect(html).not.toContain("[reasoning, dynamic-tool");
  });
});
