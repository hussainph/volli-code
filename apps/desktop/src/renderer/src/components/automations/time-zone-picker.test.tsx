import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TimeZonePicker } from "./time-zone-picker";

describe("TimeZonePicker", () => {
  it("exposes a long stored zone without opening the width-capped trigger", () => {
    const zone = "America/Argentina/Buenos_Aires";
    const markup = renderToStaticMarkup(<TimeZonePicker value={zone} onChange={() => {}} />);
    const trigger = /<button[^>]*aria-label="Time zone"[^>]*>/.exec(markup)?.[0];

    expect(trigger).toContain(`title="${zone}"`);

    const classes = /class="([^"]*)"/.exec(trigger ?? "")?.[1]?.split(" ") ?? [];
    expect(classes).toContain("max-w-52");
    expect(classes).not.toContain("w-52");
  });
});
