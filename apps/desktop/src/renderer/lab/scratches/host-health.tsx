/**
 * VC-615 flows 5 and 6 — a host after it is added: where it shows, how its
 * connection reads, and what happens when it is offline, older than the app,
 * refusing to serve (VC-602's newer-database failure, reaching the client as
 * VC-562 notes), or newer than the app.
 *
 * Staged over the real app window. Two pieces are drawn on top of it, because
 * the shell has nowhere for them yet (VC-576 owns that):
 *
 *  - the **host chip** in the title bar — the current workspace's host, and
 *    the switcher behind it (This Mac, every paired host, Add a host…);
 *  - the **connection surface**, three directions behind the picker:
 *      1. **Island** — a capsule floating over the board: one line, one action.
 *      2. **Banner** — a strip across the top of the content, Linear-style.
 *      3. **Chip** — nothing on the page; the title-bar chip itself says it.
 *
 * Read-only is real: while the host can't serve, the board's create controls
 * stand down (one authority per workspace — no queued writes, ever). Sessions
 * on the host keep running; only this Mac's view is stale.
 */
import * as React from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { QrCodeIcon } from "@phosphor-icons/react/dist/csr/QrCode";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WifiSlashIcon } from "@phosphor-icons/react/dist/csr/WifiSlash";
import { toast } from "sonner";

import { AppShell } from "@renderer/components/app-shell";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

import { seedApp } from "../seed";
import { APP_VERSION } from "../remote-host/fixtures";
import { LabBar, LabPills, LabSelect, ProtoPicker, useVariants } from "../remote-host/lab-chrome";
import {
  AutoHeight,
  EASE_OUT,
  HostGlyph,
  ProgressLine,
  ProviderMark,
  StepMark,
  SwapText,
  type GlyphBadge,
} from "../remote-host/parts";
import { shellApi } from "../remote-host/shell-api";

export const title = "Remote host — Connection, health and updates";
export const note =
  "VC-615 flows 5–6: host chip + switcher, offline read-only, update host, newer DB, newer host";
export const viewport = "window";
export const seed = seedApp;
export const api = shellApi;

const HOST = "hetzner-1";
const VARIANTS = ["Island", "Banner", "Chip"] as const;

type HostState =
  | "online"
  | "reconnecting"
  | "offline"
  | "update"
  | "updating"
  | "too-old"
  | "refusing"
  | "newer"
  | "sign-in";

const STATE_OPTIONS: readonly { value: HostState; label: string }[] = [
  { value: "online", label: "Online" },
  { value: "reconnecting", label: "Reconnecting (blip)" },
  { value: "offline", label: "Offline → read-only" },
  { value: "update", label: "Host older · update available" },
  { value: "too-old", label: "Host too old to connect" },
  { value: "refusing", label: "Refusing · database from newer Volli" },
  { value: "newer", label: "Host newer than this app" },
  { value: "sign-in", label: "Sign-in expired on host" },
];

type Retry = "fails" | "succeeds";

/** What each state blocks. Only these make the workspace read-only. */
function isBlocking(state: HostState): boolean {
  return state === "offline" || state === "too-old" || state === "refusing" || state === "newer";
}

function hostVersion(state: HostState, updated: boolean): string {
  if (updated) return APP_VERSION;
  if (state === "update") return "0.2.4";
  if (state === "too-old") return "0.1.8";
  if (state === "refusing") return "0.2.9";
  if (state === "newer") return "0.4.0";
  return APP_VERSION;
}

