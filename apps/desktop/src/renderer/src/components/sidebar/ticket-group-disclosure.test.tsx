// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SidebarProvider } from "@renderer/components/ui/sidebar";
import { TicketGroupDisclosure } from "./ticket-group-disclosure";
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("@renderer/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => preference.reduced,
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const journeys: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
const animate = vi.fn(() => {
  const journey = { cancel: vi.fn(), onfinish: null as (() => void) | null };
  journeys.push(journey);
  return journey;
});
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <SidebarProvider>
      <ul>
        <TicketGroupDisclosure
          open={open}
          id="sessions"
          header={
            <button aria-controls="sessions" onClick={() => setOpen(!open)}>
              Ticket
            </button>
          }
        >
          <li>Session</li>
        </TicketGroupDisclosure>
      </ul>
    </SidebarProvider>
  );
}
async function click(detail = 1) {
  await act(async () =>
    host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })),
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preference.reduced = false;
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  animate.mockClear();
  journeys.length = 0;
  await act(async () => root.render(<Harness />));
  const body = host.querySelector(".overflow-hidden")!;
  Object.defineProperty(body, "scrollHeight", { value: 100 });
  Object.defineProperty(body, "animate", { value: animate });
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 40));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
describe("ticket-group disclosure", () => {
  it("uses the one approved 200/160 height+opacity clock and retargets from the live height", async () => {
    await click();
    expect(animate).toHaveBeenLastCalledWith(
      [
        { height: "0px", opacity: 0 },
        { height: "100px", opacity: 1 },
      ],
      expect.objectContaining({ duration: 200 }),
    );
    await click();
    expect(journeys[0].cancel).toHaveBeenCalled();
    expect(animate).toHaveBeenLastCalledWith(
      [
        { height: "40px", opacity: 1 },
        { height: "0px", opacity: 0 },
      ],
      expect.objectContaining({ duration: 160 }),
    );
    expect(host.textContent).toContain("Session");
    await act(async () => journeys[1].onfinish?.());
    expect(host.textContent).not.toContain("Session");
  });
  it("keyboard opens/closes immediately, and Motion-off cancels a live disclosure", async () => {
    await click(0);
    expect(animate).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Session");
    await click(0);
    expect(host.textContent).not.toContain("Session");
    await click();
    preference.reduced = true;
    await act(async () => root.render(<Harness />));
    expect(journeys[0].cancel).toHaveBeenCalled();
    expect(host.textContent).toContain("Session");
    await click();
    expect(host.textContent).not.toContain("Session");
    expect(animate).toHaveBeenCalledOnce();
  });
});
