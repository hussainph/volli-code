/**
 * The page the Session cursor drives in the film: a fixture checkout form,
 * the same stand-in the lab's `session-cursor` scratch uses for a live Browser
 * Tab (the brief allows the fixture page, never live page pixels). Its own
 * type and palette on purpose — a web page does not share the app's tokens.
 *
 * Every control sits at a fixed position so the cursor's targets are known
 * numbers, not measurements of a transformed DOM. Addresses use the reserved
 * `.example` TLD so nothing in frame points at a real site or inbox.
 */
import type * as React from "react";

export const PAGE_WIDTH = 1280;
export const PAGE_HEIGHT = 760;

/** Cursor targets, in the page's own pixels. */
export const TARGETS = {
  name: { x: 196, y: 214 },
  email: { x: 160, y: 294 },
  plan: { x: 300, y: 374 },
  cont: { x: 150, y: 470 },
} as const;

const INK = "#1b1b1f";
const MUTED = "#6b6b76";
const BORDER = "#d8d8de";
const FOCUS = "#3b3bff";

function Field({
  top,
  label,
  value,
  placeholder,
  focused,
  pressed,
  caret,
}: {
  top: number;
  label: string;
  value: string;
  placeholder: string;
  focused?: boolean;
  pressed?: boolean;
  caret?: boolean;
}) {
  return (
    <div style={{ position: "absolute", left: 48, top, width: 440 }}>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 7 }}>{label}</div>
      <div
        style={{
          height: 42,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          borderRadius: 9,
          border: `1px solid ${focused ? FOCUS : BORDER}`,
          boxShadow: focused ? `0 0 0 3px ${FOCUS}22` : "none",
          outline: pressed ? `2px solid ${FOCUS}` : "none",
          outlineOffset: 1,
          background: "#ffffff",
          color: value ? INK : "#a3a3ad",
          fontSize: 15,
        }}
      >
        {value || placeholder}
        {caret ? (
          <span
            style={{ display: "inline-block", width: 1.5, height: 18, marginLeft: 1, background: INK }}
          />
        ) : null}
      </div>
    </div>
  );
}

export interface CheckoutState {
  name: string;
  nameFocused: boolean;
  plan: "solo" | "team";
  planPressed: boolean;
  hoverContinue: boolean;
  pressContinue: boolean;
  /** 0 → 1: the step-3 confirmation replacing the form's footer. */
  saved: number;
}

export function CheckoutPage({ state }: { state: CheckoutState }) {
  const box: React.CSSProperties = {
    position: "relative",
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    overflow: "hidden",
    background: "#f6f6f8",
    color: INK,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  };
  return (
    <div style={box}>
      <div
        style={{
          position: "absolute",
          left: 48,
          right: 48,
          top: 26,
          height: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${BORDER}`,
          paddingBottom: 14,
        }}
      >
        <span style={{ fontWeight: 700, letterSpacing: "-0.02em", fontSize: 20 }}>voltaic</span>
        <span style={{ color: MUTED, fontSize: 13 }}>
          Checkout · Step {state.saved > 0.5 ? 3 : 2} of 3
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 48,
          top: 96,
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: "-0.02em",
        }}
      >
        Your details
      </div>
      <div style={{ position: "absolute", left: 48, top: 138, fontSize: 14, color: MUTED }}>
        We&apos;ll send the receipt and the workspace invite here.
      </div>
      <Field
        top={172}
        label="Full name"
        value={state.name}
        placeholder="Your name"
        focused={state.nameFocused}
        caret={state.nameFocused}
      />
      <Field top={252} label="Email" value="" placeholder="you@company.example" />
      <Field
        top={332}
        label="Plan"
        value={state.plan === "team" ? "Team — $48 / month" : "Solo — $12 / month"}
        placeholder=""
        pressed={state.planPressed}
      />
      <div style={{ position: "absolute", left: 48, top: 448, display: "flex", gap: 12 }}>
        <div
          style={{
            height: 44,
            width: 204,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 999,
            background: "#111114",
            color: "#ffffff",
            fontSize: 15,
            fontWeight: 600,
            transform: state.pressContinue ? "scale(0.96)" : "none",
            boxShadow: state.hoverContinue ? `0 0 0 4px ${FOCUS}40` : "none",
          }}
        >
          Continue to payment
        </div>
        <div
          style={{
            height: 44,
            padding: "0 18px",
            display: "flex",
            alignItems: "center",
            borderRadius: 999,
            border: `1px solid ${BORDER}`,
            fontSize: 15,
          }}
        >
          Back
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 48,
          top: 520,
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 15,
          fontWeight: 600,
          color: "#127a3a",
          opacity: state.saved,
          transform: `translateY(${(1 - state.saved) * 8}px)`,
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 999,
            background: "#16a34a",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 13,
          }}
        >
          ✓
        </span>
        Details saved — on to payment
      </div>
      {/* Order summary: context on the far side of the page. */}
      <div
        style={{
          position: "absolute",
          left: 700,
          top: 96,
          width: 500,
          height: 470,
          borderRadius: 16,
          background: "#ffffff",
          border: `1px solid ${BORDER}`,
          padding: "26px 28px",
        }}
      >
        <div style={{ fontSize: 13, color: MUTED }}>Order summary</div>
        <div style={{ marginTop: 10, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {state.plan === "team" ? "Team plan" : "Solo plan"}
        </div>
        <div style={{ marginTop: 4, fontSize: 15, color: MUTED }}>
          {state.plan === "team" ? "$48 / month · 5 seats" : "$12 / month · 1 seat"}
        </div>
        <div style={{ marginTop: 22, display: "grid", gap: 10 }}>
          {[
            "Unlimited boards and tickets",
            "Isolated worktrees per ticket",
            "Structured agent Sessions",
            "Browser Tabs your Sessions can drive",
            "Local-first storage",
          ].map((line) => (
            <div
              key={line}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 9,
                border: `1px solid ${BORDER}`,
                fontSize: 14,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 999, background: FOCUS }} />
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