export default function HostHealthScratch() {
  const variants = useVariants(VARIANTS.length);
  const [state, setState] = React.useState<HostState>("offline");
  const [retry, setRetry] = React.useState<Retry>("succeeds");
  const [updated, setUpdated] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [whenIdle, setWhenIdle] = React.useState(false);
  const [offlineSince] = React.useState("4:12 PM");
  const [countdown, setCountdown] = React.useState(8);

  const choose = (next: HostState) => {
    setUpdated(false);
    setWhenIdle(false);
    setCountdown(8);
    setState(next);
  };

  /* Offline: count down to an automatic retry, then try. */
  React.useEffect(() => {
    if (state !== "offline") return;
    if (countdown <= 0) {
      setState("reconnecting");
      const id = setTimeout(() => {
        if (retry === "succeeds") {
          setState("online");
          toast.success(`Back on ${HOST}`, {
            description: "2 Sessions kept running while you were away",
          });
        } else {
          setCountdown(16);
          setState("offline");
        }
      }, 1600);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => clearTimeout(id);
  }, [state, countdown, retry]);

  /* Update: download, restart, come back. */
  const startUpdate = React.useCallback(() => {
    setWhenIdle(false);
    setProgress(0);
    setState("updating");
  }, []);
  React.useEffect(() => {
    if (state !== "updating") return;
    if (progress < 1) {
      const id = setTimeout(() => setProgress((value) => Math.min(1, value + 0.08)), 140);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => {
      setUpdated(true);
      setState("online");
      toast.success(`${HOST} is on Volli host ${APP_VERSION}`, {
        description: "Sessions picked up where they paused",
      });
    }, 1100);
    return () => clearTimeout(id);
  }, [state, progress]);

  const readOnly = isBlocking(state);
  const variant = variants.current;
  const version = hostVersion(state, updated);
  const surface = surfaceFor(state, countdown, offlineSince, version);
  const act = () => {
    if (state === "offline") setCountdown(0);
    else if (state === "too-old" || state === "refusing" || state === "update") startUpdate();
    else if (state === "newer")
      toast("Volli 0.4.0 is downloading", { description: "Restart when it’s ready" });
    else if (state === "sign-in") {
      setState("online");
      toast.success(`Signed in on ${HOST}`);
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative h-svh w-full" data-lab-readonly={readOnly ? "true" : undefined}>
        <ReadOnlyStyle />
        <AppShell />
        <ContentOverlay>
          {(rect) => (
            <>
              {variant === 1 ? <Banner rect={rect} surface={surface} onAct={act} /> : null}
              {variant === 0 ? <Island rect={rect} surface={surface} onAct={act} /> : null}
            </>
          )}
        </ContentOverlay>
        <HostChip
          state={state}
          version={version}
          progress={progress}
          whenIdle={whenIdle}
          expanded={variant === 2 ? surface : null}
          onUpdate={startUpdate}
          onUpdateWhenIdle={() => setWhenIdle(true)}
          onCancelWhenIdle={() => setWhenIdle(false)}
          onAct={act}
        />
      </div>

      {/* Over the sidebar's empty foot, clear of the board's overlays. */}
      <div className="fixed bottom-20 left-20 z-[9998]">
        <LabBar fixed={false} className="flex-col items-start">
          <LabSelect
            label="Host"
            value={state === "updating" ? "update" : state}
            options={STATE_OPTIONS}
            onChange={choose}
          />
          <LabPills
            label="Retry"
            value={retry}
            options={[
              { value: "succeeds", label: "Comes back" },
              { value: "fails", label: "Stays down" },
            ]}
            onChange={setRetry}
          />
        </LabBar>
      </div>
      <ProtoPicker names={VARIANTS} current={variant} onSelect={variants.select} />
    </MotionConfig>
  );
}

/* ── The connection surface's words ────────────────────────────────────── */

interface Surface {
  tone: "quiet" | "attention" | "error";
  icon: typeof WarningIcon;
  line: string;
  /** Quiet trailing context: a countdown, a time. */
  meta?: string;
  action?: string;
}

/**
 * One line and at most one action for every state that needs the page to say
 * anything. Online and a plain update say nothing here — an update is the
 * switcher's business, not a banner's.
 */
function surfaceFor(
  state: HostState,
  countdown: number,
  since: string,
  version: string,
): Surface | null {
  switch (state) {
    case "reconnecting":
      return { tone: "quiet", icon: ArrowClockwiseIcon, line: `Reconnecting to ${HOST}` };
    case "offline":
      return {
        tone: "quiet",
        icon: WifiSlashIcon,
        line: `Can’t reach ${HOST} · Read-only`,
        meta: countdown > 0 ? `Retrying in ${countdown}s` : "Retrying",
        action: "Retry now",
      };
    case "too-old":
      return {
        tone: "attention",
        icon: WarningIcon,
        line: `${HOST} needs Volli host ${APP_VERSION} · Read-only`,
        action: "Update host",
      };
    case "refusing":
      return {
        tone: "error",
        icon: WarningIcon,
        line: `${HOST}’s database is from a newer Volli · Read-only`,
        action: "Update host",
      };
    case "newer":
      return {
        tone: "attention",
        icon: WarningIcon,
        line: `${HOST} runs Volli ${version} · Read-only`,
        action: "Update Volli",
      };
    case "updating":
      return { tone: "quiet", icon: ArrowClockwiseIcon, line: `Updating ${HOST}` };
    default:
      void since;
      return null;
  }
}

const TONE: Record<Surface["tone"], string> = {
  quiet: "text-muted-foreground",
  attention: "text-attention",
  error: "text-destructive",
};

/* ── 1 · Island ─────────────────────────────────────────────────────────── */

function Island({
  rect,
  surface,
  onAct,
}: {
  rect: DOMRect;
  surface: Surface | null;
  onAct: () => void;
}) {
  const shown = useGrace(surface);
  return (
    <div
      className="pointer-events-none fixed z-40 flex justify-center"
      style={{ left: rect.left, width: rect.width, bottom: window.innerHeight - rect.bottom + 88 }}
    >
      <AnimatePresence>
        {shown ? (
          <motion.div
            key="island"
            layout
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.16 } }}
            transition={{ duration: 0.28, ease: EASE_OUT }}
            className="pointer-events-auto flex h-11 items-center gap-2 rounded-full border border-border bg-popover pr-1.5 pl-4 shadow-overlay"
          >
            <SurfaceBody surface={shown} onAct={onAct} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ── 2 · Banner ─────────────────────────────────────────────────────────── */

function Banner({
  rect,
  surface,
  onAct,
}: {
  rect: DOMRect;
  surface: Surface | null;
  onAct: () => void;
}) {
  const shown = useGrace(surface);
  return (
    <div
      className="pointer-events-none fixed z-40 overflow-hidden rounded-t-xl"
      style={{ left: rect.left + 1, width: rect.width - 2, top: rect.top + 1 }}
    >
      <AnimatePresence>
        {shown ? (
          <motion.div
            key="banner"
            initial={{ y: "-100%" }}
            animate={{ y: 0 }}
            exit={{ y: "-100%", transition: { duration: 0.18, ease: EASE_OUT } }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className={cn(
              "pointer-events-auto flex h-9 items-center gap-2 border-b px-6",
              shown.tone === "error"
                ? "border-destructive/30 bg-destructive/10"
                : shown.tone === "attention"
                  ? "border-attention/30 bg-attention/10"
                  : "border-border bg-muted",
            )}
          >
            <SurfaceBody surface={shown} onAct={onAct} compact />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SurfaceBody({
  surface,
  onAct,
  compact = false,
}: {
  surface: Surface;
  onAct: () => void;
  compact?: boolean;
}) {
  const Icon = surface.icon;
  const spinning = surface.icon === ArrowClockwiseIcon;
  return (
    <>
      <Icon
        aria-hidden
        weight={surface.tone === "quiet" ? "regular" : "fill"}
        className={cn(
          "size-4 shrink-0",
          TONE[surface.tone],
          spinning && "animate-spin [animation-duration:1.4s]",
        )}
      />
      <SwapText className="text-ui text-foreground">{surface.line}</SwapText>
      {surface.meta ? (
        <span className="text-ui text-muted-foreground tabular-nums">· {surface.meta}</span>
      ) : null}
      {compact ? <span className="flex-1" /> : null}
      {surface.action ? (
        <Button
          size="sm"
          variant={surface.tone === "quiet" ? "secondary" : "default"}
          className="ml-2"
          onClick={onAct}
        >
          {surface.action}
        </Button>
      ) : (
        <span className="w-2" />
      )}
    </>
  );
}

/**
 * A connection that drops for a second and comes back should never have
 * said anything. "Reconnecting" waits out a grace period before it shows;
 * everything else shows at once.
 */
function useGrace(surface: Surface | null): Surface | null {
  const [shown, setShown] = React.useState<Surface | null>(null);
  const quiet = surface?.icon === ArrowClockwiseIcon && surface.line.startsWith("Reconnecting");
  React.useEffect(() => {
    if (!quiet) {
      setShown(surface);
      return;
    }
    const id = setTimeout(() => setShown(surface), 1500);
    return () => clearTimeout(id);
  }, [surface, quiet]);
  return shown;
}

/* ── The host chip and its switcher ────────────────────────────────────── */

function chipBadge(state: HostState): GlyphBadge {
  if (state === "offline") return "offline";
  if (state === "refusing") return "fail";
  if (state === "update" || state === "too-old" || state === "newer" || state === "sign-in")
    return "attention";
  return null;
}

function HostChip({
  state,
  version,
  progress,
  whenIdle,
  expanded,
  onUpdate,
  onUpdateWhenIdle,
  onCancelWhenIdle,
  onAct,
}: {
  state: HostState;
  version: string;
  progress: number;
  whenIdle: boolean;
  expanded: Surface | null;
  onUpdate: () => void;
  onUpdateWhenIdle: () => void;
  onCancelWhenIdle: () => void;
  onAct: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const grace = useGrace(expanded);
  const pulsing = state === "reconnecting" || state === "updating";
  return (
    // Title bar, between the history arrows and search: where the window
    // says which machine it is looking at (Zed's remote title, Xcode's run
    // destination).
    <div className="fixed top-[7px] left-[196px] z-40 flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Host: ${HOST}`}
            className="flex h-7 items-center gap-2 rounded-full pr-2 pl-0.5 text-ui text-foreground transition-colors hover:bg-accent/60 data-[state=open]:bg-accent"
          >
            <motion.span
              animate={pulsing ? { opacity: [1, 0.45, 1] } : { opacity: 1 }}
              transition={
                pulsing ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }
              }
              className="grid"
            >
              <HostGlyph os="linux" size="sm" badge={chipBadge(state)} />
            </motion.span>
            <span className={cn(state === "offline" && "text-muted-foreground")}>{HOST}</span>
            <AnimatePresence initial={false}>
              {grace ? (
                <motion.span
                  key="said"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.24, ease: EASE_OUT }}
                  className={cn("overflow-hidden whitespace-nowrap", TONE[grace.tone])}
                >
                  · {chipWords(state)}
                </motion.span>
              ) : null}
            </AnimatePresence>
            <CaretDownIcon className="size-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <SwitcherRow name="This Mac" local meta="3 workspaces" />
          <div className="rounded-row bg-accent/50">
            <SwitcherRow
              name={HOST}
              meta={hostMeta(state, version)}
              badge={chipBadge(state)}
              current
            />
            <AutoHeight>
              <HostDetail
                state={state}
                progress={progress}
                whenIdle={whenIdle}
                onUpdate={onUpdate}
                onUpdateWhenIdle={onUpdateWhenIdle}
                onCancelWhenIdle={onCancelWhenIdle}
                onAct={onAct}
              />
            </AutoHeight>
          </div>
          <SwitcherRow name="mac-mini" os="macos" meta="Offline · 2 h ago" badge="offline" />
          <div className="my-1 h-px bg-border/60" />
          <MenuAction
            icon={PlusIcon}
            label="Add a host…"
            onAct={() => (window.location.hash = "host-add")}
          />
          <MenuAction
            icon={QrCodeIcon}
            label="Pair with a code…"
            onAct={() => (window.location.hash = "host-pair")}
          />
          <MenuAction
            icon={GearSixIcon}
            label="Manage hosts…"
            onAct={() => (window.location.hash = "host-manage")}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function chipWords(state: HostState): string {
  switch (state) {
    case "offline":
      return "Read-only";
    case "reconnecting":
      return "Reconnecting";
    case "updating":
      return "Updating";
    case "too-old":
      return "Needs update";
    case "refusing":
      return "Newer database";
    case "newer":
      return "Newer than this app";
    default:
      return "";
  }
}

function hostMeta(state: HostState, version: string): string {
  switch (state) {
    case "offline":
      return "Offline · since 4:12 PM";
    case "reconnecting":
      return "Reconnecting";
    case "updating":
      return "Updating";
    case "refusing":
      return `Volli host ${version}`;
    case "too-old":
    case "update":
    case "newer":
      return `Volli host ${version}`;
    default:
      return "2 Sessions running";
  }
}

/** The one thing the current host's row has to say, under its name. */
function HostDetail({
  state,
  progress,
  whenIdle,
  onUpdate,
  onUpdateWhenIdle,
  onCancelWhenIdle,
  onAct,
}: {
  state: HostState;
  progress: number;
  whenIdle: boolean;
  onUpdate: () => void;
  onUpdateWhenIdle: () => void;
  onCancelWhenIdle: () => void;
  onAct: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  React.useEffect(() => setConfirming(false), [state]);

  if (state === "updating") {
    return (
      <div className="flex flex-col gap-2 px-2 pb-2 pl-10">
        <div className="flex items-center gap-2 text-ui text-muted-foreground">
          <StepMark status="active" />
          <SwapText>{progress < 1 ? `Updating to ${APP_VERSION}` : "Restarting"}</SwapText>
        </div>
        <ProgressLine value={progress} />
      </div>
    );
  }
  if (state === "update") {
    if (whenIdle) {
      return (
        <DetailLine
          icon={<ClockIcon className="size-4 text-muted-foreground" />}
          text="Updates when Sessions finish"
        >
          <Button size="xs" variant="ghost" onClick={onCancelWhenIdle}>
            Cancel
          </Button>
        </DetailLine>
      );
    }
    if (confirming) {
      return (
        <div className="flex flex-col gap-2 px-2 pb-2 pl-10">
          <p className="text-ui text-muted-foreground">2 Sessions are running on {HOST}.</p>
          <div className="flex gap-1">
            <Button size="xs" variant="secondary" onClick={onUpdateWhenIdle}>
              When they finish
            </Button>
            <Button size="xs" onClick={onUpdate}>
              Update now
            </Button>
          </div>
        </div>
      );
    }
    return (
      <DetailLine text={`Volli host ${APP_VERSION} is available`}>
        <Button size="xs" onClick={() => setConfirming(true)}>
          Update
        </Button>
      </DetailLine>
    );
  }
  if (state === "offline") {
    return (
      <DetailLine
        icon={<WifiSlashIcon className="size-4 text-muted-foreground" />}
        text="Sessions there keep running"
      >
        <Button size="xs" variant="secondary" onClick={onAct}>
          Retry now
        </Button>
      </DetailLine>
    );
  }
  if (state === "sign-in") {
    return (
      <DetailLine
        icon={<ProviderMark id="anthropic" name="Claude" />}
        text="Claude sign-in expired"
        tone="attention"
      >
        <Button size="xs" variant="secondary" onClick={onAct}>
          Sign in
        </Button>
      </DetailLine>
    );
  }
  if (state === "too-old" || state === "refusing") {
    return (
      <DetailLine
        text={state === "refusing" ? "Database from a newer Volli" : "Too old for this app"}
        tone="attention"
      >
        <Button size="xs" onClick={onUpdate}>
          Update host
        </Button>
      </DetailLine>
    );
  }
  if (state === "newer") {
    return (
      <DetailLine text="Newer than this app" tone="attention">
        <Button size="xs" onClick={onAct}>
          Update Volli
        </Button>
      </DetailLine>
    );
  }
  return null;
}

function DetailLine({
  icon,
  text,
  tone = "quiet",
  children,
}: {
  icon?: React.ReactNode;
  text: string;
  tone?: "quiet" | "attention";
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2 pb-2 pl-10">
      {icon}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-ui",
          tone === "attention" ? "text-attention" : "text-muted-foreground",
        )}
      >
        {text}
      </span>
      {children}
    </div>
  );
}

function SwitcherRow({
  name,
  meta,
  os = "linux",
  local = false,
  badge = null,
  current = false,
}: {
  name: string;
  meta?: string;
  os?: "linux" | "macos";
  local?: boolean;
  badge?: GlyphBadge;
  current?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-10 cursor-default items-center gap-2 rounded-row px-2 select-none",
        !current && "hover:bg-accent/60",
      )}
    >
      <HostGlyph os={os} local={local} size="sm" badge={badge} />
      <span className={cn("text-ui font-medium", badge === "offline" && "text-muted-foreground")}>
        {name}
      </span>
      {meta ? (
        <span className="ml-auto truncate text-ui text-muted-foreground">
          <SwapText>{meta}</SwapText>
        </span>
      ) : null}
    </div>
  );
}

function MenuAction({
  icon: Icon,
  label,
  onAct,
}: {
  icon: typeof PlusIcon;
  label: string;
  onAct: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onAct}
      className="flex h-8 w-full cursor-default items-center gap-2 rounded-row px-2 text-left text-ui select-none hover:bg-accent"
    >
      <Icon className="size-3.5 text-muted-foreground" />
      {label}
    </button>
  );
}

/* ── Staging over the real shell ───────────────────────────────────────── */

/**
 * The content card's live rectangle, so the island and banner sit on the
 * board the way a real overlay would, at any window size.
 */
function ContentOverlay({ children }: { children: (rect: DOMRect) => React.ReactNode }) {
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  React.useEffect(() => {
    let frame = 0;
    const measure = () => {
      const main = document.querySelector("main");
      if (main) setRect(main.getBoundingClientRect());
    };
    const loop = () => {
      measure();
      frame = window.setTimeout(loop, 500);
    };
    loop();
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(frame);
      window.removeEventListener("resize", measure);
    };
  }, []);
  return rect ? <>{children(rect)}</> : null;
}

/**
 * Read-only, applied to the real board: the controls that would WRITE stand
 * down; reading, opening and scrolling stay. Lab staging only — the product
 * would derive this from the workspace's authority state, not a selector.
 */
function ReadOnlyStyle() {
  // The board's write controls carry no stable hook, so the lab tags them by
  // their accessible names. Polled because the board re-renders under us.
  React.useEffect(() => {
    const tag = () => {
      for (const button of document.querySelectorAll<HTMLButtonElement>("main button")) {
        const name = button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "";
        if (
          name === "New ticket" ||
          name === "New" ||
          name === "New chat" ||
          name.startsWith("Arm ")
        ) {
          button.dataset.labWrite = "";
        }
      }
    };
    tag();
    const id = setInterval(tag, 500);
    return () => clearInterval(id);
  }, []);
  return (
    <style>{`
      main [data-lab-write] {
        transition: opacity 200ms var(--ease-out), filter 200ms var(--ease-out);
      }
      [data-lab-readonly="true"] main [data-lab-write] {
        opacity: 0.4;
        pointer-events: none;
        filter: saturate(0);
      }
    `}</style>
  );
}
