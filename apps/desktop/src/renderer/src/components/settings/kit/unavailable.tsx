/**
 * How a surface says "this is designed, and it does not work yet".
 *
 * Some of what this redesign lays out has no plumbing behind it — MCP servers
 * need a config reader, a process spawner, health monitoring and tool
 * injection into the Agent Runtime; plugins have no format decision yet. The
 * choice is between hiding those categories until the day they land, or
 * showing the shape and being honest about the state.
 *
 * Showing them wins, but ONLY under three rules, because a preview that lies
 * is worse than an absence:
 *
 *  1. **It says so, first and in words.** {@link UnavailableNotice} goes above
 *     the preview, not under it. Someone who reads one thing must read the one
 *     that stops them waiting for a response that is never coming.
 *  2. **Nothing in it can be operated.** Not "clicking does nothing" — a
 *     control that takes focus, depresses and then ignores you is the exact
 *     shape of a bug report. `inert` removes the whole subtree from hit
 *     testing, from the tab order, and from the accessibility tree at once.
 *  3. **It shows the empty state, never invented data.** A table of plausible
 *     fake servers is indistinguishable from real ones that have gone wrong,
 *     and someone will screenshot it. Whatever renders inside must be what a
 *     real, correctly-working, unconfigured surface would render.
 *
 * Rule 3 is not enforceable here; it is the caller's discipline, and it is
 * why every pane in `panes/` that uses this passes an empty collection rather
 * than a fixture.
 */
import type * as React from "react";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";

import { Notice } from "@renderer/components/ui/notice";

/**
 * The banner. One sentence on what is missing, one on what to do meanwhile.
 *
 * `tone="neutral"`, deliberately: this is not a fault, not a warning and not
 * something the reader can act on. An amber notice here would compete with the
 * real attention states on the same rail for a fact that is merely a roadmap.
 */
export function UnavailableNotice({
  what,
  meanwhile,
}: {
  /** What does not work yet, as a noun phrase: "MCP servers". */
  what: string;
  /** The honest alternative, if there is one. Omit when there is not. */
  meanwhile?: React.ReactNode;
}) {
  return (
    <Notice
      icon={WrenchIcon}
      tone="neutral"
      title={`${what} aren't available yet.`}
      detail={meanwhile ?? "This page previews the controls. You can't change them yet."}
    />
  );
}

/**
 * The preview itself: visible, dimmed, and genuinely inoperable.
 *
 * `inert` is doing the real work — it is one attribute that takes the subtree
 * out of hit testing, the tab order and the accessibility tree together. The
 * hand-rolled version of this is `pointer-events-none` plus `aria-hidden` plus
 * a `tabIndex={-1}` on every focusable descendant, and the third one is always
 * the one that gets forgotten, which leaves a keyboard user tabbing into a
 * region a mouse user cannot reach.
 *
 * The opacity is `/50` off the alpha ladder — half-present, which is what this
 * is. Not `/30`: at that weight the preview stops being legible, and an
 * illegible preview is just a smudge where a feature will be.
 */
export function UnavailablePreview({ children }: { children: React.ReactNode }) {
  return (
    // eslint-disable-next-line react/no-unknown-property -- `inert` is a React 19 boolean prop.
    <div inert className="pointer-events-none opacity-50 select-none">
      {children}
    </div>
  );
}

/** The two together, in the order that matters. */
export function Unavailable({
  what,
  meanwhile,
  children,
}: {
  what: string;
  meanwhile?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <UnavailableNotice what={what} meanwhile={meanwhile} />
      <UnavailablePreview>{children}</UnavailablePreview>
    </>
  );
}
