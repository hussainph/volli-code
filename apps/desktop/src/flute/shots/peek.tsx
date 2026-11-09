/**
 * Chapter shot: context switching — hover peek, then the conversation overlay.
 *
 * Real: the whole `AppShell` (paper theme), the real `SessionPeekCard` anchored
 * to the real sidebar rows (`[data-peek-row]`, measured from the DOM each
 * frame), and the real `SessionPeekDialog` — the shared overlay chrome that
 * `PeekConversation` mounts. Which card is open, what is typed and when the
 * overlay opens/closes are all functions of scene time `t`; no pointer events,
 * no timers, no peek machine clocks.
 *
 * Simulated wiring: a seeded real ChatPlane supplies the overlay transcript
 * and composer. Its draft and accepted reply follow scene time; no runtime,
 * provider request or real send is performed. The pointer is a film prop.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";
import {
  PERSON_STARTED,
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_MODEL_PICKER_VIEW,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type SessionPeekContent,
  type SessionPeekEntry,
} from "@volli/shared";
import { seedSlice } from "@volli/session-presentation";
import type { UIMessage } from "ai";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

import { SessionPeekDialog } from "@renderer/components/chat/session-peek-dialog";
import { SessionPeekCard } from "@renderer/components/session-peek/session-peek-card";
import type { SessionPeekRow } from "@renderer/components/session-peek/use-session-peek";

import { ease, progress, track, typed } from "../kit/clock";
import {
  FrameLayer,
  Supers,
  useFilm,
  useFilmWallClock,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { NOW as LAB_NOW } from "../../renderer/lab/fixtures";
import { project, seedShell, sessionRows, shellApi, ShellWindow } from "../kit/split-shell";
import { Backdrop, useFilmTheme } from "../kit/world";

/** The window, in lab CSS px. Mirrored by scripts/film/shots/peek.mjs. */
export const WINDOW = { width: 1600, height: 960 };
/** How far above the window the overlay layer floats. */
export const LIFT = 80;

export const T = {
  peekA: [250, 1000] as const,
  peekB: [1050, 2150] as const,
  overlay: [2100, 4400] as const,
  typeFrom: 2600,
  perChar: 24,
  send: 3700,
};

const REPLY = "Yes, keep the cart and add a regression test.";
const NOW = LAB_NOW;
const MIN = 60_000;
const noop = () => undefined;
const API = shellApi({
  sessions: {
    list: () =>
      Promise.resolve({
        ok: true,
        // oxlint-disable-next-line no-map-spread -- keep shared fixtures immutable
        sessions: sessionRows.map((row) => {
          if (row.kind !== "chat") return row;
          const peek = PEEKS.find((item) => item.sessionId === row.record.sessionId);
          return peek ? { ...row, record: { ...row.record, title: peek.title } } : row;
        }),
      }),
  },
});
const chatStore = createChatSessionsStore();
const MODEL = {
  providerId: "anthropic",
  modelId: "claude-sonnet-4-5",
  reasoningLevel: "high",
} as const;

const MODEL_ACCESS: ModelAccessClient = {
  inspect: async () => ({
    observedAt: NOW,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        state: "available",
        accountLabel: null,
        billingSource: "subscription",
        recovery: null,
        hasStoredCredential: true,
        signIn: [],
      },
    ],
    models: [
      {
        ...MODEL,
        label: "Claude Sonnet 4.5",
        state: "available",
        acceptsImageInput: true,
        reasoningLevels: ["low", "medium", "high"],
        contextWindow: 200000,
      },
    ],
  }),
  defaults: async () => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, global: MODEL }),
  setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
  hiddenModels: async () => [],
  setHiddenModels: async (value) => value,
  compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
  setCompactionPolicy: async (value) => value,
  codeModePolicy: async () => DEFAULT_CODE_MODE_POLICY,
  setCodeModePolicy: async (value) => value,
  pickerView: async () => DEFAULT_MODEL_PICKER_VIEW,
  setPickerView: async (value) => value,
  beginSignIn: async () => {
    throw new Error("Film fixture has no sign-in");
  },
  signOut: async () => {
    throw new Error("Film fixture has no sign-out");
  },
};

const entry = (role: SessionPeekEntry["role"], text: string, ago: number): SessionPeekEntry => ({
  at: NOW - ago * MIN,
  role,
  text,
  tools: [],
});

interface Peek {
  sessionId: string;
  title: string;
  entries: SessionPeekEntry[];
}

