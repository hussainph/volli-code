import { Dithering } from "@paper-design/shaders-react";
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
type Agent = "Claude Code" | "Codex";

interface DemoTicket {
  id: string;
  code: string;
  title: string;
  phase: Phase;
  priority: 1 | 2 | 3;
  agent?: Agent;
  sessions?: number;
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

const INITIAL_TICKETS: DemoTicket[] = [
  {
    id: "cloud-handoff",
    code: "VC-18",
    title: "Model cloud session handoff",
    phase: "backlog",
    priority: 2,
  },
  {
    id: "release-checks",
    code: "VC-21",
    title: "Design release safety checks",
    phase: "backlog",
    priority: 1,
  },
  {
    id: "worktree-setup",
    code: "VC-24",
    title: "Automate worktree setup",
    phase: "todo",
    priority: 3,
  },
  {
    id: "mobile-review",
    code: "VC-27",
    title: "Plan the mobile review flow",
    phase: "todo",
    priority: 2,
  },
  {
    id: "hook-runner",
    code: "VC-31",
    title: "Build lifecycle hook runner",
    phase: "doing",
    priority: 3,
    agent: "Claude Code",
    sessions: 2,
  },
  {
    id: "codex-resume",
    code: "VC-33",
    title: "Add Codex session resume",
    phase: "doing",
    priority: 2,
    agent: "Codex",
    sessions: 3,
  },
  {
    id: "agent-questions",
    code: "VC-29",
    title: "Surface agent questions",
    phase: "review",
    priority: 2,
    agent: "Claude Code",
    sessions: 2,
  },
  {
    id: "execution-history",
    code: "VC-12",
    title: "Persist execution history",
    phase: "done",
    priority: 1,
    agent: "Codex",
    sessions: 2,
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

const agentForTicket = (ticket: DemoTicket): Agent => {
  if (ticket.agent) return ticket.agent;
  return Number.parseInt(ticket.code.replace("VC-", ""), 10) % 2 === 0 ? "Codex" : "Claude Code";
};

const phaseLabel = (phase: Phase) => PHASES.find((item) => item.key === phase)?.label ?? phase;

export default function VolliDemo() {
  const [tickets, setTickets] = useState<DemoTicket[]>(() =>
    INITIAL_TICKETS.map((ticket) => ({ ...ticket })),
  );
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
    if (!selected) return;
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
  }, [compact, reducedMotion, selected]);

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
                agent:
                  nextPhase === "doing" || nextPhase === "review" || nextPhase === "done"
                    ? agentForTicket(candidate)
                    : candidate.agent,
                sessions:
                  nextPhase === "doing" || nextPhase === "review" || nextPhase === "done"
                    ? (candidate.sessions ?? 2)
                    : candidate.sessions,
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
      <div className="demo-shader" aria-hidden="true">
        <Dithering
          width="100%"
          height="100%"
          colorBack="#121212"
          colorFront="#5c2b1c"
          shape="warp"
          type="4x4"
          size={2.1}
          speed={reducedMotion ? 0 : 0.075}
          frame={6200}
          scale={0.68}
          offsetX={0.28}
          offsetY={-0.12}
          minPixelRatio={1}
          maxPixelCount={1400 * 620}
        />
      </div>

      <div className="demo-glow" aria-hidden="true" />

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

        <div className="demo-workspace">
          <aside className="demo-project-rail" aria-label="Project switcher preview">
            <DemoRailButton label="Volli Code" className="is-selected is-ember">
              VC
            </DemoRailButton>
            <DemoRailButton label="Personal projects" className="is-gold">
              PM
            </DemoRailButton>
            <span className="demo-rail-spacer" />
            <DemoRailButton label="Add project" className="is-add">
              <PlusIcon />
            </DemoRailButton>
          </aside>

          <aside className="demo-nav-rail" aria-label="Navigation preview">
            <DemoNavButton label="Board" active>
              <BoardIcon />
            </DemoNavButton>
            <DemoNavButton label="Sessions">
              <TerminalIcon />
            </DemoNavButton>
            <DemoNavButton label="Files">
              <FolderIcon />
            </DemoNavButton>
            <span className="demo-rail-spacer" />
            <DemoNavButton label="Settings">
              <SettingsIcon />
            </DemoNavButton>
          </aside>

          <main className="demo-main-surface">
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
                      aria-label={`${phase.label}, ${phaseTickets.length} tickets`}
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
                                {agentForTicket(ticket)}
                                <span>{ticket.sessions ?? 2}</span>
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
          </main>
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

function PreviewTabs({ ticket }: { ticket: DemoTicket }) {
  const active = ticket.phase === "doing" || ticket.phase === "review";
  const agent = agentForTicket(ticket);

  return (
    <div className="demo-preview-tabs">
      <span className={!active ? "is-active" : undefined}>{ticket.code}</span>
      {active && (
        <>
          <span className="is-active">{agent === "Claude Code" ? "Claude 1" : "Codex 1"}</span>
          <span>{agent === "Claude Code" ? "Codex 2" : "Claude 2"}</span>
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
  return <TerminalPreview ticket={ticket} review={ticket.phase === "review"} />;
}

function ScratchpadPreview({ ticket }: { ticket: DemoTicket }) {
  return (
    <div className="demo-doc-layout">
      <div className="demo-doc-main">
        <span className="demo-doc-id">{ticket.code}</span>
        <h2 id="demo-preview-title">{ticket.title}</h2>
        <p>
          Make this phase repeatable without coupling it to a single agent. The automation should
          read the ticket brief, prepare the workspace, and leave every decision in the history.
        </p>
        <div className="demo-doc-section">
          <strong>Acceptance criteria</strong>
          <ul>
            <li>Runs when the ticket enters its configured phase</li>
            <li>Can create follow-up work through the Volli CLI</li>
            <li>Never hides a failed mutation</li>
          </ul>
        </div>
        <span className="demo-file-ref">@docs/lifecycle-automation.md</span>
      </div>
      <aside className="demo-doc-activity">
        <strong>Activity</strong>
        <span>
          <PlusIcon /> created the ticket
        </span>
        <span>
          <ArrowIcon /> moved Backlog to Todo
        </span>
        <span>
          <EditIcon /> refined the brief
        </span>
      </aside>
    </div>
  );
}

function TerminalPreview({ ticket, review }: { ticket: DemoTicket; review: boolean }) {
  const agent = agentForTicket(ticket);

  return (
    <div className="demo-terminal-layout">
      <div className="demo-terminal-main">
        <div className="demo-terminal-heading">
          <span className={`demo-agent-mark ${agent === "Codex" ? "is-codex" : "is-claude"}`}>
            {agent === "Codex" ? "C" : "A"}
          </span>
          <div>
            <h2 id="demo-preview-title">{ticket.title}</h2>
            <span>
              volli/{ticket.code.toLowerCase()}-{ticket.id}
            </span>
          </div>
        </div>
        <div className="demo-terminal-screen">
          <p className="demo-terminal-command">
            <span>›</span> {review ? "Review the completed implementation" : ticket.title}
          </p>
          <p>
            <span className="demo-terminal-glyph">●</span> Read ticket brief and project
            instructions
          </p>
          <p>
            <span className="demo-terminal-glyph">●</span> Created isolated worktree and branch
          </p>
          <p>
            <span className="demo-terminal-glyph">●</span> Updated lifecycle automation runner
          </p>
          <p className="demo-terminal-diff">3 files changed&nbsp;&nbsp; +184&nbsp;&nbsp; -27</p>
          {review ? (
            <div className="demo-agent-question">
              The implementation is ready. Should I also migrate the existing project hooks to the
              new configuration format?
            </div>
          ) : (
            <p className="demo-terminal-working">
              <span className="demo-working-dot" /> Running targeted tests
            </p>
          )}
        </div>
      </div>
      <aside className="demo-session-rail">
        <div className="demo-session-heading">
          <strong>Sessions</strong>
          <span>{ticket.sessions ?? 2}</span>
        </div>
        <div className="demo-session-row is-current">
          <span className="demo-live-dot" />
          <span>
            <strong>{agent}</strong>
            <small>{review ? "Waiting for review" : "Working"}</small>
          </span>
        </div>
        <div className="demo-session-row">
          <span className="demo-idle-dot" />
          <span>
            <strong>{agent === "Codex" ? "Claude Code" : "Codex"}</strong>
            <small>Earlier exploration</small>
          </span>
        </div>
        <div className="demo-session-details">
          <span>Phase</span>
          <strong>{review ? "Needs Review" : "Doing"}</strong>
          <span>Worktree</span>
          <strong>Isolated</strong>
        </div>
      </aside>
    </div>
  );
}

function DonePreview({ ticket }: { ticket: DemoTicket }) {
  return (
    <div className="demo-done-view">
      <span className="demo-done-check">
        <CheckIcon />
      </span>
      <span className="demo-doc-id">{ticket.code}</span>
      <h2 id="demo-preview-title">{ticket.title}</h2>
      <p>The work, sessions, branch, and review trail remain attached to the ticket.</p>
      <div className="demo-delivery-summary">
        <span>
          <CheckIcon /> Tests passed
        </span>
        <span>
          <BranchIcon /> volli/{ticket.code.toLowerCase()}-{ticket.id}
        </span>
        <span>
          <PullRequestIcon /> Pull request ready
        </span>
      </div>
    </div>
  );
}

function DemoRailButton({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`demo-rail-button ${className}`} aria-label={label}>
      {children}
      <span className="demo-hover-label">{label}</span>
    </button>
  );
}

function DemoNavButton({
  label,
  active = false,
  children,
}: {
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`demo-nav-button${active ? " is-active" : ""}`}
      aria-label={label}
    >
      {children}
      <span className="demo-hover-label">{label}</span>
    </button>
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

function TerminalIcon() {
  return (
    <SvgIcon>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m7 10 3 2-3 2M13 15h4" />
    </SvgIcon>
  );
}

function FolderIcon() {
  return (
    <SvgIcon>
      <path d="M3 7.5h7l2-2h9v13H3z" />
    </SvgIcon>
  );
}

function SettingsIcon() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
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
