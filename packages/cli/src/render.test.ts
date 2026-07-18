import { describe, expect, it } from "vite-plus/test";

import { exitCodeForError, renderCliError, renderCliSuccess } from "./render";

describe("renderCliSuccess", () => {
  it("renders ticket lists as stable, untruncated non-TTY columns", () => {
    expect(
      renderCliSuccess(
        "ticket.list",
        {
          tickets: [
            {
              id: "VC-12",
              status: "doing",
              title: "Fix login flow without truncating this title",
              labels: ["bug", "security"],
            },
          ],
        },
        { json: false, tty: false },
      ),
    ).toBe("VC-12  Doing  Fix login flow without truncating this title  [bug, security]\n");
  });

  it("keeps brief JSON parallel to raw prompt output and formats stable errors", () => {
    const data = { prompt: "# Fix auth\n\nUse the volli skill." };
    expect(renderCliSuccess("ticket.brief", data, { json: false, tty: false })).toBe(
      "# Fix auth\n\nUse the volli skill.\n",
    );
    expect(renderCliSuccess("ticket.brief", data, { json: true, tty: false })).toBe(
      '{"prompt":"# Fix auth\\n\\nUse the volli skill."}\n',
    );
    expect(
      renderCliError({ code: "BODY_MATCH_FAILED", message: "The old text is not unique." }),
    ).toBe("error[BODY_MATCH_FAILED] The old text is not unique.\n");
    expect(exitCodeForError("APP_UNREACHABLE")).toBe(3);
    expect(exitCodeForError("INVALID_REQUEST")).toBe(2);
    expect(exitCodeForError("BODY_MATCH_FAILED")).toBe(1);
  });
});