/** Two Active-band chat rows from the lab fixtures, by session id. */
const PEEKS: Peek[] = [
  {
    sessionId: "chat-14a",
    title: "Fix checkout validation",
    entries: [
      entry("user", "Checkout rejects valid delivery addresses. Find the cause.", 9),
      entry(
        "assistant",
        "The postcode check was too strict. Valid delivery addresses now pass, with a regression test.",
        3,
      ),
    ],
  },
  {
    sessionId: "chat-11a",
    title: "Keep the cart after sign in",
    entries: [
      entry("user", "Customers lose their cart when they sign in. Keep their items.", 12),
      entry(
        "assistant",
        "The saved cart now merges with the guest cart. Should we keep guest quantities when an item appears in both?",
        1,
      ),
    ],
  },
];

function rowOf(peek: Peek, index: number): SessionPeekRow {
  return {
    rowId: `chat:${peek.sessionId}`,
    sessionId: peek.sessionId,
    title: peek.title,
    ticket: null,
    kind: "chat",
    state: "waiting",
    providerId: "anthropic",
    providerLabel: "Claude",
    at: peek.entries.at(-1)!.at,
    unread: index === 1,
    model: null,
    provenance: PERSON_STARTED,
  };
}

function contentOf(peek: Peek): SessionPeekContent {
  return {
    sessionId: peek.sessionId,
    entries: peek.entries,
    question: null,
    turns: peek.entries.length,
    turnDepth: 1,
    unreadable: 0,
    lastActivityAt: peek.entries.at(-1)!.at,
  };
}

/** Which peek card is open at `t`, and how far in (0..1 opacity). */
function openPeek(t: number): { index: number; alpha: number } | null {
  for (const [index, [from, to]] of [T.peekA, T.peekB].entries()) {
    if (t >= from && t < to) {
      const alpha = Math.min(
        progress(t, from, from + 80, ease.outCubic),
        1 - progress(t, to - 100, to),
      );
      return { index, alpha };
    }
  }
  return null;
}

/** Rows the peek anchors to, by their `[data-peek-row]` key. */
const ROW_KEYS = PEEKS.map((peek) => `chat:${peek.sessionId}`);

interface RowBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A row's box relative to `host`, from offsets (unaffected by the 3D camera). */
function boxWithin(node: HTMLElement, host: HTMLElement): RowBox {
  let left = 0;
  let top = 0;
  let el: HTMLElement | null = node;
  while (el !== null && el !== host) {
    left += el.offsetLeft;
    top += el.offsetTop;
    el = el.offsetParent as HTMLElement | null;
  }
  for (let s = node.parentElement; s !== null && s !== host; s = s.parentElement) {
    left -= s.scrollLeft;
    top -= s.scrollTop;
  }
  return { left, top, width: node.offsetWidth, height: node.offsetHeight };
}

