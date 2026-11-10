// @vitest-environment jsdom
/**
 * What the reader actually sees while a Turn is open (VC-357).
 *
 * `message-response.test.tsx` pins which plugin MAP each phase gets, against a
 * mocked Streamdown — a cheap guard that would keep passing if Streamdown
 * changed what a missing `code` plugin renders. These tests run the real
 * renderer in a real document instead, and assert the consequences the ticket
 * promised: the code is still READABLE while live, the frame and its actions
 * are still there, Mermaid and prose are untouched, and the colour arrives when
 * the Turn settles. Copy stays disabled until settle, then preserves the exact
 * fenced source; highlighted tokens carry both light and dark theme colours.
 *
 * They also pin the part of the trade that is easy to under-state. Dropping the
 * plugin is a whole-body decision, so a fence that CLOSED while the Turn is
 * still open is unhighlighted too, not just the one still being written.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MessageResponse } from "./message";
import { ReasoningBody } from "./reasoning";

/**
 * Streamdown defers offscreen code work behind an `IntersectionObserver`, which
 * jsdom does not implement. Reporting every observed node as on screen is the
 * honest stand-in here: the claim under test is about a fence the reader is
 * looking at, and a stub that said "offscreen" would pass by measuring nothing.
 */
class AlwaysVisibleIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(node: Element): void {
    this.callback(
      [{ isIntersecting: true, target: node } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/**
 * Shiki's mark, as Streamdown emits it: a per-token inline custom property.
 * Match spans: the frame's <pre> also carries --shiki-dark for its base colour
 * and is not evidence that any source tokens have actually been highlighted.
 * Its absence is what "plain code" means here — the `<pre><code>` frame and the
 * source text are present either way, which is the whole point of the fallback.
 */
const TOKEN = 'span[style*="--shiki-dark"]';
const CODE_BLOCK = '[data-streamdown="code-block"]';
const ACTIONS = '[data-streamdown="code-block-actions"]';
const COPY = '[data-streamdown="code-block-copy-button"]';
const MERMAID = '[data-streamdown="mermaid-block"]';

/** A fence that closed, followed by prose — the Turn is still being written. */
const CLOSED_FENCE = ["Intro.", "", "```ts", "export const closed = 1;", "```", "", "Still writing"]
  .join("\n")
  .concat("");

/** The fence the stream is in the middle of: no closing delimiter yet. */
const OPEN_FENCE = ["Intro.", "", "```ts", "export const opening = 2;"].join("\n");

const MERMAID_SOURCE = ["```mermaid", "graph TD;", "  A-->B;", "```"].join("\n");

let root: Root | null = null;
let container: HTMLElement | null = null;
/** jsdom lays nothing out, so it ships no `scrollTo`; the code block calls one. */
const nativeScrollTo = HTMLElement.prototype.scrollTo;
const nativeClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", AlwaysVisibleIntersectionObserver);
  HTMLElement.prototype.scrollTo = function () {};
  // Pele falls back to its built-in metrics without a canvas; jsdom has no
  // canvas implementation. Real-browser visual checks cover font/layout.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  HTMLElement.prototype.scrollTo = nativeScrollTo;
  if (nativeClipboard) Object.defineProperty(navigator, "clipboard", nativeClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function draw(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root?.render(node);
  });
}

/**
 * Shiki is lazy and asynchronous by design — Streamdown hands it the source
 * after React commits — so the settled assertion has to wait for a highlighter
 * that has not been asked to run yet rather than read the DOM once.
 */
async function waitForTokens(timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    container?.querySelector(TOKEN) === null ||
    container?.querySelector(TOKEN) === undefined
  ) {
    if (Date.now() > deadline) throw new Error("timed out waiting for Shiki tokens");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function pause(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForDiagram(): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!container?.querySelector("svg.pele")) {
    if (Date.now() > deadline) throw new Error("timed out waiting for Pele SVG");
    await pause(25);
  }
}

const query = (selector: string) => container?.querySelector(selector) ?? null;
const text = () => container?.textContent ?? "";
const copyButton = () => container?.querySelector<HTMLButtonElement>(COPY);

describe("markdown while a Turn is open", () => {
  it("keeps an unterminated fence readable, framed and unhighlighted", async () => {
    await draw(<MessageResponse isAnimating>{OPEN_FENCE}</MessageResponse>);

    // Readable: the source is on screen, not swallowed by the missing plugin.
    expect(text()).toContain("export const opening = 2;");
    expect(text()).toContain("Intro.");
    // Framed: Streamdown's own code block and its copy/download row survive.
    expect(query(CODE_BLOCK)).not.toBeNull();
    expect(query(ACTIONS)).not.toBeNull();
    // The settle-only policy remains deliberate even with an incremental
    // highlighter: upgrading the plugin must not re-enable live tokenization.
    expect(query(TOKEN)).toBeNull();
  });

  /*
   * The scope of the trade, pinned rather than described. Both phases render
   * the SAME string, so nothing here depends on the content changing — only on
   * which plugin map the phase selected.
   */
  it("leaves an already-closed fence plain until the Turn settles, then colours it", async () => {
    await draw(<MessageResponse isAnimating>{CLOSED_FENCE}</MessageResponse>);

    expect(text()).toContain("export const closed = 1;");
    expect(query(CODE_BLOCK)).not.toBeNull();
    expect(query(TOKEN)).toBeNull();

    await draw(<MessageResponse>{CLOSED_FENCE}</MessageResponse>);
    await waitForTokens();

    expect(query(TOKEN)).not.toBeNull();
    // The settle must not cost the reader the text it was already reading.
    expect(text()).toContain("export const closed = 1;");
    expect(text()).toContain("Still writing");
    expect(query(ACTIONS)).not.toBeNull();
  }, 12_000);

  it("copies the exact settled source and keeps copy disabled while streaming", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    // A fenced block's final newline is part of the source Streamdown copies.
    const source = 'export const copied = "Volli";\nconsole.log(copied);\n';
    const markdown = `\`\`\`ts\n${source}\`\`\``;

    await draw(<MessageResponse isAnimating>{markdown}</MessageResponse>);
    expect(copyButton()?.disabled).toBe(true);
    await act(async () => copyButton()?.click());
    expect(writeText).not.toHaveBeenCalled();

    await draw(<MessageResponse>{markdown}</MessageResponse>);
    await waitForTokens();
    expect(copyButton()?.disabled).toBe(false);
    await act(async () => copyButton()?.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    expect(text()).toContain("Copied");
    // Dual-theme tokens must still carry both light and dark colours.
    expect(query(TOKEN)?.getAttribute("style")).toContain("--sdm-c:");
  }, 12_000);

  it("renders a closed diagram through Pele and preserves fullscreen controls", async () => {
    await draw(<MessageResponse>{MERMAID_SOURCE}</MessageResponse>);
    await waitForDiagram();

    expect(query(MERMAID)).not.toBeNull();
    expect(query("svg.pele-flowchart")).not.toBeNull();
    const fullscreen = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="View fullscreen"]',
    );
    expect(fullscreen).not.toBeNull();
    await act(async () => fullscreen?.click());
    expect(document.querySelector('[data-streamdown="mermaid-fullscreen"]')).not.toBeNull();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Exit fullscreen"]')?.click();
    });
  });

  it("keeps the last good drawing during an invalid open-fence update, then falls back on close", async () => {
    const opening = "```mermaid\nflowchart LR\n A[Start]-->B[Finish]\n";
    const partial = `${opening} C[unfinished`;
    await draw(<MessageResponse isAnimating>{opening}</MessageResponse>);
    await waitForDiagram();
    const good = query("svg.pele")?.outerHTML;

    await draw(<MessageResponse isAnimating>{partial}</MessageResponse>);
    await pause(150);
    expect(query("svg.pele")?.outerHTML).toBe(good);
    expect(query(CODE_BLOCK)).toBeNull();
    expect(text()).not.toContain("Error");

    await draw(<MessageResponse isAnimating>{`${partial}\n\`\`\``}</MessageResponse>);
    expect(query(CODE_BLOCK)).not.toBeNull();
    expect(text()).toContain("C[unfinished");
    expect(query("svg.pele")).toBeNull();
  });

  it("is quiet before the first valid frame and falls back when an unclosed Turn settles", async () => {
    const partial = "```mermaid\nnot a diagram";
    await draw(<MessageResponse isAnimating>{partial}</MessageResponse>);
    await pause(150);
    expect(query(CODE_BLOCK)).toBeNull();
    expect(text()).not.toMatch(/Error|Loading diagram/);

    await draw(<MessageResponse>{partial}</MessageResponse>);
    expect(query(CODE_BLOCK)).not.toBeNull();
    expect(text()).toContain("not a diagram");
  });

  it("validates immediately at settle instead of preserving a formerly valid prefix", async () => {
    const opening = "```mermaid\nflowchart LR\n A[Good]\n";
    await draw(<MessageResponse isAnimating>{opening}</MessageResponse>);
    await waitForDiagram();
    const partial = `${opening} B[unfinished`;
    await draw(<MessageResponse isAnimating>{partial}</MessageResponse>);
    await pause(150);
    expect(query("svg.pele")).not.toBeNull();

    await draw(<MessageResponse>{partial}</MessageResponse>);
    expect(query("svg.pele")).toBeNull();
    expect(text()).toContain("B[unfinished");
  });

  it("holds the last good frame in live reasoning and uses the final fallback too", async () => {
    const opening = "```mermaid\nflowchart LR\n A[Good]\n";
    await draw(<ReasoningBody isAnimating>{opening}</ReasoningBody>);
    await waitForDiagram();
    const good = query("svg.pele")?.outerHTML;
    const partial = `${opening} B[unfinished`;
    await draw(<ReasoningBody isAnimating>{partial}</ReasoningBody>);
    await pause(150);
    expect(query("svg.pele")?.outerHTML).toBe(good);
    expect(query(CODE_BLOCK)).toBeNull();

    await draw(<ReasoningBody>{partial}</ReasoningBody>);
    expect(query("svg.pele")).toBeNull();
    expect(text()).toContain("B[unfinished");
    expect(query(CODE_BLOCK)).not.toBeNull();
  });

  it("keeps ordinary markdown drawing in the live pipeline", async () => {
    await draw(
      <MessageResponse isAnimating>{"A *stressed* word.\n\n- one\n- two\n"}</MessageResponse>,
    );

    expect(query("em")).not.toBeNull();
    expect(container?.querySelectorAll("li").length).toBe(2);
    expect(text()).toContain("A stressed word.");
  });
});
