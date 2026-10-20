import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

// A real 128x128 RGB PNG with deterministic noise (LCG seed 748), not an
// arbitrary base64 string. Its 65 KiB base64 payload crosses the ordinary
// activity-string cap, so a thumbnail-only test cannot hide truncated images.
const PNG = readFileSync(new URL("./paper-canvas.png", import.meta.url)).toString("base64");
const server = new McpServer({ name: "paper-shaped-images-fixture", version: "1.0.0" });
server.registerTool(
  "get_screenshot",
  {
    description: "Get a PNG screenshot of the fixture canvas",
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [
      { type: "text", text: "Fixture canvas screenshot" },
      { type: "image", data: PNG, mimeType: "image/png" },
    ],
    structuredContent: { canvas: "fixture-canvas" },
  }),
);
// Paper has 34 tools. The catalog must cross discovery's actual stdio codec
// and the birth policy must defer it without a test-supplied route override.
for (let index = 1; index < 34; index += 1) {
  server.registerTool(
    `canvas_read_${index}`,
    { description: `Read fixture canvas record ${index}`, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: `canvas record ${index}` }] }),
  );
}
await server.connect(new StdioServerTransport());