/** The pointer prop: a macOS arrow. */
function Pointer({ x, y, press }: { x: number; y: number; press: number }) {
  return (
    <svg
      width={26}
      height={38}
      viewBox="0 0 13 19"
      style={{
        position: "absolute",
        left: x,
        top: y,
        zIndex: 200,
        transform: `scale(${1.6 - press * 0.15})`,
        transformOrigin: "0 0",
        filter: "drop-shadow(0 2px 3px rgb(0 0 0 / 0.35))",
        pointerEvents: "none",
      }}
    >
      <path
        d="M1 1 L1 15.5 L4.6 12.2 L7 18 L9.4 17 L7 11.3 L12 11.3 Z"
        fill="#000"
        stroke="#fff"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PeekLayer({ t }: { t: number }) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = React.useState<RowBox[]>([]);
  // Measures the real rows after every commit (layout follows scene time);
  // setRows only fires when a box actually moved, so it settles.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    const el = host.current?.parentElement;
    if (!el) return;
    const next = ROW_KEYS.map((key) =>
      el.querySelector<HTMLElement>(`[data-peek-row="${key}"]`),
    ).filter((n): n is HTMLElement => n !== null);
    const boxes = next.map((n) => boxWithin(n, el));
    const same =
      boxes.length === rows.length &&
      boxes.every((b, i) => b.top === rows[i]!.top && b.left === rows[i]!.left);
    if (!same) setRows(boxes);
  });

  const open = openPeek(t);
  const a = rows[0] ?? { left: 12, top: 320, width: 240, height: 30 };
  const b = rows[1] ?? { left: 12, top: 390, width: 240, height: 30 };
  // Pointer path: down the list, onto row A, then row B, then rests.
  const px = track(
    t,
    [
      [0, a.left + a.width * 0.35],
      [250, a.left + a.width * 0.55],
      [1050, b.left + b.width * 0.6],
      [2000, b.left + b.width * 0.62],
    ],
    ease.inOutCubic,
  );
  const py = track(
    t,
    [
      [0, a.top - 110],
      [250, a.top + a.height * 0.5],
      [950, a.top + a.height * 0.55],
      [1050, b.top + b.height * 0.5],
      [2000, b.top + b.height * 0.5],
    ],
    ease.inOutCubic,
  );
  const press = progress(t, 2000, 2060) - progress(t, 2080, 2140);
  const showPointer = t < T.overlay[0] + 60 || t >= T.overlay[1] + 150;

  let card: React.ReactNode = null;
  if (open !== null) {
    const box = open.index === 0 ? a : b;
    // Clamp the card inside the window (card ≈ 300px tall at most here).
    const cardTop = Math.max(16, Math.min(box.top - 12, WINDOW.height - 360));
    const peek = PEEKS[open.index]!;
    card = (
      <div style={{ opacity: open.alpha, transform: `translateX(${(1 - open.alpha) * -8}px)` }}>
        <SessionPeekCard
          row={rowOf(peek, open.index)}
          ticketPrefix="VLT"
          now={NOW}
          content={contentOf(peek)}
          loading={false}
          failed={false}
          position={{
            left: Math.min(box.left + box.width + 10, WINDOW.width - 456),
            top: cardTop,
            maxHeight: WINDOW.height - cardTop - 16,
          }}
          cardWidth={440}
          pinned={false}
          canReply
          onPin={noop}
          onClose={noop}
          onOpen={noop}
          onViewConversation={noop}
          onAnswer={() => Promise.resolve(true)}
          onSend={() => Promise.resolve(true)}
        />
      </div>
    );
  }

  return (
    <div ref={host} style={{ position: "absolute", inset: 0, zIndex: 100, pointerEvents: "none" }}>
      {card}
      {showPointer ? <Pointer x={px} y={py} press={Math.max(0, press)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------ the overlay */

const PORTAL_ROOTS = '[data-slot="dialog-overlay"], [data-slot="dialog-content"]';

function useRehomePortals(host: React.RefObject<HTMLDivElement | null>): void {
  React.useLayoutEffect(() => {
    const target = host.current;
    if (target === null) return;
    const adopt = () => {
      for (const node of document.querySelectorAll<HTMLElement>(
        `#volli-overlays > [data-slot="dialog-overlay"], #volli-overlays > [data-slot="dialog-content"]`,
      )) {
        // Radix positions both roots `fixed` to the viewport; inside the
        // lifted layer they must resolve against the 1600×960 host instead.
        node.style.position = "absolute";
        target.append(node);
      }
    };
    adopt();
    const observer = new MutationObserver(adopt);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const node of target.querySelectorAll<HTMLElement>(`:scope > ${PORTAL_ROOTS}`)) {
        (document.getElementById("volli-overlays") ?? document.body).append(node);
      }
    };
  }, [host]);
}

/** The same resident presentation shape the current lab ChatPlane scratch seeds. */
function seedConversation(t: number): void {
  const peek = PEEKS[1]!;
  const slice = seedSlice("ready");
  const messages: UIMessage[] = peek.entries.map((turn, index) => ({
    id: `peek-message-${index}`,
    role: turn.role === "user" ? "user" : "assistant",
    parts: [{ type: "text", text: turn.text }],
  }));
  if (t >= T.send)
    messages.push({ id: "peek-reply", role: "user", parts: [{ type: "text", text: REPLY }] });
  chatStore.setState({
    sessions: {
      [peek.sessionId]: {
        ...slice,
        projection: {
          session: {
            id: peek.sessionId,
            projectId: project.id,
            ticketId: "tkt-11",
            title: peek.title,
            role: "ticket",
            parentSessionId: null,
            createdAt: NOW - 600000,
          },
          status: "open",
          signal: null,
          modelSelection: MODEL,
          modelTier: null,
          turnActive: false,
          lastActivityAt: NOW,
          bornTicketless: false,
          scheduledResume: null,
          attention: { active: [], primary: null },
          interactions: { active: [], resolved: [] },
          liveExecutor: { id: "film-peek-executor" },
        },
        transcript: { ...slice.transcript, messages, durableMessages: messages, turnEpoch: 2 },
      },
    },
  });
  const text = t >= T.send ? "" : typed(REPLY, t, T.typeFrom, T.perChar);
  if (useChatDraftsStore.getState().drafts[peek.sessionId]?.text !== text)
    useChatDraftsStore.getState().setDraft(peek.sessionId, text);
}

function Overlay({ t }: { t: number }) {
  const host = React.useRef<HTMLDivElement | null>(null);
  useRehomePortals(host);
  React.useLayoutEffect(() => {
    for (let node = host.current?.parentElement; node; node = node.parentElement) {
      if (node.scrollLeft !== 0) node.scrollLeft = 0;
      if (node.scrollTop !== 0) node.scrollTop = 0;
    }
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  });
  const [from, to] = T.overlay;
  const inP = progress(t, from, from + 220, ease.outCubic);
  const outP = progress(t, to - 250, to, ease.inCubic);
  const alpha = inP * (1 - outP);
  const scale = 0.94 + 0.06 * inP - 0.04 * outP;

  const peek = PEEKS[1]!;

  return (
    <div
      ref={host}
      style={{ position: "relative", width: WINDOW.width, height: WINDOW.height, opacity: alpha }}
    >
      <SessionPeekDialog
        open
        title={peek.title}
        state="Waiting for you"
        onOpen={noop}
        onClose={noop}
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          // The chrome already centres itself with `-translate-1/2`.
          transform: `scale(${scale})`,
          width: 900,
          maxWidth: 900,
          height: 520,
        }}
      >
        <ChatPlane
          sessionId={peek.sessionId}
          projectId={project.id}
          ticketId="tkt-11"
          constrainComposer
          onOpenFile={noop}
          store={chatStore}
        />
      </SessionPeekDialog>
    </div>
  );
}

