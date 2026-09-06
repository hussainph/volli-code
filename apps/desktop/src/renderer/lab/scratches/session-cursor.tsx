/**
 * Browser Tab ownership and the Session cursor (VC-239) — every surface the
 * hold shows up on, over a fixture page, with a driver that plays a Session's
 * actions through the cursor so the motion can be judged and each case in the
 * ticket walked by hand.
 *
 * What is REAL here: `BrowserChrome` with the holder pill, the tab strip with
 * the holder dot in its badge slot, and `SessionCursor` itself — the same
 * component the main-owned overlay view bundles over a live tab. What is fake:
 * the page (a div drawn to look like a checkout form, light or dark), the
 * three Sessions, and the driver, which stands in for the port taking a hold
 * and asking the overlay to glide before it dispatches a click.
 *
 * ── WHAT TO ACTUALLY LOOK AT ──────────────────────────────────────────────
 *
 *   • THE OUTLINE, NOT THE HUE. Flip the page between light and dark with the
 *     same Session driving. The arrow must read on both without the colour
 *     doing the work — the dark halo carries it on white, the white line on
 *     black. If a hue disappears on either page the fix is the outline widths
 *     in `session-cursor.css`, not a brighter palette.
 *   • THE GLIDE LANDS BEFORE THE CLICK. Watch the Continue button: its press
 *     state fires when the arrow arrives, never before. The driver awaits the
 *     cursor's `onSettled`, exactly as the port will.
 *   • DISTANCE SCALING. The hop from Name to Email is short and should feel
 *     quick; the trip to Continue after a scroll is long and still lands
 *     inside 250ms. Neither should feel like the other.
 *   • ONLY THE ON-SCREEN TAB DRAWS A CURSOR. Start both Sessions, then switch
 *     tabs: the Pricing Session kept acting while hidden (its inbox log says
 *     so) and its cursor is at its LAST position when you arrive — no glide
 *     from wherever it was when you left.
 *   • TAKE OVER hands off; RELEASE fades. They should look like different
 *     events.
 *   • REDUCED MOTION jumps. Nothing glides, rings or nudges; the chip and the
 *     arrow still fade.
 *
 * Three Sessions, on purpose: two colours side by side is a coin toss and three
 * is the smallest set where "can I tell them apart at a glance" is a real
 * question. Their ids are fixed so the hashed colours are the same every load.
 */
import * as React from "react";
import {
  SESSION_CURSOR_GLIDE_MAX_MS,
  SESSION_CURSOR_LABEL_PIN_MS,
  assignSessionColors,
} from "@volli/shared";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";

import { BrowserChrome } from "@renderer/components/browser/browser-chrome";
import { BrowserHolderDot } from "@renderer/components/browser/browser-holder-dot";
import type { BrowserHolder } from "@renderer/components/browser/browser-holder-pill";
import {
  SessionCursor,
  type SessionCursorGesture,
} from "@renderer/components/browser/session-cursor";
import { Button } from "@renderer/components/ui/button";
import { Segmented } from "@renderer/components/ui/segmented";
import { Switch } from "@renderer/components/ui/switch";
import { Tab, TabStrip } from "@renderer/components/ui/tab-strip";
import { cn } from "@renderer/lib/utils";
import type { BrowserTabState } from "../../../ipc/contract";

export const title = "Session cursor & tab hold";
export const note =
  "Who holds a Browser Tab — the chrome pill, the strip dot, and the cursor gliding over a fixture page";

// ---- fixtures ---------------------------------------------------------------

interface LabSession {
  id: string;
  name: string;
}

const SESSIONS: readonly LabSession[] = [
  { id: "ses-7c1e-checkout", name: "Fix checkout form" },
  { id: "ses-2b9a-pricing", name: "Pricing copy pass" },
  { id: "ses-e04d-a11y", name: "Accessibility audit" },
];

const COLORS = assignSessionColors(SESSIONS.map((session) => session.id));

interface LabTab {
  id: string;
  label: string;
  url: string;
}

const TABS: readonly LabTab[] = [
  { id: "tab-checkout", label: "Checkout — Voltaic", url: "https://voltaic.dev/checkout" },
  { id: "tab-pricing", label: "Pricing", url: "https://voltaic.dev/pricing" },
  { id: "tab-docs", label: "Docs", url: "https://voltaic.dev/docs" },
];

