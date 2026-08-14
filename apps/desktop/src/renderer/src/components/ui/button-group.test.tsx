/**
 * The group's seams, asserted as REACH rather than as a string.
 *
 * The bug this file exists for shipped because the fusion is a class list, and
 * a class list always looks right: every rule was present and correct, and none
 * of them reached the control it was written for. A tooltip on a disabled
 * button puts a span between the group and the button — a disabled button emits
 * no pointer events, so the wrapper is the only way its reason can be read — so
 * every `>` rule landed on the span, the pill shattered at that seam in the
 * shipped app, and a `toContain("rounded-l-none")` test would have stayed green
 * the whole time.
 *
 * So the question here is never "is this class in the string". It is: given the
 * DOM the call site really produces, does a rule painting this utility REACH
 * this element — a computed answer, over the class list the component actually
 * renders. {@link paints} answers it with a matcher covering the whole selector
 * grammar this component uses, which THROWS on anything outside it rather than
 * quietly answering "no" to a selector it failed to read.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";

/** One element on the way down from the group, as the facts these rules test. */
interface GroupNode {
  slot?: string;
  first: boolean;
  last: boolean;
}

/** One step of an arbitrary-variant selector: how we got here, and what we are. */
interface Step {
  combinator: ">" | "_" | null;
  compound: string;
}

/** Split at bracket/paren depth zero, so a group is never cut in half. */
function splitOutsideGroups(text: string, isBoundary: (character: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (depth === 0 && index > start && isBoundary(character)) {
      parts.push(text.slice(start, index));
      start = index;
    }
    if (character === "[" || character === "(") depth += 1;
    else if (character === "]" || character === ")") depth -= 1;
  }
  parts.push(text.slice(start));
  return parts;
}

/** `&>*:not(:first-child)>[data-slot=button]` → one Step per element it walks. */
function stepsOf(selector: string): Step[] {
  return splitOutsideGroups(selector, (character) => character === ">" || character === "_").map(
    (part, index) =>
      index === 0
        ? { combinator: null, compound: part }
        : { combinator: part.startsWith(">") ? ">" : "_", compound: part.slice(1) },
  );
}

/** Whether one simple selector — `*`, `[data-slot=x]`, `:first-child`, `:not(…)` — holds. */
function partHolds(part: string, node: GroupNode): boolean {
  if (part === "*") return true;
  if (part === ":first-child") return node.first;
  if (part === ":last-child") return node.last;
  if (part.startsWith(":not(")) return !partHolds(part.slice(5, -1), node);
  const slot = /^\[data-slot=([\w-]+)\]$/.exec(part);
  if (slot !== null) return node.slot === slot[1];
  throw new Error(`button-group.test: unsupported selector part \`${part}\``);
}

/** Whether every simple selector in one compound holds of `node`. */
function compoundHolds(compound: string, node: GroupNode): boolean {
  return splitOutsideGroups(compound, (character) => character === ":" || character === "[").every(
    (part) => partHolds(part, node),
  );
}

/**
 * Whether `steps` selects the last element of `path`.
 *
 * Matched right to left the way a browser does it. `path[0]` is the group's
 * direct child, so index −1 is the group itself (`&`, step 0) and a walk that
 * consumes every step and lands exactly there is a match; a descendant
 * combinator tries every ancestor above the element it matched.
 */
function selects(steps: Step[], path: GroupNode[]): boolean {
  const walk = (stepIndex: number, pathIndex: number): boolean => {
    if (stepIndex === 0) return pathIndex === -1;
    if (pathIndex < 0) return false;
    const step = steps[stepIndex];
    if (!compoundHolds(step.compound, path[pathIndex])) return false;
    if (step.combinator === ">") return walk(stepIndex - 1, pathIndex - 1);
    for (let ancestor = pathIndex - 1; ancestor >= -1; ancestor -= 1) {
      if (walk(stepIndex - 1, ancestor)) return true;
    }
    return false;
  };
  return walk(steps.length - 1, path.length - 1);
}

/**
 * `[&…]:utility` → the selector body and the utility it paints.
 *
 * The closing bracket is found by DEPTH, never by the first `]:` in the token —
 * `[&>[data-slot=select-trigger]:not(…)]:w-fit` carries one INSIDE its selector,
 * and reading that as the end hands back a body cut through the middle.
 */
function ruleOf(token: string): { body: string; utility: string } | null {
  if (!token.startsWith("[&")) return null;
  let depth = 0;
  for (let index = 0; index < token.length; index += 1) {
    if (token[index] === "[") depth += 1;
    else if (token[index] === "]") {
      depth -= 1;
      if (depth === 0) return { body: token.slice(1, index), utility: token.slice(index + 2) };
    }
  }
  return null;
}

/** Whether any rule on `classList` paints `utility` on the element ending `path`. */
function paints(classList: string[], path: GroupNode[], utility: string): boolean {
  return classList.some((token) => {
    const rule = ruleOf(token);
    return rule !== null && rule.utility === utility && selects(stepsOf(rule.body), path);
  });
}

/**
 * The group's own class list, read off the markup the component really renders
 * — not off `buttonGroupVariants`, so that a rule `cn()` merges away is a rule
 * this file can see is gone.
 *
 * Which is why the entities have to come back: an attribute value is escaped on
 * the way out, and `&` and `>` are the two characters these selectors are BUILT
 * from, so `[&>*:not(:first-child)]` arrives as `[&amp;&gt;*:not(:first-child)]`
 * and matches nothing. `&amp;` goes last or it would re-open the ones above it.
 */
