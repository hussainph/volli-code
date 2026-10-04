/**
 * VC-615 flow 4 — Sign-ins on the host, and open decision 2: send this Mac's
 * sign-ins (with a one-line confirm), or always sign in on the host?
 *
 * Three directions behind the picker (1/2/3, ←/→):
 *
 *  - **From this Mac** — one switch per sign-in; the only sentence is the
 *    trust boundary. Fastest, and the box never asks you anything.
 *  - **On the host** — nothing leaves this Mac. Subscriptions and GitHub
 *    sign in with a device code (approve in this Mac's browser, the box
 *    turns signed-in by itself); an API key is pasted once and stored there.
 *  - **Per sign-in** — each row chooses. Subscriptions default to the host
 *    (a copied OAuth login shares one refresh token between two machines,
 *    and providers that rotate it sign one of them out); keys and git push
 *    default to this Mac, where a copy costs nothing.
 *
 * The lab bar's "Moment" switches to what happens later, when a sign-in
 * EXPIRES on the host: the Session that hit it, the host's row in the
 * switcher, and the recovery each direction offers.
 */
import * as React from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { toast } from "sonner";

import { SessionBlocker } from "@renderer/components/chat/chat-plane";
import { Button } from "@renderer/components/ui/button";
import { Toaster } from "@renderer/components/ui/sonner";
import { cn } from "@renderer/lib/utils";

import { SheetFrame } from "../remote-host/add-sheet";
import { MAC_SIGN_INS, type SignIn } from "../remote-host/fixtures";
import {
  DEVICE_CODES,
  ForwardSwitch,
  SignInRow,
  SourceChoice,
  usesKey,
  type RowState,
  type Source,
} from "../remote-host/host-sign-in";
import {
  LabBar,
  LabPills,
  ProtoPicker,
  SPEEDS,
  useVariants,
  type Speed,
} from "../remote-host/lab-chrome";
import {
  AutoHeight,
  EASE_OUT,
  HostGlyph,
  ProviderMark,
  StepMark,
  VenueChip,
} from "../remote-host/parts";

export const title = "Remote host — Sign-ins on the host";
export const note =
  "VC-615 flow 4 / decision 2: send this Mac's sign-ins, or sign in on the host; and expiry";

const VARIANTS = ["From this Mac", "On the host", "Per sign-in"] as const;
const HOST = "hetzner-1";

type Moment = "setup" | "expired";
const MOMENTS = [
  { value: "setup", label: "Set up" },
  { value: "expired", label: "Expired later" },
] as const satisfies readonly { value: Moment; label: string }[];

function defaultSource(signIn: SignIn): Source {
  return signIn.group === "model" && !usesKey(signIn) ? "host" : "mac";
}

export default function SignInsScratch() {
  const variants = useVariants(VARIANTS.length);
  const [moment, setMoment] = React.useState<Moment>("setup");
  const [speed, setSpeed] = React.useState<Speed>("1");
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-[760px] rounded-container bg-muted/40 p-8">
        {moment === "setup" ? (
          <SetupPanel key={variants.mountKey} variant={variants.current} speed={Number(speed)} />
        ) : (
          <ExpiredMoment key={variants.mountKey} variant={variants.current} speed={Number(speed)} />
        )}
      </div>
      <LabBar fixed={false} className="mx-auto mt-4 w-fit">
        <LabPills label="Moment" value={moment} options={MOMENTS} onChange={setMoment} />
        <LabPills label="Speed" value={speed} options={SPEEDS} onChange={setSpeed} />
      </LabBar>
      <ProtoPicker
        names={VARIANTS}
        current={variants.current}
        onSelect={variants.select}
        onReplay={variants.replay}
      />
      <Toaster />
    </MotionConfig>
  );
}

/* ── Set up ─────────────────────────────────────────────────────────────── */

function initialRow(variant: number, signIn: SignIn): RowState {
  if (variant === 0) return signIn.defaultOn ? { kind: "mac" } : { kind: "off" };
  if (variant === 1) return { kind: "host-none" };
  return defaultSource(signIn) === "mac" ? { kind: "mac" } : { kind: "host-none" };
}