/** Which Session's script drives which tab. Docs stays free. */
const SCRIPT_TAB: Record<string, string> = {
  "ses-7c1e-checkout": "tab-checkout",
  "ses-2b9a-pricing": "tab-pricing",
};

type Holder = { kind: "session"; sessionId: string } | { kind: "person" } | null;

interface CursorState {
  x: number;
  y: number;
  present: boolean;
  gesture: SessionCursorGesture;
  pressKey: number;
  labelPinned: boolean;
  handoff: boolean;
}

const CURSOR_AT_REST: CursorState = {
  x: 0,
  y: 0,
  present: false,
  gesture: null,
  pressKey: 0,
  labelPinned: false,
  handoff: false,
};

/** A step in a Session's script: what it does, to which fixture element. */
type Step =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string }
  | { kind: "select"; ref: string; value: string }
  | { kind: "scroll"; direction: "down" | "up" }
  | { kind: "hover"; ref: string }
  | { kind: "release" };

const SCRIPTS: Record<string, readonly Step[]> = {
  "ses-7c1e-checkout": [
    { kind: "click", ref: "name" },
    { kind: "type", ref: "name", text: "Ada Lovelace" },
    { kind: "click", ref: "email" },
    { kind: "type", ref: "email", text: "ada@voltaic.dev" },
    { kind: "select", ref: "plan", value: "team" },
    { kind: "scroll", direction: "down" },
    { kind: "hover", ref: "continue" },
    { kind: "click", ref: "continue" },
    { kind: "release" },
  ],
  "ses-2b9a-pricing": [
    { kind: "hover", ref: "plan" },
    { kind: "click", ref: "plan" },
    { kind: "select", ref: "plan", value: "solo" },
    { kind: "scroll", direction: "down" },
    { kind: "click", ref: "feature-3" },
    { kind: "scroll", direction: "up" },
    { kind: "click", ref: "name" },
    { kind: "type", ref: "name", text: "Grace Hopper" },
    { kind: "release" },
  ],
};

