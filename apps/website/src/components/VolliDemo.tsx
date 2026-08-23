import { gsap } from "gsap";
import { Flip } from "gsap/Flip";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import "./VolliDemo.css";

if (typeof window !== "undefined") gsap.registerPlugin(Flip);

type Phase = "backlog" | "todo" | "doing" | "review" | "done";

interface DemoTicket {
  id: string;
  code: string;
  title: string;
  phase: Phase;
  priority: 1 | 2 | 3;
  /** How many chats this ticket has, when it has any. */
  chats?: number;
  /** What someone actually typed to open the ticket's chat. */
  prompt?: string;
}

interface DragSession {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  element: HTMLButtonElement;
}

const PHASES: ReadonlyArray<{ key: Phase; label: string; mobileLabel: string }> = [
  { key: "backlog", label: "Backlog", mobileLabel: "Backlog" },
  { key: "todo", label: "Todo", mobileLabel: "Todo" },
  { key: "doing", label: "Doing", mobileLabel: "Doing" },
  { key: "review", label: "Needs Review", mobileLabel: "Review" },
  { key: "done", label: "Done", mobileLabel: "Done" },
];

/**
 * An ordinary app team's board, not Volli's own issue history (VC-64). The
 * demo used to carry real internal ticket numbers, which read as a changelog
 * to anyone who recognised them and as noise to everyone else.
 */
const INITIAL_TICKETS: DemoTicket[] = [
  {
    id: "passkey-signin",
    code: "HB-41",
    title: "Add passkey sign-in",
    phase: "backlog",
    priority: 2,
  },
  {
    id: "api-rate-limits",
    code: "HB-38",
    title: "Rate-limit the public API",
    phase: "backlog",
    priority: 1,
  },
  {
    id: "inbox-empty-states",
    code: "HB-36",
    title: "Design the inbox empty states",
    phase: "todo",
    priority: 3,
  },
  {
    id: "flaky-upload-test",
    code: "HB-35",
    title: "Fix the flaky upload test",
    phase: "todo",
    priority: 2,
  },
  {
    id: "billing-webhooks",
    code: "HB-32",
    title: "Move billing to webhooks",
    phase: "doing",
    priority: 3,
    chats: 2,
    prompt: "Move billing off the nightly job and onto Stripe webhooks.",
  },
  {
    id: "search-recency",
    code: "HB-30",
    title: "Rank search results by recency",
    phase: "doing",
    priority: 2,
    chats: 1,
    prompt: "Weight search results by recency without hurting exact-title matches.",
  },
  {
    id: "admin-audit-log",
    code: "HB-27",
    title: "Audit log for admin actions",
    phase: "review",
    priority: 2,
    chats: 2,
    prompt: "Record every admin action with actor, target, and timestamp.",
  },
  {
    id: "settings-dark-mode",
    code: "HB-24",
    title: "Dark mode for Settings",
    phase: "done",
    priority: 1,
    chats: 1,
    prompt: "Make the Settings screens follow the system appearance.",
  },
];

const useMediaQuery = (query: string) => {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
};

/** A ticket carries chats once it has reached work; before that it has none. */
const chatCount = (ticket: DemoTicket): number => ticket.chats ?? 1;

const branchName = (ticket: DemoTicket) => `volli/${ticket.code.toLowerCase()}-${ticket.id}`;

const phaseLabel = (phase: Phase) => PHASES.find((item) => item.key === phase)?.label ?? phase;