function SetupPanel({ variant, speed }: { variant: number; speed: number }) {
  const [rows, setRows] = React.useState<Record<string, RowState>>(() =>
    Object.fromEntries(MAC_SIGN_INS.map((signIn) => [signIn.id, initialRow(variant, signIn)])),
  );
  const [done, setDone] = React.useState(false);
  const set = (id: string, state: RowState) => setRows((current) => ({ ...current, [id]: state }));

  // Stand-in for approving on the provider's page in this Mac's browser.
  React.useEffect(() => {
    const pending = Object.entries(rows).filter(
      ([, state]) => state.kind === "host-code" && state.opened,
    );
    if (pending.length === 0) return;
    const id = setTimeout(() => {
      setRows((current) => {
        const next = { ...current };
        for (const [key] of pending) {
          const signIn = MAC_SIGN_INS.find((item) => item.id === key);
          next[key] = { kind: "host-ok", account: signIn?.account ?? "" };
        }
        return next;
      });
    }, 2600 / speed);
    return () => clearTimeout(id);
  }, [rows, speed]);

  const anyMac = Object.values(rows).some((state) => state.kind === "mac");
  const anySet = Object.values(rows).some(
    (state) => state.kind === "mac" || state.kind === "host-ok",
  );
  const trust =
    variant === 1
      ? "Nothing is copied from this Mac."
      : anyMac
        ? `${HOST} keeps a copy of what this Mac sends.`
        : `Nothing is copied from this Mac.`;

  return (
    <div className="mx-auto w-full max-w-[480px] overflow-hidden rounded-container border border-border bg-background shadow-overlay">
      <AutoHeight>
        <div className="flex items-center gap-4 px-6 pt-6 pb-4">
          <HostGlyph os="linux" size="md" badge={done ? "ok" : null} />
          <div className="min-w-0">
            <h2 className="text-heading font-semibold">Sign-ins on {HOST}</h2>
            <p className="truncate text-ui text-muted-foreground">
              Ubuntu 24.04 · Volli host 0.3.0
            </p>
          </div>
        </div>
        <div className="px-6 pb-4">
          <div className="flex flex-col gap-px rounded-row border border-border/70 bg-muted/30 p-1">
            {MAC_SIGN_INS.map((signIn) => {
              const state = rows[signIn.id] ?? { kind: "off" };
              return (
                <SignInRow
                  key={signIn.id}
                  signIn={signIn}
                  host={HOST}
                  state={state}
                  onBegin={() => beginOnHost(signIn, set)}
                  onChange={(next) => set(signIn.id, next)}
                  inlineBegin={variant === 2}
                  trailing={
                    variant === 0 ? (
                      <ForwardSwitch
                        signIn={signIn}
                        on={state.kind === "mac"}
                        onChange={(on) => set(signIn.id, on ? { kind: "mac" } : { kind: "off" })}
                      />
                    ) : variant === 2 && state.kind !== "host-code" && state.kind !== "host-key" ? (
                      <SourceChoice
                        signIn={signIn}
                        value={state.kind === "mac" ? "mac" : "host"}
                        onChange={(source) =>
                          set(signIn.id, source === "mac" ? { kind: "mac" } : { kind: "host-none" })
                        }
                      />
                    ) : null
                  }
                />
              );
            })}
          </div>
          <p className="flex items-center gap-1 px-2 pt-2 text-ui text-muted-foreground">
            <LockSimpleIcon aria-hidden className="size-3.5 shrink-0" />
            {trust}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-4">
          <AnimatePresence initial={false} mode="popLayout">
            {done ? (
              <motion.span
                key="sent"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                className="mr-auto flex items-center gap-2 pl-2 text-ui text-muted-foreground"
              >
                <StepMark status="done" />
                {HOST} is set up
              </motion.span>
            ) : null}
          </AnimatePresence>
          <Button
            size="sm"
            variant={anySet ? "default" : "ghost"}
            onClick={() => {
              setDone(true);
              toast.success(`${HOST} can start Sessions`);
            }}
          >
            {anySet ? "Done" : "Later"}
          </Button>
        </div>
      </AutoHeight>
    </div>
  );
}