/* ------------------------------------------------------------ the shot */

const CUES: Record<Format, Cue[]> = {
  landscape: [
    {
      at: 150,
      until: 2300,
      eyebrow: "Context switching",
      lines: ["Hover to peek."],
      sub: "Any session, right from the sidebar.",
      place: "lower-right",
      size: "medium",
    },
    {
      at: 2500,
      until: 4800,
      lines: ["Reply without", "losing your place."],
      weights: [800, 320],
      place: "lower-right",
      size: "medium",
    },
  ],
  portrait: [
    {
      at: 150,
      until: 2300,
      eyebrow: "Context switching",
      lines: ["Hover to peek."],
      sub: "Any session, right from the sidebar.",
      place: "upper",
    },
    {
      at: 2500,
      until: 4800,
      lines: ["Reply without", "losing your place."],
      weights: [800, 320],
      place: "upper",
    },
  ],
};

export function PeekShot({ format }: { format: Format }) {
  const t = useFilm();
  // The sidebar's fixture rows are stamped against the lab's clock.
  useFilmWallClock(t, LAB_NOW);
  useFilmTheme("paper");
  useFixtures({
    api: API,
    seed: () => {
      seedShell();
      seedConversation(0);
    },
  });
  React.useLayoutEffect(() => {
    seedConversation(t);
  }, [t]);
  const overlayOn = t >= T.overlay[0] && t < T.overlay[1];

  return (
    <ModelAccessProvider client={MODEL_ACCESS}>
      <Surface
        id="window"
        style={{
          position: "absolute",
          left: `calc(50% - ${WINDOW.width / 2}px)`,
          top: `calc(50% - ${WINDOW.height / 2}px)`,
          width: WINDOW.width,
          height: WINDOW.height,
        }}
        content={
          <ShellWindow width={WINDOW.width} height={WINDOW.height}>
            <PeekLayer t={t} />
          </ShellWindow>
        }
      >
        <Surface
          id="overlay"
          transform={{ z: LIFT }}
          style={{
            position: "absolute",
            left: 0,
            top: -WINDOW.height,
            width: WINDOW.width,
            height: WINDOW.height,
          }}
          content={overlayOn ? <Overlay t={t} /> : <div className="size-full" />}
        />
      </Surface>
      <Backdrop t={t} theme="paper" focus={[0.3, 0.45]} />
      <FrameLayer format={format}>
        <Vignette strength={0.3} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </ModelAccessProvider>
  );
}