function tabState(tab: LabTab): BrowserTabState {
  return {
    tabId: tab.id,
    projectId: "prj-voltaic",
    ticketId: "tkt-14",
    createdBy: "session",
    url: tab.url,
    title: tab.label,
    loading: false,
    error: null,
    canGoBack: true,
    canGoForward: false,
    generation: 3,
    heldBy: null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the fixture page ---------------------------------------------------------

/**
 * A page that looks like a page, not like the app: its own type, its own
 * palette, no app tokens. The cursor has to be judged over something it does
 * not share a colour system with, because that is every page it will meet.
 */
function FixturePage({
  dark,
  values,
  pressed,
  hovered,
}: {
  dark: boolean;
  values: Record<string, string>;
  pressed: string | null;
  hovered: string | null;
}) {
  const ink = dark ? "#e7e7ea" : "#1b1b1f";
  const muted = dark ? "#9a9aa3" : "#6b6b76";
  const field = dark ? "#1c1c22" : "#ffffff";
  const border = dark ? "#33333c" : "#d8d8de";
  const button = dark ? "#f2f2f5" : "#111114";
  const buttonInk = dark ? "#111114" : "#ffffff";
  const fieldStyle = (ref: string): React.CSSProperties => ({
    height: 36,
    padding: "0 12px",
    borderRadius: 8,
    border: `1px solid ${hovered === ref ? (dark ? "#6b6bff" : "#3b3bff") : border}`,
    background: field,
    color: ink,
    fontSize: 14,
    fontFamily: "inherit",
    outline: pressed === ref ? `2px solid ${dark ? "#6b6bff" : "#3b3bff"}` : "none",
    outlineOffset: 1,
  });
  return (
    <div
      style={{
        background: dark ? "#111115" : "#f6f6f8",
        color: ink,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
        minHeight: "100%",
        padding: "28px 40px 60px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: 20,
          borderBottom: `1px solid ${border}`,
          marginBottom: 28,
        }}
      >
        <span style={{ fontWeight: 700, letterSpacing: "-0.02em", fontSize: 18 }}>voltaic</span>
        <span style={{ color: muted, fontSize: 13 }}>Checkout · Step 2 of 3</span>
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 6px" }}>
        Your details
      </h1>
      <p style={{ color: muted, fontSize: 14, margin: "0 0 24px" }}>
        We&apos;ll send the receipt and the workspace invite here.
      </p>
      <div style={{ display: "grid", gap: 16, maxWidth: 420 }}>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: muted }}>
          Full name
          <input
            data-fixture-ref="name"
            readOnly
            value={values.name ?? ""}
            placeholder="Ada Lovelace"
            style={fieldStyle("name")}
          />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: muted }}>
          Email
          <input
            data-fixture-ref="email"
            readOnly
            value={values.email ?? ""}
            placeholder="you@company.com"
            style={fieldStyle("email")}
          />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 13, color: muted }}>
          Plan
          <select
            data-fixture-ref="plan"
            value={values.plan ?? "solo"}
            onChange={() => undefined}
            style={fieldStyle("plan")}
          >
            <option value="solo">Solo — $12 / month</option>
            <option value="team">Team — $48 / month</option>
            <option value="org">Organisation — talk to us</option>
          </select>
        </label>
      </div>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "36px 0 10px" }}>What&apos;s included</h2>
      <ul
        style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8, maxWidth: 520 }}
      >
        {[
          "Unlimited boards and tickets",
          "Isolated worktrees per ticket",
          "Structured agent Sessions with durable history",
          "Browser Tabs your Sessions can drive",
          "Local-first storage, nothing leaves the machine",
          "Priority support on the Team plan",
        ].map((line, index) => (
          <li
            key={line}
            data-fixture-ref={`feature-${index}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${pressed === `feature-${index}` ? (dark ? "#6b6bff" : "#3b3bff") : border}`,
              background: field,
              fontSize: 14,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: dark ? "#6b6bff" : "#3b3bff",
              }}
            />
            {line}
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
        <button
          type="button"
          data-fixture-ref="back"
          style={{
            height: 38,
            padding: "0 16px",
            borderRadius: 999,
            border: `1px solid ${border}`,
            background: "transparent",
            color: ink,
            fontSize: 14,
            fontFamily: "inherit",
          }}
        >
          Back
        </button>
        <button
          type="button"
          data-fixture-ref="continue"
          style={{
            height: 38,
            padding: "0 18px",
            borderRadius: 999,
            border: 0,
            background: button,
            color: buttonInk,
            fontSize: 14,
            fontWeight: 600,
            fontFamily: "inherit",
            transform: pressed === "continue" ? "scale(0.97)" : "none",
            boxShadow:
              hovered === "continue" ? `0 0 0 3px ${dark ? "#6b6bff55" : "#3b3bff33"}` : "none",
            transition: "transform 120ms ease-out, box-shadow 120ms ease-out",
          }}
        >
          Continue to payment
        </button>
      </div>
    </div>
  );
}

// ---- the scratch --------------------------------------------------------------