function beginOnHost(signIn: SignIn, set: (id: string, state: RowState) => void) {
  if (usesKey(signIn)) set(signIn.id, { kind: "host-key" });
  else
    set(signIn.id, {
      kind: "host-code",
      code: DEVICE_CODES[signIn.id] ?? "R7TQ-2M9C",
      opened: false,
    });
}

/* ── Expired later ──────────────────────────────────────────────────────── */

const CLAUDE = MAC_SIGN_INS[0] as SignIn;

/**
 * Three surfaces a person meets an expired host sign-in on, all answering
 * with the same recovery: the Session that stopped, the host in the switcher,
 * and (on its own) a notification — not drawn here, it's the app's existing
 * attention path.
 */
function ExpiredMoment({ variant, speed }: { variant: number; speed: number }) {
  // Variant 0 sent this Mac's login, so this Mac can simply send it again.
  // Variants 1 and 2 signed Claude in on the host, so the box needs a fresh
  // device-code sign-in.
  const resend = variant === 0;
  const [phase, setPhase] = React.useState<"expired" | "fixing" | "fixed">("expired");
  const [sheet, setSheet] = React.useState<RowState | null>(null);

  React.useEffect(() => {
    if (phase !== "fixing" || !resend) return;
    const id = setTimeout(() => finish(), 1100 / speed);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, resend, speed]);

  React.useEffect(() => {
    if (sheet?.kind !== "host-code" || !sheet.opened) return;
    const id = setTimeout(() => {
      setSheet({ kind: "host-ok", account: CLAUDE.account ?? "" });
      setTimeout(() => {
        setSheet(null);
        finish();
      }, 700 / speed);
    }, 2600 / speed);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, speed]);

  function finish() {
    setPhase("fixed");
    toast.success(`Signed in on ${HOST}`, {
      description: "2 Sessions picked up where they stopped",
    });
  }

  const recover = () => {
    if (resend) setPhase("fixing");
    else setSheet({ kind: "host-code", code: DEVICE_CODES.anthropic ?? "", opened: false });
  };
  const actionLabel = resend
    ? phase === "fixing"
      ? "Sending…"
      : "Send this Mac’s again"
    : "Sign in again";

  return (
    <div className="mx-auto grid max-w-[1040px] grid-cols-[1fr_320px] items-start gap-6">
      <SessionMock phase={phase} actionLabel={actionLabel} onRecover={recover} />
      <SwitcherMock
        phase={phase}
        actionLabel={resend ? "Send again" : "Sign in"}
        onRecover={recover}
      />
      <AnimatePresence>
        {sheet ? (
          <SheetFrame
            key="sheet"
            width={440}
            label={`Sign in to Claude on ${HOST}`}
            onClose={() => setSheet(null)}
          >
            <div className="px-6 pt-6 pb-4">
              <h2 className="text-heading font-semibold">Claude on {HOST}</h2>
            </div>
            <div className="px-6 pb-6">
              <div className="rounded-row border border-border/70 bg-muted/30 p-1">
                <SignInRow
                  signIn={CLAUDE}
                  host={HOST}
                  state={sheet}
                  onBegin={() =>
                    setSheet({
                      kind: "host-code",
                      code: DEVICE_CODES.anthropic ?? "",
                      opened: false,
                    })
                  }
                  onChange={(next) => (next.kind === "host-none" ? setSheet(null) : setSheet(next))}
                />
              </div>
            </div>
          </SheetFrame>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SessionMock({
  phase,
  actionLabel,
  onRecover,
}: {
  phase: "expired" | "fixing" | "fixed";
  actionLabel: string;
  onRecover: () => void;
}) {
  return (
    <div className="flex h-[560px] flex-col overflow-hidden rounded-container border border-border bg-background shadow-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <span className="font-mono text-ui text-muted-foreground">VLT-14</span>
        <span className="min-w-0 flex-1 truncate text-ui font-medium">
          Trace the dropped decorations back to the debounce
        </span>
        <VenueChip host={HOST} state={phase === "fixed" ? "ready" : "waiting"} />
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-hidden px-6 py-6 text-sm leading-prose text-foreground/90">
        <p>
          The gutter decorations are computed in{" "}
          <code className="font-mono text-ui">useDecorations</code> and re-requested on every scroll
          frame. The debounce in <code className="font-mono text-ui">diff-gutter.ts</code> drops the
          trailing call, so a fast scroll ends without one.
        </p>
        <p className="text-muted-foreground">Running the gutter tests on {HOST}…</p>
        <AnimatePresence initial={false}>
          {phase === "fixed" ? (
            <motion.p
              key="resumed"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: EASE_OUT, delay: 0.15 }}
            >
              14 passed. Switching the debounce to keep its trailing edge and re-running.
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="px-4 pb-4">
        <AnimatePresence initial={false}>
          {phase === "fixed" ? null : (
            <motion.div
              key="blocker"
              exit={{ opacity: 0, y: 6, transition: { duration: 0.18, ease: EASE_OUT } }}
            >
              <SessionBlocker
                blocker={{
                  message: `Claude sign-in expired on ${HOST}`,
                  detail: "The turn is paused, not lost",
                  tone: "error",
                  action: { label: actionLabel, act: onRecover },
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex h-20 items-start rounded-container border border-border bg-card px-4 py-4 text-sm text-muted-foreground shadow-card">
          Message VLT-14…
        </div>
      </div>
    </div>
  );
}

function SwitcherMock({
  phase,
  actionLabel,
  onRecover,
}: {
  phase: "expired" | "fixing" | "fixed";
  actionLabel: string;
  onRecover: () => void;
}) {
  const fixed = phase === "fixed";
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="flex h-8 w-fit items-center gap-2 rounded-full border border-border bg-background pr-2 pl-1 text-ui shadow-raised"
      >
        <HostGlyph os="linux" size="sm" badge={fixed ? null : "attention"} />
        {HOST}
        <CaretDownIcon className="size-3 text-muted-foreground" />
      </button>
      <div className="rounded-container border border-border bg-popover p-1 shadow-overlay">
        <HostRow name="This Mac" local meta="3 workspaces" />
        <div className="rounded-[14px] bg-accent/60">
          <HostRow
            name={HOST}
            meta={fixed ? "Online · 2 Sessions" : undefined}
            badge={fixed ? null : "attention"}
          />
          <AutoHeight>
            {fixed ? null : (
              <div className="flex items-center gap-2 px-2 pb-2 pl-10">
                <ProviderMark id={CLAUDE.id} name={CLAUDE.name} />
                <span className="min-w-0 flex-1 truncate text-ui text-attention">
                  Claude sign-in expired
                </span>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={phase === "fixing"}
                  onClick={onRecover}
                >
                  {actionLabel}
                </Button>
              </div>
            )}
          </AutoHeight>
        </div>
        <HostRow name="mac-mini" os="macos" meta="Offline · 2 h ago" badge="offline" />
      </div>
    </div>
  );
}

function HostRow({
  name,
  meta,
  os = "linux",
  local = false,
  badge = null,
}: {
  name: string;
  meta?: string;
  os?: "linux" | "macos";
  local?: boolean;
  badge?: "attention" | "offline" | null;
}) {
  return (
    <div className="flex h-10 items-center gap-2 rounded-[14px] px-2">
      <HostGlyph os={os} local={local} size="sm" badge={badge} />
      <span className={cn("text-ui font-medium", badge === "offline" && "text-muted-foreground")}>
        {name}
      </span>
      {meta ? <span className="ml-auto text-ui text-muted-foreground">{meta}</span> : null}
    </div>
  );
}