function groupClassList(markup: string): string[] {
  const attribute = /<div[^>]*role="group"[^>]*class="([^"]*)"/.exec(markup);
  if (attribute === null) throw new Error("button-group.test: no group element in the markup");
  return attribute[1]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .split(" ")
    .filter(Boolean);
}

const HORIZONTAL = groupClassList(renderToStaticMarkup(<ButtonGroup />));
const VERTICAL = groupClassList(renderToStaticMarkup(<ButtonGroup orientation="vertical" />));

/** The call site's shape: a trigger wrapper standing in front of a lone button. */
function wrappedButton(position: { first: boolean; last: boolean }): GroupNode[] {
  return [position, { slot: "button", first: true, last: true }];
}

describe("ButtonGroup fusion", () => {
  it("collapses the seam of a button standing behind a trigger wrapper", () => {
    // THE REGRESSION. The wrapper leads the group, so the button inside keeps
    // its left cap and has to give up its right one — and until the twin rules
    // existed, every rule that should have done it was aimed at the span.
    const leading = wrappedButton({ first: true, last: false });
    expect(paints(HORIZONTAL, leading, "rounded-r-none")).toBe(true);
    expect(paints(HORIZONTAL, leading, "rounded-l-none")).toBe(false);
    expect(paints(HORIZONTAL, leading, "border-l-0")).toBe(false);

    // And the mirror: a wrapper arriving last gives up its left cap and the
    // border it would otherwise double against its neighbour.
    const trailing = wrappedButton({ first: false, last: true });
    expect(paints(HORIZONTAL, trailing, "rounded-l-none")).toBe(true);
    expect(paints(HORIZONTAL, trailing, "border-l-0")).toBe(true);
    expect(paints(HORIZONTAL, trailing, "rounded-r-none")).toBe(false);
  });

  it("still collapses the seam of a button sitting straight in the group", () => {
    // The twins are additions, not replacements: an unwrapped child is reached
    // by exactly the rules it always was.
    const trailing: GroupNode[] = [{ slot: "button", first: false, last: true }];
    expect(paints(HORIZONTAL, trailing, "rounded-l-none")).toBe(true);
    expect(paints(HORIZONTAL, trailing, "border-l-0")).toBe(true);
    expect(paints(HORIZONTAL, trailing, "rounded-r-none")).toBe(false);
  });

  it("leaves a nested group's own pill alone", () => {
    // A nested ButtonGroup is a SEPARATE pill — the base class gaps it away
    // from its neighbours — so reaching one level into it would flatten the
    // outer edge of buttons it has already fused for itself.
    const insideNested: GroupNode[] = [
      { slot: "button-group", first: false, last: true },
      { slot: "button", first: true, last: false },
    ];
    expect(paints(HORIZONTAL, insideNested, "rounded-l-none")).toBe(false);
    expect(paints(HORIZONTAL, insideNested, "border-l-0")).toBe(false);
    expect(paints(VERTICAL, insideNested, "rounded-t-none")).toBe(false);
  });

  it("fuses a wrapped button on the vertical axis too", () => {
    const trailing = wrappedButton({ first: false, last: true });
    expect(paints(VERTICAL, trailing, "rounded-t-none")).toBe(true);
    expect(paints(VERTICAL, trailing, "border-t-0")).toBe(true);
    expect(paints(VERTICAL, trailing, "rounded-b-none")).toBe(false);
  });

  it("lifts a wrapped button when it takes the keyboard ring", () => {
    // With the seams collapsed, a focus ring is drawn under the neighbouring
    // border unless the focused control is raised — the same wrapper blindness
    // wearing a different costume.
    const leading = wrappedButton({ first: true, last: false });
    expect(paints(HORIZONTAL, leading, "focus-visible:relative")).toBe(true);
    expect(paints(HORIZONTAL, leading, "focus-visible:z-10")).toBe(true);
  });

  it("really does put a span between the group and a tooltipped disabled button", () => {
    // The other half of the claim, and the half no selector can make: that the
    // DOM assumed above is the DOM this composition produces. If Radix stopped
    // rendering the trigger wrapper as a direct child of the group, or Button
    // stopped stamping `data-slot`, every assertion above would keep passing
    // against a shape that no longer exists.
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ButtonGroup aria-label="Publish repository changes">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex min-w-0">
                <Button variant="outline" size="sm" disabled>
                  <span>Commit</span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Nothing to commit</TooltipContent>
          </Tooltip>
          <Button variant="outline" size="icon-sm" aria-label="More repository actions">
            <span>More</span>
          </Button>
        </ButtonGroup>
      </TooltipProvider>,
    );

    // Two levels, not one: group → wrapper → button.
    expect(markup).toMatch(/<div[^>]*role="group"[^>]*><span[^>]*><button[^>]*>/);
    // Load-bearing on both sides — the button really is disabled (so the
    // tooltip cannot hang off it), and it really does carry the `data-slot`
    // the twin rules select on.
    expect(markup).toMatch(/<span[^>]*><button[^>]*data-slot="button"[^>]*disabled/);
    // And the group holds both shapes at once: the neighbour is a direct child.
    expect(markup).toMatch(/<\/span><button[^>]*data-slot="button"/);
  });
});