export default function SessionCursorScratch() {
  const [activeTabId, setActiveTabId] = React.useState(TABS[0]!.id);
  const [holders, setHolders] = React.useState<Record<string, Holder>>({});
  const [cursors, setCursors] = React.useState<Record<string, CursorState>>({});
  const [values, setValues] = React.useState<Record<string, Record<string, string>>>({});
  const [pressed, setPressed] = React.useState<Record<string, string | null>>({});
  const [hovered, setHovered] = React.useState<Record<string, string | null>>({});
  const [running, setRunning] = React.useState<Record<string, boolean>>({});
  const [inbox, setInbox] = React.useState<{ seq: number; session: string; line: string }[]>([]);
  const [refusals, setRefusals] = React.useState<{ seq: number; line: string }[]>([]);
  const seqRef = React.useRef(0);
  const [darkPage, setDarkPage] = React.useState(false);
  const [reducedMotion, setReducedMotion] = React.useState(false);
  const [overlayOpen, setOverlayOpen] = React.useState(false);
  const [askedToLeave, setAskedToLeave] = React.useState<Record<string, boolean>>({});

  const planeRef = React.useRef<HTMLDivElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const holdersRef = React.useRef(holders);
  holdersRef.current = holders;
  const activeRef = React.useRef(activeTabId);
  activeRef.current = activeTabId;
  const overlayRef = React.useRef(overlayOpen);
  overlayRef.current = overlayOpen;
  const askedRef = React.useRef(askedToLeave);
  askedRef.current = askedToLeave;
  /** Waiters on the cursor's settle, per tab. Resolved by `onSettled`. */
  const settleRef = React.useRef<Record<string, (() => void) | undefined>>({});
  const abortRef = React.useRef<Record<string, boolean>>({});

  const log = React.useCallback((session: string, line: string) => {
    seqRef.current += 1;
    setInbox((current) => [...current.slice(-11), { seq: seqRef.current, session, line }]);
  }, []);

  const refuse = React.useCallback((line: string) => {
    seqRef.current += 1;
    setRefusals((current) => [...current.slice(-5), { seq: seqRef.current, line }]);
  }, []);

  const patchCursor = React.useCallback((tabId: string, patch: Partial<CursorState>) => {
    setCursors((current) => ({
      ...current,
      [tabId]: { ...(current[tabId] ?? CURSOR_AT_REST), ...patch },
    }));
  }, []);

  /** Centre of a fixture element, in the plane's pixels — `DOM.getBoxModel` stood in for. */
  const boxCentre = React.useCallback((ref: string): { x: number; y: number } | null => {
    const plane = planeRef.current;
    const element = plane?.querySelector<HTMLElement>(`[data-fixture-ref="${ref}"]`) ?? null;
    if (plane === null || element === null) return null;
    const box = element.getBoundingClientRect();
    const origin = plane.getBoundingClientRect();
    return { x: box.left - origin.left + box.width / 2, y: box.top - origin.top + box.height / 2 };
  }, []);

  /**
   * The port's rule 2: a write takes a free tab's hold, keeps its own, and is
   * refused on anyone else's. Answers whether the write may go ahead.
   */
  const acquire = React.useCallback(
    (sessionId: string, tabId: string): boolean => {
      const current = holdersRef.current[tabId] ?? null;
      if (current === null) {
        setHolders((all) => ({ ...all, [tabId]: { kind: "session", sessionId } }));
        patchCursor(tabId, { labelPinned: true, handoff: false });
        window.setTimeout(
          () => patchCursor(tabId, { labelPinned: false }),
          SESSION_CURSOR_LABEL_PIN_MS,
        );
        return true;
      }
      if (current.kind === "session" && current.sessionId === sessionId) return true;
      const name = SESSIONS.find((session) => session.id === sessionId)?.name ?? sessionId;
      if (current.kind === "person") {
        refuse(
          `${name} → browser_act refused by rule browser.person-has-tab: the person has taken this tab. Wait for them to hand it back, or open your own tab with browser_navigate and no tabId.`,
        );
      } else {
        const holder = SESSIONS.find((session) => session.id === current.sessionId)?.name;
        refuse(
          `${name} → browser_act refused by rule browser.tab-held: ${holder} holds this tab. Open your own tab with browser_navigate and no tabId, or wait.`,
        );
      }
      return false;
    },
    [patchCursor, refuse],
  );

  const releaseHold = React.useCallback(
    (tabId: string, why: "release" | "turn-end" | "handoff") => {
      setHolders((all) => ({ ...all, [tabId]: why === "handoff" ? { kind: "person" } : null }));
      patchCursor(tabId, { present: false, gesture: null, handoff: why === "handoff" });
      setAskedToLeave((all) => ({ ...all, [tabId]: false }));
    },
    [patchCursor],
  );

  /**
   * Glide the cursor to a point and wait for it to land — or not, if the tab
   * is not on screen. Bounded the way the port bounds it: an overlay that
   * does not answer inside the glide's ceiling plus slack does not hold up
   * the action.
   */
  const moveTo = React.useCallback(
    async (tabId: string, point: { x: number; y: number }): Promise<void> => {
      const onScreen = activeRef.current === tabId && !overlayRef.current;
      patchCursor(tabId, { x: point.x, y: point.y, present: true, gesture: null });
      if (!onScreen) return;
      await Promise.race([
        new Promise<void>((resolve) => {
          settleRef.current[tabId] = resolve;
        }),
        sleep(SESSION_CURSOR_GLIDE_MAX_MS + 150),
      ]);
      settleRef.current[tabId] = undefined;
    },
    [patchCursor],
  );

  const runScript = React.useCallback(
    async (session: LabSession) => {
      const tabId = SCRIPT_TAB[session.id];
      const steps = SCRIPTS[session.id];
      if (tabId === undefined || steps === undefined) return;
      setRunning((all) => ({ ...all, [session.id]: true }));
      abortRef.current[session.id] = false;
      log(session.id, `Turn started. First write on ${tabId} takes the hold.`);
      try {
        for (const step of steps) {
          if (abortRef.current[session.id]) return;
          // A steer from the person: release at the next safe point, which
          // for a script is between steps.
          if (askedRef.current[tabId]) {
            log(session.id, "Person asked me to leave; releasing the tab (browser_release).");
            releaseHold(tabId, "release");
            return;
          }
          if (step.kind === "release") {
            log(session.id, "Done here — browser_release.");
            releaseHold(tabId, "release");
            return;
          }
          if (!acquire(session.id, tabId)) {
            log(session.id, "Refused; opening my own tab instead and carrying on there.");
            return;
          }
          switch (step.kind) {
            case "hover":
            case "click": {
              const point = boxCentre(step.ref);
              if (point === null) break;
              await moveTo(tabId, point);
              if (abortRef.current[session.id]) return;
              if (step.kind === "hover") {
                patchCursor(tabId, { gesture: "hover" });
                setHovered((all) => ({ ...all, [tabId]: step.ref }));
                await sleep(420);
                break;
              }
              setCursors((current) => {
                const one = current[tabId] ?? CURSOR_AT_REST;
                return {
                  ...current,
                  [tabId]: { ...one, gesture: "click", pressKey: one.pressKey + 1 },
                };
              });
              setPressed((all) => ({ ...all, [tabId]: step.ref }));
              setHovered((all) => ({ ...all, [tabId]: null }));
              await sleep(160);
              setPressed((all) => ({ ...all, [tabId]: null }));
              await sleep(260);
              break;
            }
            case "type": {
              const point = boxCentre(step.ref);
              if (point === null) break;
              await moveTo(tabId, point);
              patchCursor(tabId, { gesture: "type" });
              for (let n = 1; n <= step.text.length; n += 1) {
                if (abortRef.current[session.id]) return;
                const slice = step.text.slice(0, n);
                setValues((all) => ({
                  ...all,
                  [tabId]: { ...all[tabId], [step.ref]: slice },
                }));
                await sleep(45);
              }
              patchCursor(tabId, { gesture: null });
              await sleep(240);
              break;
            }
            case "select": {
              setValues((all) => ({
                ...all,
                [tabId]: { ...all[tabId], [step.ref]: step.value },
              }));
              await sleep(300);
              break;
            }
            case "scroll": {
              patchCursor(tabId, { gesture: "scroll" });
              if (activeRef.current === tabId) {
                scrollerRef.current?.scrollBy({
                  top: step.direction === "down" ? 320 : -320,
                  behavior: reducedMotion ? "auto" : "smooth",
                });
              }
              await sleep(360);
              patchCursor(tabId, { gesture: null });
              break;
            }
          }
          await sleep(220);
        }
      } finally {
        setRunning((all) => ({ ...all, [session.id]: false }));
      }
    },
    [acquire, boxCentre, log, moveTo, patchCursor, reducedMotion, releaseHold],
  );

  const endTurn = (session: LabSession) => {
    abortRef.current[session.id] = true;
    const tabId = SCRIPT_TAB[session.id];
    if (tabId === undefined) return;
    const holder = holdersRef.current[tabId];
    if (holder?.kind === "session" && holder.sessionId === session.id) {
      log(session.id, "Turn ended. Hold released with it.");
      releaseHold(tabId, "turn-end");
    }
  };

  const takeOver = (tabId: string) => {
    const holder = holdersRef.current[tabId];
    if (holder?.kind !== "session") return;
    log(
      holder.sessionId,
      `The person took Browser Tab ${tabId}. Your writes there refuse (browser.person-has-tab) until they hand it back.`,
    );
    releaseHold(tabId, "handoff");
  };

  const askToLeave = (tabId: string) => {
    const holder = holdersRef.current[tabId];
    if (holder?.kind !== "session") return;
    log(holder.sessionId, `The person asks you to release Browser Tab ${tabId} when it is safe.`);
    setAskedToLeave((all) => ({ ...all, [tabId]: true }));
  };

  const handBack = (tabId: string) => {
    setHolders((all) => ({ ...all, [tabId]: null }));
    patchCursor(tabId, { handoff: false });
  };

  const contend = () => {
    // Session 3 has no tab of its own and tries the checkout tab: one write,
    // a short look around, and it lets go — sooner if asked.
    const intruder = SESSIONS[2]!;
    if (!acquire(intruder.id, "tab-checkout")) return;
    log(intruder.id, "Took the free checkout tab on my first write.");
    void (async () => {
      const first = boxCentre("email");
      if (first !== null) await moveTo("tab-checkout", first);
      for (let tick = 0; tick < 12; tick += 1) {
        await sleep(250);
        const holder = holdersRef.current["tab-checkout"];
        if (holder?.kind !== "session" || holder.sessionId !== intruder.id) return;
        if (askedRef.current["tab-checkout"]) {
          log(intruder.id, "Person asked me to leave; releasing (browser_release).");
          break;
        }
      }
      const holder = holdersRef.current["tab-checkout"];
      if (holder?.kind === "session" && holder.sessionId === intruder.id) {
        log(intruder.id, "Done here — browser_release.");
        releaseHold("tab-checkout", "release");
      }
    })();
  };

  const activeTab = TABS.find((tab) => tab.id === activeTabId)!;
  const activeHolder = holders[activeTabId] ?? null;
  const cursor = cursors[activeTabId] ?? CURSOR_AT_REST;
  const holderOf = (holder: Holder): BrowserHolder | null => {
    if (holder === null) return null;
    if (holder.kind === "person") return { kind: "person" };
    const session = SESSIONS.find((one) => one.id === holder.sessionId);
    return {
      kind: "session",
      sessionId: holder.sessionId,
      name: session?.name ?? holder.sessionId,
      color: COLORS.get(holder.sessionId) ?? "#888888",
    };
  };
  const activeHolderView = holderOf(activeHolder);
  const cursorSession =
    activeHolder?.kind === "session"
      ? SESSIONS.find((one) => one.id === activeHolder.sessionId)
      : undefined;
  // The cursor outlives the hold for the length of its exit, so the LAST
  // Session colour is what the fade wears. Keep it once the holder is gone.
  const lastSessionRef = React.useRef<LabSession | undefined>(undefined);
  if (cursorSession !== undefined) lastSessionRef.current = cursorSession;
  const drawnSession = cursorSession ?? lastSessionRef.current;

  return (
    <div className="flex flex-col gap-4">
      {/* Lab controls — not app chrome. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
        {SESSIONS.filter((session) => SCRIPT_TAB[session.id] !== undefined).map((session) => (
          <div key={session.id} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: COLORS.get(session.id) }}
            />
            <span className="text-ui text-foreground">{session.name}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={running[session.id] === true}
              onClick={() => void runScript(session)}
            >
              Run turn
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={running[session.id] !== true}
              onClick={() => endTurn(session)}
            >
              End turn
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={{ backgroundColor: COLORS.get(SESSIONS[2]!.id) }}
          />
          <span className="text-ui text-foreground">{SESSIONS[2]!.name}</span>
          <Button size="xs" variant="outline" onClick={contend}>
            Write to checkout tab
          </Button>
        </div>
        <span className="mx-1 h-4 w-px bg-border" />
        <Segmented
          ariaLabel="Page appearance"
          value={darkPage ? "dark" : "light"}
          options={[
            { key: "light", label: "Light page" },
            { key: "dark", label: "Dark page" },
          ]}
          onChange={(key) => setDarkPage(key === "dark")}
        />
        <label className="flex items-center gap-2 text-ui text-muted-foreground">
          <Switch checked={reducedMotion} onCheckedChange={setReducedMotion} />
          Reduced motion
        </label>
        {/* VC-251: the page is a native view above the app, so a menu or dialog
            opening over it detaches the plane and paints a frozen frame. The
            cursor view must detach with the plane and come back with it. */}
        <label className="flex items-center gap-2 text-ui text-muted-foreground">
          <Switch checked={overlayOpen} onCheckedChange={setOverlayOpen} />
          Menu over the plane
        </label>
      </div>

      {/* The surface: a ticket strip, the browser chrome, the plane. */}
      <div className="flex h-[560px] flex-col overflow-hidden rounded-lg border border-border bg-background">
        <TabStrip label="Ticket tabs" className="shrink-0">
          <Tab
            label="Body"
            active={false}
            tabStop={false}
            closable={false}
            onActivate={() => undefined}
          />
          <Tab
            label="Fix checkout form"
            active={false}
            tabStop={false}
            status="working"
            onActivate={() => undefined}
          />
          {TABS.map((tab) => {
            const holder = holderOf(holders[tab.id] ?? null);
            return (
              <Tab
                key={tab.id}
                label={tab.label}
                active={tab.id === activeTabId}
                tabStop={tab.id === activeTabId}
                leading={
                  <BrowserIcon
                    aria-hidden
                    weight="bold"
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                }
                badge={<BrowserHolderDot holder={holder} />}
                onActivate={() => setActiveTabId(tab.id)}
                onClose={() => undefined}
              />
            );
          })}
        </TabStrip>
        <BrowserChrome
          tab={tabState(activeTab)}
          address={activeTab.url}
          error={null}
          holder={activeHolderView}
          onAddressChange={() => undefined}
          onNavigate={() => undefined}
          onBack={() => undefined}
          onForward={() => undefined}
          onReload={() => undefined}
          onToggleDevTools={() => undefined}
          onTakeOver={() => takeOver(activeTabId)}
          onAskToLeave={() => askToLeave(activeTabId)}
          onHandBack={() => handBack(activeTabId)}
        />
        <div ref={planeRef} className="relative min-h-0 flex-1 overflow-hidden">
          <div ref={scrollerRef} className="h-full overflow-auto">
            <FixturePage
              dark={darkPage}
              values={values[activeTabId] ?? {}}
              pressed={pressed[activeTabId] ?? null}
              hovered={hovered[activeTabId] ?? null}
            />
          </div>
          {/* The frozen layer an app overlay puts over the plane (VC-251):
              the page's pixels, still, and no cursor on them. */}
          {overlayOpen ? (
            <div className="absolute inset-0 bg-scrim">
              <div className="absolute top-6 left-1/2 w-56 -translate-x-1/2 rounded-lg border border-border bg-popover p-2 shadow-overlay">
                <p className="px-2 py-1 text-ui text-foreground">A menu</p>
                <p className="px-2 py-1 text-ui text-muted-foreground">over the plane</p>
              </div>
            </div>
          ) : drawnSession !== undefined ? (
            <SessionCursor
              key={activeTabId}
              color={COLORS.get(drawnSession.id) ?? "#888888"}
              name={drawnSession.name}
              x={cursor.x}
              y={cursor.y}
              present={cursor.present && cursorSession !== undefined}
              gesture={cursor.gesture}
              pressKey={cursor.pressKey}
              labelPinned={cursor.labelPinned}
              handoff={cursor.handoff}
              reducedMotion={reducedMotion}
              onSettled={() => settleRef.current[activeTabId]?.()}
              onTakeOver={() => takeOver(activeTabId)}
              onAskToLeave={() => askToLeave(activeTabId)}
            />
          ) : null}
        </div>
      </div>

      {/* What each Session hears, and what was refused. Lab-only, in place of the ledger. */}
      <div className="grid grid-cols-2 gap-4">
        <section className="flex flex-col gap-1">
          <h3 className="font-mono text-label uppercase text-muted-foreground">
            In-band lines to Sessions
          </h3>
          <ol className="flex flex-col gap-1 rounded-lg border border-border p-2 font-mono text-label">
            {inbox.length === 0 ? <li className="text-muted-foreground">—</li> : null}
            {inbox.map((entry) => (
              <li key={entry.seq} className="flex gap-2">
                <span
                  aria-hidden
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: COLORS.get(entry.session) }}
                />
                <span className={cn("text-foreground")}>{entry.line}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="font-mono text-label uppercase text-muted-foreground">Refusals</h3>
          <ol className="flex flex-col gap-1 rounded-lg border border-border p-2 font-mono text-label">
            {refusals.length === 0 ? <li className="text-muted-foreground">—</li> : null}
            {refusals.map((entry) => (
              <li key={entry.seq} className="text-destructive">
                {entry.line}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