export default function VolliDemo() {
  const [tickets, setTickets] = useState<DemoTicket[]>(() => [...INITIAL_TICKETS]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropPhase, setDropPhase] = useState<Phase | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const compact = useMediaQuery("(max-width: 720px)");
  const precisePointer = useMediaQuery("(hover: hover) and (pointer: fine)");

  const appRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const previewContentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const sourceCenterRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const dropPhaseRef = useRef<Phase | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const animateOpenRef = useRef(true);
  const closingRef = useRef(false);

  const selected = useMemo(
    () => tickets.find((ticket) => ticket.id === selectedId) ?? null,
    [selectedId, tickets],
  );

  const setCurrentDropPhase = (phase: Phase | null) => {
    dropPhaseRef.current = phase;
    setDropPhase(phase);
  };

  const openPreview = useCallback(
    (ticketId: string, trigger: HTMLButtonElement, animate: boolean) => {
      triggerRef.current = trigger;
      const app = appRef.current;
      if (app) {
        const appRect = app.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        sourceCenterRef.current = {
          x: triggerRect.left + triggerRect.width / 2 - appRect.left,
          y: triggerRect.top + triggerRect.height / 2 - appRect.top,
        };
      }
      animateOpenRef.current = animate;
      closingRef.current = false;
      setSelectedId(ticketId);
    },
    [],
  );

  const finishClose = useCallback(() => {
    setSelectedId(null);
    closingRef.current = false;
    sourceCenterRef.current = null;
    window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);

  const closePreview = useCallback(
    (animate: boolean) => {
      if (closingRef.current) return;
      const panel = previewRef.current;
      const overlay = overlayRef.current;
      if (!panel || !overlay || reducedMotion || !animate) {
        finishClose();
        return;
      }

      closingRef.current = true;
      gsap.killTweensOf([panel, overlay]);
      gsap.to(panel, {
        autoAlpha: 0,
        scale: compact ? 1 : 0.96,
        y: compact ? 14 : 0,
        filter: "blur(3px)",
        duration: 0.16,
        ease: "power2.in",
      });
      gsap.to(overlay, {
        backgroundColor: "rgba(5, 5, 5, 0)",
        duration: 0.18,
        ease: "power2.in",
        onComplete: finishClose,
      });
    },
    [compact, finishClose, reducedMotion],
  );

  useLayoutEffect(() => {
    if (!selectedId) return;
    const panel = previewRef.current;
    const overlay = overlayRef.current;
    if (!panel || !overlay) return;

    const source = sourceCenterRef.current;
    const appRect = appRef.current?.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (source && appRect) {
      panel.style.transformOrigin = `${source.x - (panelRect.left - appRect.left)}px ${
        source.y - (panelRect.top - appRect.top)
      }px`;
    } else {
      panel.style.transformOrigin = "50% 50%";
    }

    gsap.killTweensOf([panel, overlay]);
    if (reducedMotion || !animateOpenRef.current) {
      gsap.set(overlay, { backgroundColor: "rgba(5, 5, 5, 0.7)" });
      gsap.set(panel, { autoAlpha: 1, clearProps: "transform,filter" });
    } else {
      gsap.fromTo(
        overlay,
        { backgroundColor: "rgba(5, 5, 5, 0)" },
        { backgroundColor: "rgba(5, 5, 5, 0.7)", duration: 0.24, ease: "power2.out" },
      );
      gsap.fromTo(
        panel,
        {
          autoAlpha: 0,
          scale: compact ? 1 : 0.93,
          y: compact ? 20 : 0,
          filter: "blur(5px)",
        },
        {
          autoAlpha: 1,
          scale: 1,
          y: 0,
          filter: "blur(0px)",
          duration: compact ? 0.3 : 0.28,
          ease: "power3.out",
        },
      );
    }

    window.requestAnimationFrame(() => panel.focus({ preventScroll: true }));
  }, [compact, reducedMotion, selectedId]);

  useEffect(() => {
    if (!selected) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview(false);
        return;
      }

      if (event.key !== "Tab" || !previewRef.current) return;
      const focusable = Array.from(
        previewRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closePreview, selected]);

  const moveTicket = useCallback(
    (ticketId: string, nextPhase: Phase, announce = true) => {
      const ticket = tickets.find((candidate) => candidate.id === ticketId);
      if (!ticket || ticket.phase === nextPhase) return;
      setTickets((current) =>
        current.map((candidate) =>
          candidate.id === ticketId
            ? {
                ...candidate,
                phase: nextPhase,
                chats:
                  nextPhase === "doing" || nextPhase === "review" || nextPhase === "done"
                    ? chatCount(candidate)
                    : candidate.chats,
              }
            : candidate,
        ),
      );
      if (announce) {
        setAnnouncement(`${ticket.code} moved to ${phaseLabel(nextPhase)}.`);
      }
    },
    [tickets],
  );

  const switchSelectedPhase = (nextPhase: Phase) => {
    if (!selected || selected.phase === nextPhase) return;
    const content = previewContentRef.current;
    if (!content || reducedMotion) {
      moveTicket(selected.id, nextPhase);
      return;
    }

    gsap.killTweensOf(content);
    gsap.to(content, {
      autoAlpha: 0.28,
      filter: "blur(2px)",
      duration: 0.11,
      ease: "power2.out",
      onComplete: () => {
        flushSync(() => moveTicket(selected.id, nextPhase));
        gsap.fromTo(
          content,
          { autoAlpha: 0.25, filter: "blur(2px)" },
          { autoAlpha: 1, filter: "blur(0px)", duration: 0.18, ease: "power3.out" },
        );
      },
    });
  };

  const resetDraggedElement = (element: HTMLButtonElement, animate: boolean) => {
    element.style.pointerEvents = "";
    if (!animate || reducedMotion) {
      gsap.set(element, { clearProps: "transform,zIndex,willChange,pointerEvents" });
      return;
    }
    gsap.to(element, {
      x: 0,
      y: 0,
      scale: 1,
      duration: 0.22,
      ease: "power3.out",
      onComplete: () =>
        gsap.set(element, { clearProps: "transform,zIndex,willChange,pointerEvents" }),
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, ticket: DemoTicket) => {
    if (!event.isPrimary || event.button !== 0 || !precisePointer) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    dragRef.current = {
      id: ticket.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      element,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = event.clientX - drag.startX;
    const y = event.clientY - drag.startY;

    if (!drag.moved && Math.hypot(x, y) < 7) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.element.style.pointerEvents = "none";
      setDraggingId(drag.id);
    }

    event.preventDefault();
    gsap.set(drag.element, {
      x,
      y,
      scale: 1.018,
      zIndex: 40,
      willChange: "transform",
    });

    const target = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((element) => element instanceof HTMLElement && element.dataset.phase);
    const phase =
      target instanceof HTMLElement ? (target.dataset.phase as Phase | undefined) : null;
    setCurrentDropPhase(phase ?? null);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    if (drag.element.hasPointerCapture(event.pointerId)) {
      drag.element.releasePointerCapture(event.pointerId);
    }

    if (!drag.moved) return;
    suppressClickRef.current = drag.id;
    const currentTicket = tickets.find((ticket) => ticket.id === drag.id);
    const targetPhase = dropPhaseRef.current ?? currentTicket?.phase ?? null;
    const changed =
      currentTicket !== undefined && targetPhase !== null && targetPhase !== currentTicket.phase;

    if (!changed || !targetPhase) {
      resetDraggedElement(drag.element, true);
      setDraggingId(null);
      setCurrentDropPhase(null);
      return;
    }

    const cards = boardRef.current?.querySelectorAll<HTMLElement>("[data-demo-ticket]");
    const flipState = !reducedMotion && cards ? Flip.getState(cards) : null;
    drag.element.style.pointerEvents = "";
    flushSync(() => moveTicket(drag.id, targetPhase));
    gsap.set(drag.element, { clearProps: "transform,zIndex,willChange,pointerEvents" });
    setDraggingId(null);
    setCurrentDropPhase(null);

    if (flipState) {
      Flip.from(flipState, {
        duration: 0.38,
        ease: "power3.out",
        absoluteOnLeave: true,
        nested: true,
      });
    }

    window.setTimeout(
      () => {
        const movedCard = boardRef.current?.querySelector<HTMLButtonElement>(
          `[data-demo-ticket="${drag.id}"]`,
        );
        if (movedCard) openPreview(drag.id, movedCard, !reducedMotion);
      },
      reducedMotion ? 0 : 260,
    );
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    resetDraggedElement(drag.element, true);
    setDraggingId(null);
    setCurrentDropPhase(null);
  };

  const handleTicketClick = (event: ReactMouseEvent<HTMLButtonElement>, ticket: DemoTicket) => {
    if (suppressClickRef.current === ticket.id) {
      suppressClickRef.current = null;
      return;
    }
    openPreview(ticket.id, event.currentTarget, event.detail > 0 && !reducedMotion);
  };

  return (
    <div className="volli-demo" ref={appRef}>
      <div className="demo-sunset-mesh" aria-hidden="true" />
      <div className="demo-grain" aria-hidden="true" />

      <div className="demo-app-frame">
        <header className="demo-chrome">
          <div className="demo-window-controls" aria-hidden="true">
            <span />
            <span />
            <ChevronIcon direction="left" />
            <ChevronIcon direction="right" />
          </div>
          <div className="demo-search" aria-hidden="true">
            <SearchIcon />
            <span>Search tickets...</span>
          </div>
        </header>

        {/* The rails are scenery: they name the shape of the app but nothing in
            them is operable, so they stay out of the tab order and the a11y
            tree rather than offering keyboard users dead buttons (VC-64). */}
        <div className="demo-workspace">
          <aside className="demo-project-rail" aria-hidden="true">
            <DemoRailChip label="Harbor" className="is-selected is-ember">
              HB
            </DemoRailChip>
            <DemoRailChip label="Side projects" className="is-gold">
              SP
            </DemoRailChip>
            <span className="demo-rail-spacer" />
            <DemoRailChip label="Add project" className="is-add">
              <PlusIcon />
            </DemoRailChip>
          </aside>

          {/* Home / Configure, with Settings in the footer — the nav the app
              actually ships (sidebar/nav-list.tsx). There is no Sessions page
              and no Files page: chats are tabs inside Home, and main-checkout
              files are File tabs beside them, opened from Home's own Files
              navigator (VC-121/VC-122). */}
          <aside className="demo-nav-rail" aria-hidden="true">
            <DemoNavChip label="Home" active>
              <HouseIcon />
            </DemoNavChip>
            <DemoNavChip label="Configure">
              <SlidersIcon />
            </DemoNavChip>
            <span className="demo-rail-spacer" />
            <DemoNavChip label="Settings">
              <SettingsIcon />
            </DemoNavChip>
          </aside>

          {/* A div, not <main>: the page that hosts this already has one, and
              two main landmarks is one too many. */}
          <div className="demo-main-surface">
            {/* Home's tab strip: a permanent Board tab, project chats beside it,
                and one control that starts a chat. */}
            <div className="demo-home-tabs" aria-hidden="true">
              <span className="is-active">
                <BoardIcon /> Board
              </span>
              <span>Plan the billing migration</span>
              <span>README.md</span>
              <span className="demo-home-newchat">
                <PlusIcon /> Chat
                <span className="demo-home-caret">
                  <CaretIcon />
                </span>
              </span>
            </div>

            <div className="demo-board-toolbar">
              <div className="demo-board-title">
                <strong>Board</strong>
                <span>{tickets.length}</span>
              </div>
              <div className="demo-board-actions" aria-hidden="true">
                <span className="demo-control">Priority</span>
                <span className="demo-control demo-control-manual">
                  <SortIcon /> Manual
                </span>
                <span className="demo-view-control">
                  <BoardIcon />
                </span>
                <span className="demo-new-ticket">
                  <PlusIcon /> New ticket
                </span>
              </div>
            </div>

            <div className="demo-board-scroll" ref={boardRef}>
              <div className="demo-board">
                {PHASES.map((phase) => {
                  const phaseTickets = tickets.filter((ticket) => ticket.phase === phase.key);
                  return (
                    <section
                      className={`demo-column${
                        draggingId && dropPhase === phase.key ? " is-drop-target" : ""
                      }`}
                      data-phase={phase.key}
                      key={phase.key}
                      aria-label={`${phase.label}, ${phaseTickets.length} ${
                        phaseTickets.length === 1 ? "ticket" : "tickets"
                      }`}
                    >
                      <div className="demo-column-header">
                        <strong>{phase.label}</strong>
                        <span>{phaseTickets.length}</span>
                      </div>
                      <div className="demo-card-list">
                        {phaseTickets.map((ticket) => (
                          <button
                            className={`demo-ticket${
                              ticket.phase === "doing" || ticket.phase === "review"
                                ? " has-agent"
                                : ""
                            }${ticket.id === draggingId ? " is-dragging" : ""}`}
                            type="button"
                            data-demo-ticket={ticket.id}
                            key={ticket.id}
                            aria-label={`Open ${ticket.code}: ${ticket.title}. ${phaseLabel(
                              ticket.phase,
                            )}.`}
                            onClick={(event) => handleTicketClick(event, ticket)}
                            onPointerDown={(event) => handlePointerDown(event, ticket)}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerCancel}
                          >
                            <span className="demo-ticket-meta">
                              <span>{ticket.code}</span>
                              <PriorityBars level={ticket.priority} />
                            </span>
                            <strong>{ticket.title}</strong>
                            {(ticket.phase === "doing" || ticket.phase === "review") && (
                              <span className="demo-agent-status">
                                <span className="demo-live-dot" />
                                {chatCount(ticket) === 1 ? "1 chat" : `${chatCount(ticket)} chats`}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                      <span className="demo-add-row" aria-hidden="true">
                        <PlusIcon /> New
                      </span>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {selected && (
          <div
            className="demo-preview-overlay"
            ref={overlayRef}
            onClick={(event) => {
              if (event.target === event.currentTarget) closePreview(true);
            }}
          >
            <section
              className="demo-preview"
              ref={previewRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="demo-preview-title"
              tabIndex={-1}
            >
              <button
                className="demo-preview-close"
                type="button"
                aria-label="Close ticket preview"
                onClick={() => closePreview(true)}
              >
                <CloseIcon />
              </button>

              <PreviewTabs ticket={selected} />

              <div className="demo-preview-content" ref={previewContentRef}>
                <PreviewBody ticket={selected} />
              </div>

              <nav className="demo-phase-switcher" aria-label="Move ticket to phase">
                {PHASES.map((phase) => (
                  <button
                    type="button"
                    key={phase.key}
                    className={selected.phase === phase.key ? "is-active" : undefined}
                    aria-current={selected.phase === phase.key ? "step" : undefined}
                    onClick={() => switchSelectedPhase(phase.key)}
                  >
                    {phase.mobileLabel}
                  </button>
                ))}
              </nav>
            </section>
          </div>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/**
 * A ticket workspace's tabs: the Ticket Body is the permanent first tab, chats
 * and files open beside it. Not "Session 1 / Session 2" — chats are named.
 */
function PreviewTabs({ ticket }: { ticket: DemoTicket }) {
  const active = ticket.phase === "doing" || ticket.phase === "review";

  return (
    <div className="demo-preview-tabs">
      <span className={!active ? "is-active" : undefined}>{ticket.code}</span>
      {active && (
        <>
          <span className="is-active">{ticket.title}</span>
          {chatCount(ticket) > 1 && <span>Earlier chat</span>}
          <span className="demo-tab-add" aria-hidden="true">
            <PlusIcon />
          </span>
        </>
      )}
    </div>
  );
}

function PreviewBody({ ticket }: { ticket: DemoTicket }) {
  if (ticket.phase === "backlog" || ticket.phase === "todo") {
    return <ScratchpadPreview ticket={ticket} />;
  }
  if (ticket.phase === "done") return <DonePreview ticket={ticket} />;
  return <ChatPreview ticket={ticket} review={ticket.phase === "review"} />;
}

function ScratchpadPreview({ ticket }: { ticket: DemoTicket }) {
  return (
    <div className="demo-doc-layout">
      <div className="demo-doc-main">
        <span className="demo-doc-id">{ticket.code}</span>
        <h2 id="demo-preview-title">{ticket.title}</h2>
        <p>
          Write the outcome, the constraints, and how you&rsquo;ll judge the result. This brief is
          what an agent chat on this task starts with. When the work needs a checkout of its own,
          the task gets an isolated worktree rather than taking over your main one.
        </p>
        <div className="demo-doc-section">
          <strong>Acceptance criteria</strong>
          <ul>
            <li>Scope and constraints are clear</li>
            <li>Relevant project context is linked</li>
            <li>Review expectations are explicit</li>
          </ul>
        </div>
        <span className="demo-file-ref">@CONTEXT.md</span>
      </div>
      <aside className="demo-doc-activity">
        <strong>Activity</strong>
        <span>
          <PlusIcon /> created the ticket
        </span>
        <span>
          <ArrowIcon /> added project context
        </span>
        <span>
          <EditIcon /> refined acceptance criteria
        </span>
      </aside>
    </div>
  );
}

/**
 * The default session: a structured chat, not a terminal.
 *
 * The app's New Session control presses to **Chat** and keeps Terminal under
 * its caret (`sessions/new-session-control.tsx`), so this is what a first-run
 * user meets. The terminal appears here only as the optional companion it is.
 */
function ChatPreview({ ticket, review }: { ticket: DemoTicket; review: boolean }) {
  return (
    <div className="demo-chat-layout">
      <div className="demo-chat-main">
        <div className="demo-chat-heading">
          <div>
            <h2 id="demo-preview-title">{ticket.title}</h2>
            <span className="demo-chat-branch">
              <BranchIcon /> {branchName(ticket)}
            </span>
          </div>
          <span className="demo-chat-scope">Task chat</span>
        </div>

        <div className="demo-chat-thread">
          <div className="demo-chat-turn is-you">
            <span className="demo-chat-author">You</span>
            <p>{ticket.prompt}</p>
          </div>

          <div className="demo-chat-turn is-agent">
            <span className="demo-chat-author">Volli</span>
            <p>
              This task&rsquo;s brief and the project&rsquo;s instructions are attached. I&rsquo;ll
              work in an isolated worktree and leave the change for you to read.
            </p>
            <div className="demo-chat-steps">
              <span>
                <BookIcon />
                <span>
                  Read <small>ticket body, repo instructions</small>
                </span>
              </span>
              <span>
                <EditIcon />
                <span>
                  Edit <small>4 files in the worktree</small>
                </span>
              </span>
            </div>
            {review ? (
              <p className="demo-chat-handoff">
                Done in the worktree — the change set is on the <strong>Changes</strong> tab
                whenever you want to read it.
              </p>
            ) : null}
          </div>

          {!review && (
            <div className="demo-chat-working">
              <span className="demo-chat-spinner" />
              Working… <small>esc to interrupt</small>
            </div>
          )}
        </div>

        {/* The composer's real controls: what you type, which model, how much
            reasoning effort. Effort labels come from the shipped set. */}
        <div className="demo-chat-composer" aria-hidden="true">
          <span className="demo-chat-input">Ask a follow-up…</span>
          <span className="demo-chat-chips">
            <span className="demo-chat-chip">Default model</span>
            <span className="demo-chat-chip">Effort: Medium</span>
            <span className="demo-chat-send">
              <ArrowIcon />
            </span>
          </span>
        </div>
      </div>

      <aside className="demo-chat-rail">
        <div className="demo-session-heading">
          <strong>Chats</strong>
          <span>{chatCount(ticket)}</span>
        </div>
        <div className="demo-session-row is-current">
          <span className={review ? "demo-idle-dot" : "demo-live-dot"} />
          <span>
            <strong>{ticket.title}</strong>
            <small>{review ? "Finished · history kept" : "Running"}</small>
          </span>
        </div>
        {chatCount(ticket) > 1 && (
          <div className="demo-session-row">
            <span className="demo-idle-dot" />
            <span>
              <strong>Earlier chat</strong>
              <small>Reopen any time</small>
            </span>
          </div>
        )}
        <div className="demo-session-details">
          <span>Column</span>
          <strong>{review ? "Needs Review" : "Doing"}</strong>
          <span>Worktree</span>
          <strong>Isolated checkout</strong>
          <span>Base</span>
          <strong>main</strong>
        </div>
        <div className="demo-rail-note">
          <TerminalIcon />
          <span>
            Want to drive a CLI yourself? Open a terminal in the same worktree — it&rsquo;s a
            companion, not a fallback.
          </span>
        </div>
      </aside>
    </div>
  );
}

/**
 * What a finished ticket keeps — stated as record, not as a verdict. The old
 * copy claimed "Tests passed" and "Change Set inspected" as static facts, which
 * reads as Volli certifying the work. It does not: a person reviewed and moved
 * it (VC-64).
 */
function DonePreview({ ticket }: { ticket: DemoTicket }) {
  return (
    <div className="demo-done-view">
      <span className="demo-done-check">
        <CheckIcon />
      </span>
      <span className="demo-doc-id">{ticket.code}</span>
      <h2 id="demo-preview-title">{ticket.title}</h2>
      <p>
        The task keeps its chats, changes, branch, and the trail of how it got here in one place you
        can reopen later.
      </p>
      <div className="demo-delivery-summary">
        <span>
          <BranchIcon /> {branchName(ticket)}
        </span>
        <span>
          <PullRequestIcon /> 4 files changed
        </span>
        <span>
          <ChatIcon /> {chatCount(ticket) === 1 ? "1 chat" : `${chatCount(ticket)} chats`} kept
        </span>
      </div>
    </div>
  );
}

function DemoRailChip({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`demo-rail-button ${className}`}>
      {children}
      <span className="demo-hover-label">{label}</span>
    </span>
  );
}

function DemoNavChip({
  label,
  active = false,
  children,
}: {
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={`demo-nav-button${active ? " is-active" : ""}`}>
      {children}
      <span className="demo-hover-label">{label}</span>
    </span>
  );
}

function PriorityBars({ level }: { level: 1 | 2 | 3 }) {
  return (
    <span className="demo-priority" aria-label={`Priority ${level}`}>
      {[1, 2, 3].map((bar) => (
        <span className={bar <= level ? "is-filled" : undefined} key={bar} />
      ))}
    </span>
  );
}

function SvgIcon({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" style={style}>
      {children}
    </svg>
  );
}

function PlusIcon() {
  return (
    <SvgIcon>
      <path d="M12 5v14M5 12h14" />
    </SvgIcon>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <SvgIcon style={direction === "right" ? { transform: "scaleX(-1)" } : undefined}>
      <path d="m14.5 5-7 7 7 7" />
    </SvgIcon>
  );
}

function SearchIcon() {
  return (
    <SvgIcon>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </SvgIcon>
  );
}

function BoardIcon() {
  return (
    <SvgIcon>
      <rect x="4" y="4" width="6" height="7" rx="1" />
      <rect x="14" y="4" width="6" height="4" rx="1" />
      <rect x="4" y="15" width="6" height="5" rx="1" />
      <rect x="14" y="12" width="6" height="8" rx="1" />
    </SvgIcon>
  );
}

/** Home. The app's nav uses Phosphor's House for exactly this row. */
function HouseIcon() {
  return (
    <SvgIcon>
      <path d="M4 10.5 12 4l8 6.5V20h-5v-5.5H9V20H4z" />
    </SvgIcon>
  );
}

/** Configure. */
function SlidersIcon() {
  return (
    <SvgIcon>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </SvgIcon>
  );
}

function CaretIcon() {
  return (
    <SvgIcon>
      <path d="m7 10 5 5 5-5" />
    </SvgIcon>
  );
}

function ChatIcon() {
  return (
    <SvgIcon>
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    </SvgIcon>
  );
}

function BookIcon() {
  return (
    <SvgIcon>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4zM20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z" />
    </SvgIcon>
  );
}

function TerminalIcon() {
  return (
    <SvgIcon>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m7 10 3 2-3 2M13 15h4" />
    </SvgIcon>
  );
}

function SettingsIcon() {
  return (
    <SvgIcon>
      <path d="M9.7 3.6 10.4 2h3.2l.7 1.6 1.7.7 1.6-.6 2.2 2.2-.6 1.6.7 1.7 1.6.7v3.2l-1.6.7-.7 1.7.6 1.6-2.2 2.2-1.6-.6-1.7.7-.7 1.6h-3.2l-.7-1.6-1.7-.7-1.6.6-2.2-2.2.6-1.6-.7-1.7-1.6-.7V9.9l1.6-.7.7-1.7-.6-1.6 2.2-2.2 1.6.6 1.7-.7Z" />
      <circle cx="12" cy="11.5" r="3" />
    </SvgIcon>
  );
}

function SortIcon() {
  return (
    <SvgIcon>
      <path d="M8 5v14M5 8l3-3 3 3M16 19V5M13 16l3 3 3-3" />
    </SvgIcon>
  );
}

function CloseIcon() {
  return (
    <SvgIcon>
      <path d="m6 6 12 12M18 6 6 18" />
    </SvgIcon>
  );
}

function ArrowIcon() {
  return (
    <SvgIcon>
      <path d="M4 12h15M14 7l5 5-5 5" />
    </SvgIcon>
  );
}

function EditIcon() {
  return (
    <SvgIcon>
      <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />
    </SvgIcon>
  );
}

function CheckIcon() {
  return (
    <SvgIcon>
      <path d="m5 12 4 4L19 6" />
    </SvgIcon>
  );
}

function BranchIcon() {
  return (
    <SvgIcon>
      <circle cx="7" cy="5" r="2" />
      <circle cx="17" cy="7" r="2" />
      <circle cx="7" cy="19" r="2" />
      <path d="M7 7v10M9 12c5 0 8-1 8-3" />
    </SvgIcon>
  );
}

function PullRequestIcon() {
  return (
    <SvgIcon>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="19" r="2" />
      <path d="M6 7v10M18 17V9l-4-4M14 5h4v4" />
    </SvgIcon>
  );
}
