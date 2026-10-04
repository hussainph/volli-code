/**
 * VC-615 flows 2 and 3 — pairing, from both ends at once.
 *
 * **Running host.** The box already runs `volli-hostd pair`; its terminal
 * stands beside the desktop sheet. Type (or paste) the code it printed; the
 * sheet finds the host, asks how this Mac should reach it — Tailscale, a URL,
 * or an SSH tunnel (open decision 3, offered so the owner can judge it) —
 * pairs, and ends on the same sign-ins step Add a host uses. The moment the
 * Mac pairs, the terminal answers with the device line: the two sides talking
 * to each other is the point of the layout.
 *
 * **Phone.** The same primitive reversed: the Mac shows the QR, the phone
 * scans and asks "Pair with hetzner-1?", and the approval lands back on the
 * Mac, the trusted device (Signal / 1Password). A host reached only over SSH
 * cannot be paired with a phone, and says so in one line.
 *
 * The lab bar picks the ending. Failures are one-shot: the recovery works, the
 * way it would once the person had done the thing it asks for.
 */
import * as React from "react";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "motion/react";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { DeviceMobileIcon } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import {
  APP_VERSION,
  DEVICES,
  FACTS,
  HOST_KEY_FINGERPRINT,
  PAIRING_CODE,
  SHORT_FINGERPRINT,
  TAILNET_NAME,
  type HostOs,
  type PairedDevice,
} from "../remote-host/fixtures";
import { Screen } from "../remote-host/add-sheet";
import { LabBar, LabPills, LabSelect, SPEEDS, type Speed } from "../remote-host/lab-chrome";
import {
  bareCode,
  CODE_TTL_MS,
  CodeGroups,
  DEVICE_ID,
  DeviceGlyph,
  EXAMPLE_URL,
  FingerprintTag,
  formatRemaining,
  InlineSheet,
  MAC_TAILNET_IP,
  MISTYPED_CODE,
  NEW_HOST_KEY_FINGERPRINT,
  NEW_SHORT_FINGERPRINT,
  NEXT_PAIRING_CODE,
  normalizeUrl,
  PHONE_ID,
  PHONE_TAILNET_IP,
  PhoneFrame,
  ROUTE_NAME,
  RouteChoice,
  SheetLabel,
  SSH_TARGET,
  StageCaption,
  TerminalSpinner,
  TerminalWindow,
  useNow,
  type Route,
} from "../remote-host/pair-parts";
import {
  AutoHeight,
  CodeInput,
  CommandLine,
  EASE_OUT,
  EASE_SWIFT,
  HostGlyph,
  QrCode,
  StepMark,
  SwapText,
  type GlyphBadge,
  type StepStatus,
} from "../remote-host/parts";
import { useScript, type ScriptIo } from "../remote-host/script";
import { defaultForwarding, ForwardRows } from "../remote-host/sign-in-rows";

export const title = "Remote host — Pair a running host, pair a phone";
export const note =
  "VC-615 flows 2–3: code from the box's terminal → route → paired → sign-ins; phone scans the Mac's QR, the Mac approves";
export const viewport = "window";

const HOST = "hetzner-1";
const MAC_NAME = "Hussain's MacBook Pro";
const PHONE_NAME = "Hussain's iPhone";
const LINUX = FACTS.linux;
const HOST_SUMMARY = `${LINUX.system} · ${LINUX.arch} · Volli host ${APP_VERSION}`;

type Mode = "host" | "phone";
const MODES = [
  { value: "host", label: "Running host" },
  { value: "phone", label: "Phone" },
] as const satisfies readonly { value: Mode; label: string }[];

type HostOutcome =
  | "success"
  | "wrong-code"
  | "expired"
  | "no-tailnet"
  | "url-down"
  | "new-identity";
const OUTCOMES = [
  { value: "success", label: "Success" },
  { value: "wrong-code", label: "Wrong code" },
  { value: "expired", label: "Expired" },
  { value: "no-tailnet", label: "Not on tailnet" },
  { value: "url-down", label: "URL unreachable" },
  { value: "new-identity", label: "New identity" },
] as const satisfies readonly { value: HostOutcome; label: string }[];

type YesNo = "yes" | "no";
const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const satisfies readonly { value: YesNo; label: string }[];

type PhoneRoute = "tailscale" | "ssh";
const PHONE_ROUTES = [
  { value: "tailscale", label: "Tailscale" },
  { value: "ssh", label: "SSH only" },
] as const satisfies readonly { value: PhoneRoute; label: string }[];

export default function HostPairScratch() {
  const [mode, setMode] = React.useState<Mode>("host");
  const [outcome, setOutcome] = React.useState<HostOutcome>("success");
  const [tailscale, setTailscale] = React.useState<YesNo>("yes");
  const [phoneRoute, setPhoneRoute] = React.useState<PhoneRoute>("tailscale");
  const [speed, setSpeed] = React.useState<Speed>("1");
  const [replays, setReplays] = React.useState(0);
  const [typeRequest, setTypeRequest] = React.useState(0);

  const runKey = `${mode}:${outcome}:${tailscale}:${replays}`;

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={cn(
          "relative flex h-svh w-full items-start justify-center overflow-hidden bg-muted/50 px-8",
          // The running-host lab bar wraps to two rows at 1280; the phone's is one.
          mode === "host" ? "pt-24" : "pt-16",
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode === "host" ? runKey : `phone:${replays}`}
            className="flex w-full justify-center"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.26, ease: EASE_OUT }}
          >
            {mode === "host" ? (
              <RunningHost
                outcome={outcome}
                tailscale={tailscale === "yes"}
                speed={Number(speed)}
                runKey={runKey}
                typeRequest={typeRequest}
                onReplay={() => setReplays((value) => value + 1)}
              />
            ) : (
              <PhonePairing
                route={phoneRoute}
                speed={Number(speed)}
                runKey={`phone:${phoneRoute}:${replays}`}
                onTurnOnTailscale={() => setPhoneRoute("tailscale")}
                onReplay={() => setReplays((value) => value + 1)}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <LabBar>
        <LabPills label="Pair" value={mode} options={MODES} onChange={setMode} />
        {mode === "host" ? (
          <>
            <LabSelect label="Outcome" value={outcome} options={OUTCOMES} onChange={setOutcome} />
            <LabPills
              label="Tailscale"
              value={tailscale}
              options={YES_NO}
              onChange={setTailscale}
            />
          </>
        ) : (
          <LabPills
            label="Route"
            value={phoneRoute}
            options={PHONE_ROUTES}
            onChange={setPhoneRoute}
          />
        )}
        <LabPills label="Speed" value={speed} options={SPEEDS} onChange={setSpeed} />
        {mode === "host" ? (
          <button
            type="button"
            onClick={() => setTypeRequest((value) => value + 1)}
            className="rounded-full px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Type code
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setReplays((value) => value + 1)}
          className="rounded-full bg-foreground px-2.5 py-1 text-[11px] text-background"
        >
          Replay
        </button>
      </LabBar>
    </MotionConfig>
  );
}

/* ══ Flow 2 · a running host ═══════════════════════════════════════════════ */

type PairStepId = "reach" | "verify" | "exchange";
const PAIR_STEPS: readonly PairStepId[] = ["reach", "verify", "exchange"];

interface PairStep {
  status: StepStatus;
  label: string;
  detail?: string;
}

/** One `volli-hostd pair` invocation on the box, as its terminal prints it. */
interface BoxRun {
  id: number;
  code: string;
  /** Characters of the command typed so far; output follows the last one. */
  typed: number;
  output: boolean;
  expiresAt: number;
  /** Lines the host prints while it waits: a device arriving, then paired. */
  events: { id: number; kind: "dim" | "ok"; text: string }[];
  /** The command returned — paired, or the code ran out. */
  exited: boolean;
}

interface PairState {
  stage: "code" | "found" | "pairing" | "paired" | "closed";
  check: "idle" | "checking" | "finding" | "wrong" | "expired";
  /** Bumped per wrong code, so a second miss shakes again. */
  misses: number;
  os: HostOs | null;
  /** The box's key: the one this Mac pinned, or a restored box's new one. */
  identity: "pinned" | "new";
  route: Route;
  url: string;
  steps: Record<PairStepId, PairStep>;
  box: BoxRun[];
}

type PairAsk =
  | { kind: "code" }
  | { kind: "expired" }
  | { kind: "identity" }
  | { kind: "route" }
  | { kind: "unreachable"; route: Route }
  | { kind: "done" };

type PairReply =
  | { action: "submit"; code: string }
  | { action: "renew" }
  | { action: "back" }
  | { action: "pair"; route: Route; url: string }
  | { action: "retry" }
  | { action: "repair" }
  | { action: "done" };

const COMMAND = "volli-hostd pair";

function freshSteps(): Record<PairStepId, PairStep> {
  return {
    reach: { status: "pending", label: "Reach" },
    verify: { status: "pending", label: "Verify the host key" },
    exchange: { status: "pending", label: "Pair this Mac" },
  };
}

function initialPair(outcome: HostOutcome, tailscale: boolean): PairState {
  return {
    stage: "code",
    check: "idle",
    misses: 0,
    os: null,
    identity: "pinned",
    route: outcome === "url-down" || !tailscale ? "url" : "tailscale",
    url: outcome === "url-down" ? EXAMPLE_URL : "",
    steps: freshSteps(),
    box: [],
  };
}

function routeAddress(route: Route, url: string): string {
  if (route === "tailscale") return TAILNET_NAME;
  if (route === "ssh") return SSH_TARGET;
  return normalizeUrl(url) ?? url;
}

function pairScript(outcome: HostOutcome) {
  return async ({ wait, update, ask }: ScriptIo<PairState, PairAsk, PairReply>) => {
    // Failures are one-shot: once the recovery has been taken, the next
    // attempt behaves as if the person did what it asked.
    const pending = new Set<HostOutcome>([outcome]);
    let box: BoxRun[] = [];
    let ids = 0;
    const setBox = (next: BoxRun[]) => {
      box = next;
      update((state) => ({ ...state, box }));
    };
    const patchRun = (patch: (run: BoxRun) => BoxRun) => {
      const last = box.at(-1);
      if (last) setBox([...box.slice(0, -1), patch(last)]);
    };
    const print = (kind: "dim" | "ok", text: string) =>
      patchRun((run) => ({ ...run, events: [...run.events, { id: (ids += 1), kind, text }] }));
    const step = (id: PairStepId, patch: Partial<PairStep>) =>
      update((state) => ({
        ...state,
        steps: { ...state.steps, [id]: { ...state.steps[id], ...patch } },
      }));

    // The person, on the box, runs the command. An "Expired" ending gives the
    // code a short life so the countdown visibly runs out.
    const runPair = async (code: string) => {
      const ttl = pending.has("expired") ? 25_000 : CODE_TTL_MS;
      setBox([
        ...box,
        { id: (ids += 1), code, typed: 0, output: false, expiresAt: 0, events: [], exited: false },
      ]);
      await wait(320);
      for (let index = 1; index <= COMMAND.length; index += 1) {
        await wait(34);
        patchRun((run) => ({ ...run, typed: index }));
      }
      await wait(260);
      patchRun((run) => ({ ...run, output: true, expiresAt: Date.now() + ttl }));
    };
    await runPair(PAIRING_CODE);

    session: while (true) {
      update((state) => ({ ...state, stage: "code", os: null, steps: freshSteps() }));
      const reply = await ask({ kind: "code" });
      if (reply.action !== "submit") continue;

      update((state) => ({ ...state, check: "checking" }));
      await wait(550);
      const run = box.at(-1);
      if (!run || bareCode(reply.code) !== bareCode(run.code)) {
        update((state) => ({ ...state, check: "wrong", misses: state.misses + 1 }));
        continue;
      }
      if (pending.has("expired") || Date.now() >= run.expiresAt) {
        // The host is the clock: its countdown hits zero and the command exits.
        patchRun((current) => ({
          ...current,
          expiresAt: Math.min(current.expiresAt, Date.now()),
          exited: true,
        }));
        update((state) => ({ ...state, check: "expired" }));
        await ask({ kind: "expired" });
        pending.delete("expired");
        update((state) => ({ ...state, check: "idle" }));
        await runPair(box.length % 2 === 1 ? NEXT_PAIRING_CODE : PAIRING_CODE);
        continue;
      }

      update((state) => ({ ...state, check: "finding" }));
      await wait(900);
      const restored = pending.has("new-identity");
      update((state) => ({
        ...state,
        stage: "found",
        check: "idle",
        os: "linux",
        identity: restored ? "new" : "pinned",
      }));
      if (restored) {
        const answer = await ask({ kind: "identity" });
        if (answer.action !== "repair") continue session;
        pending.delete("new-identity");
      }

      routes: while (true) {
        update((state) => ({ ...state, stage: "found", steps: freshSteps() }));
        const choice = await ask({ kind: "route" });
        if (choice.action === "back") continue session;
        if (choice.action !== "pair") continue;
        const { route, url } = choice;
        // Labels name the place, not the protocol: "hetzner-1.hussain.dev".
        const address = routeAddress(route, url).replace(/^https?:\/\//, "");

        while (true) {
          update((state) => ({ ...state, stage: "pairing", route, url, steps: freshSteps() }));
          step("reach", {
            status: "active",
            label: route === "ssh" ? `Opening a tunnel to ${SSH_TARGET}` : `Reaching ${address}`,
          });
          await wait(1000);
          const down =
            (route === "tailscale" && pending.has("no-tailnet")) ||
            (route === "url" && pending.has("url-down"));
          if (down) {
            step("reach", {
              status: "failed",
              label:
                route === "tailscale" ? "This Mac isn’t on that tailnet" : `Can’t reach ${address}`,
            });
            const answer = await ask({ kind: "unreachable", route });
            if (answer.action === "back") continue routes;
            pending.delete(route === "tailscale" ? "no-tailnet" : "url-down");
            continue;
          }
          step("reach", {
            status: "done",
            label: `Reached over ${route === "url" ? "HTTPS" : route === "ssh" ? "SSH" : "Tailscale"}`,
            detail: route === "ssh" ? "61 ms" : "38 ms",
          });
          print(
            "dim",
            `${MAC_NAME} (${route === "ssh" ? "ssh tunnel" : MAC_TAILNET_IP}) is pairing…`,
          );

          step("verify", { status: "active", label: "Verifying the host key" });
          await wait(750);
          step("verify", { status: "done", label: "Host key verified", detail: SHORT_FINGERPRINT });

          step("exchange", { status: "active", label: "Pairing this Mac" });
          await wait(850);
          step("exchange", {
            status: "done",
            label: `Paired as ${MAC_NAME}`,
            detail: DEVICE_ID.slice(0, 4),
          });
          print("ok", `Paired ${MAC_NAME} · device ${DEVICE_ID}`);
          patchRun((current) => ({ ...current, exited: true }));

          await wait(700);
          update((state) => ({ ...state, stage: "paired" }));
          await ask({ kind: "done" });
          break session;
        }
      }
    }
    update((state) => ({ ...state, stage: "closed" }));
  };
}

function RunningHost({
  outcome,
  tailscale,
  speed,
  runKey,
  typeRequest,
  onReplay,
}: {
  outcome: HostOutcome;
  tailscale: boolean;
  speed: number;
  runKey: string;
  typeRequest: number;
  onReplay: () => void;
}) {
  const script = useScript<PairState, PairAsk, PairReply>(
    () => initialPair(outcome, tailscale),
    pairScript(outcome),
    { speed, key: runKey },
  );
  const { state } = script;
  const run = state.box.at(-1);
  // Closing is the person's, not the script's: it works mid-step, and the box
  // keeps waiting for a device the way the real command would.
  const [dismissed, setDismissed] = React.useState(false);
  const dismiss = React.useCallback(() => setDismissed(true), []);

  return (
    <div className="flex items-start gap-8">
      <div className="flex w-[480px] shrink-0 flex-col">
        <StageCaption>
          <TerminalWindowIcon aria-hidden className="size-3" />
          On the box
        </StageCaption>
        <BoxTerminal
          box={state.box}
          tailscale={tailscale}
          // The box prints its own key; a restored box has a new one from the start.
          identity={outcome === "new-identity" ? "new" : "pinned"}
        />
      </div>
      <div className="flex w-[540px] shrink-0 flex-col">
        <StageCaption>
          <LaptopIcon aria-hidden className="size-3" />
          This Mac
        </StageCaption>
        <AnimatePresence mode="popLayout">
          {state.stage === "closed" || dismissed ? (
            <motion.div
              key="closed"
              className="grid h-48 place-items-center rounded-container border border-dashed border-border"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, delay: 0.15 }}
            >
              <button
                type="button"
                onClick={onReplay}
                className="rounded-full bg-foreground px-2.5 py-1 text-[11px] text-background"
              >
                Replay
              </button>
            </motion.div>
          ) : (
            <InlineSheet key="sheet" label="Pair with a code" width={540} onClose={dismiss}>
              <PairSheet
                onCancel={dismiss}
                state={state}
                question={script.question}
                answer={script.answer}
                tailscale={tailscale}
                currentCode={run?.code ?? PAIRING_CODE}
                outcome={outcome}
                typeRequest={typeRequest}
              />
            </InlineSheet>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ── The box ────────────────────────────────────────────────────────────── */

function BoxTerminal({
  box,
  tailscale,
  identity,
}: {
  box: readonly BoxRun[];
  tailscale: boolean;
  identity: "pinned" | "new";
}) {
  const last = box.at(-1);
  const scrollKey = `${box.length}:${last?.output ? 1 : 0}:${last?.events.length ?? 0}:${last?.exited ? 1 : 0}`;
  return (
    <TerminalWindow title={`ssh ${HOST}`} className="h-[468px]" scrollKey={scrollKey}>
      <p className="text-white/35">Last login: Sat Oct 4 21:14:07 2025 from {MAC_TAILNET_IP}</p>
      {box.map((run, index) => (
        <BoxRunView
          key={run.id}
          run={run}
          tailscale={tailscale}
          identity={identity}
          live={index === box.length - 1}
        />
      ))}
    </TerminalWindow>
  );
}

function Prompt() {
  return (
    <span className="text-white/35 select-none">
      <span className="text-[#5fd38d]/80">hussain@{HOST}</span>:~${" "}
    </span>
  );
}

function Cursor() {
  return (
    <span className="ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-white/70 [animation-duration:1s]" />
  );
}

/** The output block appears in beats, the way a CLI prints it. */
function Beat({
  index,
  children,
  className,
}: {
  index: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18, ease: EASE_OUT, delay: index * 0.07 }}
    >
      {children}
    </motion.div>
  );
}

function BoxRunView({
  run,
  tailscale,
  identity,
  live,
}: {
  run: BoxRun;
  tailscale: boolean;
  identity: "pinned" | "new";
  live: boolean;
}) {
  const now = useNow(1000);
  const remaining = run.expiresAt - now;
  const paired = run.events.some((event) => event.kind === "ok");
  const expired = run.output && remaining <= 0 && !paired;
  const full = identity === "new" ? NEW_HOST_KEY_FINGERPRINT : HOST_KEY_FINGERPRINT;
  const short = identity === "new" ? NEW_SHORT_FINGERPRINT : SHORT_FINGERPRINT;
  const typing = run.typed < COMMAND.length;
  const done = run.exited || expired;

  return (
    <div className="mt-1">
      <div className="text-white/90">
        <Prompt />
        {COMMAND.slice(0, run.typed)}
        {typing && live ? <Cursor /> : null}
      </div>
      {run.output ? (
        <div className="pb-1">
          <Beat index={0} className="mt-1">
            Volli host {APP_VERSION} · {HOST} · {LINUX.system}
          </Beat>
          <Beat index={1} className="my-3 flex items-center gap-4">
            <div
              className={cn("transition-opacity duration-300", (expired || paired) && "opacity-25")}
            >
              <QrCode payload={`${run.code}:${full}`} size={104} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-white/45">Pairing code</span>
              <CodeGroups
                code={run.code}
                className={cn(
                  "text-heading font-semibold text-white transition-colors duration-300",
                  paired && "text-white/40",
                  expired && "text-white/30 line-through decoration-white/30",
                )}
              />
              <span className={cn("tabular-nums", expired ? "text-[#ff7b72]" : "text-white/45")}>
                {expired ? "Expired" : paired ? "Used" : `Expires in ${formatRemaining(remaining)}`}
              </span>
            </div>
          </Beat>
          <Beat index={2} className="text-white/45">
            Reachable at
          </Beat>
          <Beat index={3} className="pl-4">
            {tailscale ? (
              <div className="flex gap-4">
                <span className="w-56 truncate text-white/85">{TAILNET_NAME}</span>
                <span className="text-white/35">tailscale</span>
              </div>
            ) : null}
            <div className="flex gap-4">
              <span className="w-56 truncate text-white/85">{SSH_TARGET}</span>
              <span className="text-white/35">ssh</span>
            </div>
          </Beat>
          <Beat index={4} className="mt-2 flex gap-4">
            <span className="text-white/45">Host key</span>
            <span className="min-w-0 truncate" title={full}>
              <span className="text-white/85">{short}</span>
              <span className="text-white/30"> {fingerprintTail(full)}</span>
            </span>
          </Beat>
          <Beat index={5} className="mt-2">
            {run.events.map((event) => (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.18, ease: EASE_OUT }}
                className={cn(event.kind === "ok" ? "text-[#5fd38d]" : "text-white/45")}
              >
                {event.kind === "ok" ? "✓ " : "· "}
                {event.text}
              </motion.div>
            ))}
            {expired ? (
              <motion.div
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.18, ease: EASE_OUT }}
                className="text-[#ff7b72]"
              >
                ✕ Code expired
              </motion.div>
            ) : null}
            {done ? null : (
              <div className="text-white/45">
                <TerminalSpinner className="text-white/70" /> Waiting for a device…
              </div>
            )}
          </Beat>
          {done && live ? (
            <motion.div
              className="mt-1 text-white/90"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.12, delay: 0.2 }}
            >
              <Prompt />
              <Cursor />
            </motion.div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** `SHA256:q3Zt9fK1x0mVbE7c…` → `bE7c Rw2L hP8s…`: the part after the short form, dimmer. */
function fingerprintTail(full: string): string {
  const body = full.replace(/^SHA256:/, "").slice(12, 24);
  return `${body.match(/.{1,4}/g)?.join(" ") ?? body}…`;
}

/* ── The sheet ──────────────────────────────────────────────────────────── */

function Footer({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 border-t border-border/60 px-4 py-4", className)}>
      {children}
    </div>
  );
}

function SheetHeader({
  os,
  badge,
  heading,
  subtitle,
}: {
  os: HostOs | null;
  badge: GlyphBadge;
  heading: string;
  subtitle?: string | null;
}) {
  return (
    <div className="flex items-center gap-4 px-6 pt-6 pb-4">
      <HostGlyph os={os} size="md" badge={badge} />
      <div className="min-w-0 pr-8">
        <h2 className="text-heading font-semibold">
          <SwapText>{heading}</SwapText>
        </h2>
        <AnimatePresence initial={false}>
          {subtitle ? (
            <motion.p
              key="subtitle"
              className="flex text-ui text-muted-foreground"
              initial={{ opacity: 0, y: 4, filter: "blur(2px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: EASE_OUT, delay: 0.08 }}
            >
              <SwapText className="min-w-0">{subtitle}</SwapText>
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function PairSheet({
  onCancel,
  state,
  question,
  answer,
  tailscale,
  currentCode,
  outcome,
  typeRequest,
}: {
  state: PairState;
  question: PairAsk | null;
  answer: (reply: PairReply) => void;
  tailscale: boolean;
  currentCode: string;
  outcome: HostOutcome;
  typeRequest: number;
  onCancel: () => void;
}) {
  const [code, setCode] = React.useState("");
  // Lives above the code screen so Back to it doesn't re-send the same code.
  const lastSubmitted = React.useRef<string | null>(null);
  const [route, setRoute] = React.useState<Route>(state.route);
  const [url, setUrl] = React.useState(state.url);
  const [forwarding, setForwarding] = React.useState(defaultForwarding);

  const failedStep = PAIR_STEPS.find((id) => state.steps[id].status === "failed");
  const badge: GlyphBadge =
    state.stage === "paired"
      ? "ok"
      : failedStep
        ? "fail"
        : question?.kind === "identity"
          ? "attention"
          : null;
  const heading =
    state.stage === "paired"
      ? `${HOST} is paired`
      : question?.kind === "identity"
        ? `${HOST} has a new identity`
        : state.os
          ? HOST
          : "Pair with a code";
  const fingerprint =
    state.identity === "new"
      ? { short: NEW_SHORT_FINGERPRINT, full: NEW_HOST_KEY_FINGERPRINT }
      : { short: SHORT_FINGERPRINT, full: HOST_KEY_FINGERPRINT };

  let body: React.ReactNode;
  let screen: string;
  if (state.stage === "code") {
    screen = "code";
    body = (
      <CodeBody
        state={state}
        question={question}
        answer={answer}
        code={code}
        setCode={setCode}
        lastSubmitted={lastSubmitted}
        onCancel={onCancel}
        currentCode={currentCode}
        outcome={outcome}
        typeRequest={typeRequest}
      />
    );
  } else if (question?.kind === "identity") {
    screen = "identity";
    body = (
      <>
        <div className="flex flex-col gap-2 px-6 pb-4">
          <p className="text-ui text-muted-foreground">
            It was restored or reinstalled. Devices paired before must pair again.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 font-mono text-ui">
            <dt className="text-muted-foreground">Pinned</dt>
            <dd className="text-muted-foreground line-through decoration-muted-foreground/50">
              {SHORT_FINGERPRINT}
            </dd>
            <dt className="text-muted-foreground">Now</dt>
            <dd className="text-foreground">{NEW_SHORT_FINGERPRINT}</dd>
          </dl>
        </div>
        <Footer>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => answer({ action: "back" })}>
            Back
          </Button>
          <Button size="sm" autoFocus onClick={() => answer({ action: "repair" })}>
            Pair again
          </Button>
        </Footer>
      </>
    );
  } else if (state.stage === "found") {
    screen = "route";
    const target = normalizeUrl(url);
    const ready = route !== "url" || target !== null;
    const submit = () => {
      if (ready && question?.kind === "route")
        answer({ action: "pair", route, url: target ?? url });
    };
    body = (
      <>
        <div className="px-6 pb-4">
          <SheetLabel>Reach {HOST}</SheetLabel>
          <RouteChoice
            value={route}
            onChange={setRoute}
            tailnet={tailscale ? TAILNET_NAME : null}
            url={url}
            onUrl={setUrl}
            onSubmit={submit}
          />
        </div>
        <Footer>
          <FingerprintTag short={fingerprint.short} full={fingerprint.full} />
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => answer({ action: "back" })}>
            Back
          </Button>
          <Button size="sm" disabled={!ready || question?.kind !== "route"} onClick={submit}>
            Pair
          </Button>
        </Footer>
      </>
    );
  } else if (state.stage === "pairing") {
    screen = "pairing";
    const blocked = question?.kind === "unreachable" ? question.route : null;
    body = (
      <>
        <ol className="flex flex-col px-6 pb-4">
          {PAIR_STEPS.map((id) => {
            const current = state.steps[id];
            return (
              <li key={id} className="flex h-8 items-center gap-2">
                <StepMark status={current.status} />
                <SwapText
                  className={cn(
                    "min-w-0 flex-1 text-ui transition-colors duration-200",
                    current.status === "pending" ? "text-muted-foreground" : "text-foreground",
                    current.status === "done" && "text-foreground/90",
                  )}
                >
                  {current.status === "active" ? `${current.label}…` : current.label}
                </SwapText>
                {current.detail ? (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2 }}
                    className="shrink-0 font-mono text-ui text-muted-foreground tabular-nums"
                  >
                    {current.detail}
                  </motion.span>
                ) : null}
              </li>
            );
          })}
        </ol>
        <Footer>
          <FingerprintTag short={fingerprint.short} full={fingerprint.full} />
          <span className="flex-1" />
          {blocked ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => answer({ action: "back" })}>
                Back
              </Button>
              <Button size="sm" autoFocus onClick={() => answer({ action: "retry" })}>
                {blocked === "tailscale" ? "Open Tailscale" : "Try again"}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Footer>
      </>
    );
  } else {
    screen = "paired";
    body = (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: EASE_OUT, delay: 0.12 }}
      >
        <div className="px-6 pb-4">
          <SheetLabel>Use this Mac’s sign-ins</SheetLabel>
          <ForwardRows host={HOST} value={forwarding} onChange={setForwarding} />
        </div>
        <Footer>
          <FingerprintTag short={fingerprint.short} full={fingerprint.full} />
          <span className="flex-1" />
          <Button size="sm" autoFocus onClick={() => answer({ action: "done" })}>
            Done
          </Button>
        </Footer>
      </motion.div>
    );
  }

  return (
    <AutoHeight>
      <SheetHeader
        os={state.os}
        badge={badge}
        heading={heading}
        subtitle={
          state.stage === "paired"
            ? `${ROUTE_NAME[state.route]} · ${routeAddress(state.route, state.url)}`
            : state.os
              ? HOST_SUMMARY
              : null
        }
      />
      <AnimatePresence initial={false} mode="popLayout">
        <Screen key={screen}>{body}</Screen>
      </AnimatePresence>
    </AutoHeight>
  );
}

function CodeBody({
  state,
  question,
  answer,
  code,
  setCode,
  lastSubmitted,
  onCancel,
  currentCode,
  outcome,
  typeRequest,
}: {
  state: PairState;
  question: PairAsk | null;
  answer: (reply: PairReply) => void;
  code: string;
  setCode: (code: string) => void;
  lastSubmitted: React.RefObject<string | null>;
  onCancel: () => void;
  currentCode: string;
  outcome: HostOutcome;
  typeRequest: number;
}) {
  const reduced = useReducedMotion();
  // A miss stays on screen (red, shaken) until the person edits the code.
  const [editedSinceMiss, setEditedSinceMiss] = React.useState(false);
  React.useEffect(() => setEditedSinceMiss(false), [state.misses]);

  const asking = question?.kind === "code";
  const busy = state.check === "checking" || state.check === "finding";
  const expired = question?.kind === "expired";
  const invalid = state.check === "wrong" && !editedSinceMiss;

  const submit = React.useCallback(
    (value: string) => {
      if (value.length !== 12 || !asking) return;
      lastSubmitted.current = value;
      answer({ action: "submit", code: value });
    },
    [answer, asking, lastSubmitted],
  );

  // Twelve characters is the whole code: submit without a click. The same
  // wrong code is not re-sent until it changes.
  React.useEffect(() => {
    if (code.length === 12 && code !== lastSubmitted.current) submit(code);
  }, [code, submit, lastSubmitted]);

  // Lab: the person types what the box printed (a near miss on "Wrong code").
  // Only a request made while this screen is up types — not one replayed by a
  // remount (Back, Replay, a new outcome).
  const seenRequest = React.useRef(typeRequest);
  React.useEffect(() => {
    if (typeRequest === seenRequest.current) return;
    seenRequest.current = typeRequest;
    const target = bareCode(
      outcome === "wrong-code" && state.misses === 0 ? MISTYPED_CODE : currentCode,
    );
    lastSubmitted.current = null;
    if (reduced) {
      setCode(target);
      return;
    }
    let index = 0;
    setCode("");
    const id = setInterval(() => {
      index += 1;
      setCode(target.slice(0, index));
      if (index >= target.length) clearInterval(id);
    }, 70);
    return () => clearInterval(id);
    // Only a new request types; the code it types is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeRequest]);

  const status =
    state.check === "checking"
      ? { tone: "run" as const, text: "Checking the code…" }
      : state.check === "finding"
        ? { tone: "run" as const, text: `Finding ${HOST}…` }
        : invalid
          ? { tone: "fail" as const, text: "That code didn’t match" }
          : expired
            ? { tone: "fail" as const, text: "That code expired" }
            : null;

  return (
    <>
      <div className="flex flex-col items-center px-6 pt-2 pb-4">
        <CodeInput
          // A fresh run on the box is a fresh field: it takes focus again.
          key={state.box.length}
          autoFocus
          value={code}
          invalid={invalid}
          disabled={busy || expired}
          onChange={(next) => {
            setCode(next);
            setEditedSinceMiss(true);
          }}
        />
        <div className="mt-2 flex h-5 items-center justify-center">
          <AnimatePresence initial={false} mode="popLayout">
            {status ? (
              <motion.span
                key={status.text}
                className={cn(
                  "inline-flex items-center gap-2 text-ui",
                  status.tone === "fail" ? "text-destructive" : "text-muted-foreground",
                )}
                initial={{ opacity: 0, y: 4, filter: "blur(2px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -4, filter: "blur(2px)" }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
              >
                {status.tone === "run" ? <StepMark status="active" /> : null}
                {status.text}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
      <div className="px-6 pb-4">
        <CommandLine command={COMMAND} />
      </div>
      <Footer>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {expired ? (
          <Button
            size="sm"
            autoFocus
            onClick={() => {
              setCode("");
              lastSubmitted.current = null;
              answer({ action: "renew" });
            }}
          >
            Enter a new code
          </Button>
        ) : (
          <Button size="sm" disabled={code.length !== 12 || !asking} onClick={() => submit(code)}>
            Continue
          </Button>
        )}
      </Footer>
    </>
  );
}

/* ══ Flow 3 · a phone ═══════════════════════════════════════════════════════ */

type PhoneScreen = "scan" | "locked" | "confirm" | "waiting" | "paired" | "denied";

interface PhoneState {
  desk: "qr" | "approve" | "paired" | "closed";
  phone: PhoneScreen;
  code: string;
  expiresAt: number;
  devices: (PairedDevice & { fresh?: boolean })[];
}

type PhoneAsk = { kind: "confirm" } | { kind: "approve" } | { kind: "denied" } | { kind: "done" };
type PhoneReply =
  | { action: "pair" }
  | { action: "cancel" }
  | { action: "allow" }
  | { action: "deny" }
  | { action: "again" }
  | { action: "another" }
  | { action: "done" };

const PAIRED_BEFORE = DEVICES.filter((device) => device.kind !== "phone");

function initialPhone(): PhoneState {
  return {
    desk: "qr",
    phone: "scan",
    code: PAIRING_CODE,
    expiresAt: Date.now() + CODE_TTL_MS,
    devices: [...PAIRED_BEFORE],
  };
}

function phoneScript() {
  return async ({ wait, update, ask }: ScriptIo<PhoneState, PhoneAsk, PhoneReply>) => {
    let codes = 0;
    const freshCode = () => {
      codes += 1;
      return {
        code: codes % 2 === 1 ? NEXT_PAIRING_CODE : PAIRING_CODE,
        expiresAt: Date.now() + CODE_TTL_MS,
      };
    };
    while (true) {
      update((state) => ({ ...state, phone: "scan" }));
      await wait(2200);
      update((state) => ({ ...state, phone: "locked" }));
      await wait(550);
      update((state) => ({ ...state, phone: "confirm" }));
      const confirm = await ask({ kind: "confirm" });
      if (confirm.action !== "pair") continue;

      update((state) => ({ ...state, phone: "waiting" }));
      await wait(700);
      update((state) => ({ ...state, desk: "approve" }));
      const decision = await ask({ kind: "approve" });
      if (decision.action === "deny") {
        // A denied code is spent; the Mac shows a fresh one.
        const next = freshCode();
        update((state) => ({ ...state, desk: "qr", phone: "denied", ...next }));
        await ask({ kind: "denied" });
        continue;
      }

      update((state) => {
        // Pairing the same phone again replaces its row rather than adding one.
        const others = state.devices.filter((device) => device.id !== PHONE_ID);
        return {
          ...state,
          desk: "paired",
          devices: [
            ...others.slice(0, 1),
            {
              id: PHONE_ID,
              name: PHONE_NAME,
              kind: "phone",
              paired: "Today",
              lastSeen: "Now",
              fresh: true,
            },
            ...others.slice(1),
          ],
        };
      });
      await wait(300);
      update((state) => ({ ...state, phone: "paired" }));
      const after = await ask({ kind: "done" });
      if (after.action === "another") {
        const next = freshCode();
        update((state) => ({ ...initialPhone(), devices: state.devices, ...next }));
        continue;
      }
      update((state) => ({ ...state, desk: "closed" }));
      return;
    }
  };
}

function PhonePairing({
  route,
  speed,
  runKey,
  onTurnOnTailscale,
  onReplay,
}: {
  route: PhoneRoute;
  speed: number;
  runKey: string;
  onTurnOnTailscale: () => void;
  onReplay: () => void;
}) {
  const blocked = route === "ssh";
  const script = useScript<PhoneState, PhoneAsk, PhoneReply>(initialPhone, phoneScript(), {
    speed,
    key: runKey,
    autostart: !blocked,
  });
  const { state, question, answer } = script;
  const [dismissed, setDismissed] = React.useState(false);
  const dismiss = React.useCallback(() => setDismissed(true), []);

  return (
    <div className="flex items-start gap-12">
      <div className="flex w-[440px] shrink-0 flex-col">
        <StageCaption>
          <LaptopIcon aria-hidden className="size-3" />
          This Mac
        </StageCaption>
        <AnimatePresence mode="popLayout">
          {state.desk === "closed" || dismissed ? (
            <motion.div
              key="closed"
              className="grid h-48 place-items-center rounded-container border border-dashed border-border"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, delay: 0.15 }}
            >
              <button
                type="button"
                onClick={onReplay}
                className="rounded-full bg-foreground px-2.5 py-1 text-[11px] text-background"
              >
                Replay
              </button>
            </motion.div>
          ) : (
            <InlineSheet
              key="sheet"
              label={`Pair a phone with ${HOST}`}
              width={440}
              onClose={dismiss}
            >
              {blocked ? (
                <PhoneBlocked onTurnOn={onTurnOnTailscale} />
              ) : (
                <DeskPhoneSheet
                  state={state}
                  question={question}
                  answer={answer}
                  onCancel={dismiss}
                />
              )}
            </InlineSheet>
          )}
        </AnimatePresence>
      </div>
      <div className="flex shrink-0 flex-col">
        <StageCaption>
          <DeviceMobileIcon aria-hidden className="size-3" />
          {PHONE_NAME}
        </StageCaption>
        <Phone
          screen={blocked ? "scan" : state.phone}
          code={state.code}
          hasCode={!blocked && state.desk === "qr"}
          question={blocked ? null : question}
          answer={answer}
        />
      </div>
    </div>
  );
}

/* ── The Mac's half ─────────────────────────────────────────────────────── */

function PhoneBlocked({ onTurnOn }: { onTurnOn: () => void }) {
  return (
    <>
      <SheetHeader
        os="linux"
        badge="attention"
        heading={`Pair a phone with ${HOST}`}
        subtitle={`SSH · ${SSH_TARGET}`}
      />
      <p className="px-6 pb-4 text-ui text-muted-foreground">
        Phones reach {HOST} over Tailscale or HTTPS.
      </p>
      <Footer>
        <span className="flex-1" />
        <Button size="sm" autoFocus onClick={onTurnOn}>
          Turn on Tailscale…
        </Button>
      </Footer>
    </>
  );
}

function DeskPhoneSheet({
  state,
  question,
  answer,
  onCancel,
}: {
  state: PhoneState;
  question: PhoneAsk | null;
  answer: (reply: PhoneReply) => void;
  onCancel: () => void;
}) {
  const now = useNow(1000);
  const heading =
    state.desk === "approve"
      ? `${PHONE_NAME} wants to pair`
      : state.desk === "paired"
        ? `${PHONE_NAME} is paired`
        : `Pair a phone with ${HOST}`;

  let body: React.ReactNode;
  if (state.desk === "approve") {
    body = (
      <>
        <div className="px-6 pb-4">
          <div className="flex items-center gap-2 rounded-row border border-border/70 bg-muted/30 p-2">
            <DeviceGlyph kind="phone" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium">{PHONE_NAME}</span>
              <span className="block truncate font-mono text-ui text-muted-foreground">
                iPhone · {PHONE_TAILNET_IP}
              </span>
            </span>
          </div>
          <p className="px-2 pt-2 text-ui text-muted-foreground">
            It can start and steer sessions on {HOST}.
          </p>
        </div>
        <Footer>
          <span className="flex-1" />
          {/* Allow is deliberately not autofocused: an approval is never one stray Return away. */}
          <Button size="sm" variant="ghost" onClick={() => answer({ action: "deny" })}>
            Deny
          </Button>
          <Button
            size="sm"
            disabled={question?.kind !== "approve"}
            onClick={() => answer({ action: "allow" })}
          >
            Allow
          </Button>
        </Footer>
      </>
    );
  } else if (state.desk === "paired") {
    body = (
      <>
        <div className="px-6 pb-4">
          <SheetLabel>Paired devices</SheetLabel>
          <ul className="rounded-row border border-border/70 bg-muted/30 p-1">
            <AnimatePresence initial={false}>
              {state.devices.map((device) => (
                <DeviceRow key={device.id} device={device} />
              ))}
            </AnimatePresence>
          </ul>
        </div>
        <Footer>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={question?.kind !== "done"}
            onClick={() => answer({ action: "another" })}
          >
            Pair another
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            autoFocus
            disabled={question?.kind !== "done"}
            onClick={() => answer({ action: "done" })}
          >
            Done
          </Button>
        </Footer>
      </>
    );
  } else {
    const remaining = state.expiresAt - now;
    body = (
      <>
        <div className="flex flex-col items-center px-6 pt-2 pb-6">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={state.code}
              className="rounded-[20px] bg-white p-2 shadow-raised ring-1 ring-black/5"
              initial={{ opacity: 0, scale: 0.96, filter: "blur(4px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.98, filter: "blur(4px)" }}
              transition={{ duration: 0.26, ease: EASE_OUT }}
            >
              <QrCode payload={`${state.code}:${HOST_KEY_FINGERPRINT}`} size={188} />
            </motion.div>
          </AnimatePresence>
          <SwapText className="mt-4 font-mono text-heading font-semibold tracking-wider">
            {state.code}
          </SwapText>
          <span className="text-ui text-muted-foreground tabular-nums">
            {remaining > 0 ? `Expires in ${formatRemaining(remaining)}` : "Expired"}
          </span>
        </div>
        <Footer>
          <span className="inline-flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
            <ArrowsLeftRightIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{TAILNET_NAME}</span>
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </Footer>
      </>
    );
  }

  return (
    <AutoHeight>
      <SheetHeader os="linux" badge={state.desk === "paired" ? "ok" : null} heading={heading} />
      <AnimatePresence initial={false} mode="popLayout">
        <Screen key={state.desk}>{body}</Screen>
      </AnimatePresence>
    </AutoHeight>
  );
}

function DeviceRow({ device }: { device: PairedDevice & { fresh?: boolean } }) {
  return (
    <motion.li
      layout
      className="relative flex items-center gap-2 overflow-hidden rounded-[12px] px-2 py-2"
      initial={device.fresh ? { opacity: 0, y: -6, filter: "blur(3px)" } : false}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.28, ease: EASE_OUT, delay: device.fresh ? 0.25 : 0 }}
    >
      {device.fresh ? (
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-[inherit] bg-accent"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.2, ease: "easeOut", delay: 0.6 }}
        />
      ) : null}
      <DeviceGlyph kind={device.kind} className="relative" />
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-ui font-medium">{device.name}</span>
        <span className="block truncate text-ui text-muted-foreground">
          {device.thisDevice ? "This Mac" : `Paired ${device.paired}`}
        </span>
      </span>
      <span className="relative text-ui text-muted-foreground">{device.lastSeen}</span>
    </motion.li>
  );
}

/* ── The phone's half ───────────────────────────────────────────────────── */

function Phone({
  screen,
  code,
  hasCode,
  question,
  answer,
}: {
  screen: PhoneScreen;
  code: string;
  hasCode: boolean;
  question: PhoneAsk | null;
  answer: (reply: PhoneReply) => void;
}) {
  const sheetOpen = screen !== "scan" && screen !== "locked";
  return (
    <PhoneFrame ink="light" homeInk={sheetOpen ? "dark" : "light"}>
      <Camera screen={screen} code={code} hasCode={hasCode} dimmed={sheetOpen} />
      <AnimatePresence>
        {sheetOpen ? (
          <motion.div
            key="sheet"
            className="absolute inset-x-0 bottom-0 z-10 rounded-t-[30px] bg-background px-6 pt-6 pb-10 text-foreground"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%", transition: { duration: 0.2, ease: EASE_OUT } }}
            transition={{ duration: 0.34, ease: EASE_SWIFT }}
          >
            <AutoHeight duration={0.28}>
              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  key={screen}
                  initial={{ opacity: 0, y: 6, filter: "blur(2px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                  transition={{ duration: 0.24, ease: EASE_OUT, delay: 0.04 }}
                >
                  <PhoneSheet screen={screen} question={question} answer={answer} />
                </motion.div>
              </AnimatePresence>
            </AutoHeight>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </PhoneFrame>
  );
}

function PhoneSheet({
  screen,
  question,
  answer,
}: {
  screen: PhoneScreen;
  question: PhoneAsk | null;
  answer: (reply: PhoneReply) => void;
}) {
  if (screen === "confirm") {
    return (
      <div className="flex flex-col items-center text-center">
        <HostGlyph os="linux" size="lg" />
        <h3 className="mt-4 text-heading font-semibold">Pair with {HOST}?</h3>
        <p className="truncate font-mono text-ui text-muted-foreground">{TAILNET_NAME}</p>
        <span className="mt-2 inline-flex items-center gap-1 font-mono text-ui text-muted-foreground">
          <KeyIcon aria-hidden className="size-3.5" />
          {SHORT_FINGERPRINT}
        </span>
        <div className="mt-6 flex w-full flex-col gap-2">
          <Button
            size="lg"
            className="w-full"
            disabled={question?.kind !== "confirm"}
            onClick={() => answer({ action: "pair" })}
          >
            Pair
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="w-full"
            disabled={question?.kind !== "confirm"}
            onClick={() => answer({ action: "cancel" })}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (screen === "waiting") {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <DeviceGlyph kind="mac" size="md" />
        <h3 className="mt-4 text-heading font-semibold">Allow on your Mac</h3>
        <span className="mt-1 inline-flex items-center gap-2 text-ui text-muted-foreground">
          <StepMark status="active" />
          {MAC_NAME}
        </span>
      </div>
    );
  }
  if (screen === "paired") {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <HostGlyph os="linux" size="lg" badge="ok" />
        <h3 className="mt-4 text-heading font-semibold">Paired with {HOST}</h3>
        <p className="font-mono text-ui text-muted-foreground">{SHORT_FINGERPRINT}</p>
      </div>
    );
  }
  // Denied.
  return (
    <div className="flex flex-col items-center text-center">
      <HostGlyph os="linux" size="lg" badge="fail" />
      <h3 className="mt-4 text-heading font-semibold">Not allowed</h3>
      <p className="text-ui text-muted-foreground">{MAC_NAME} said no</p>
      <Button
        size="lg"
        className="mt-6 w-full"
        disabled={question?.kind !== "denied"}
        onClick={() => answer({ action: "again" })}
      >
        Scan again
      </Button>
    </div>
  );
}

/**
 * The camera, pointed at the Mac: the sheet's QR seen through glass — tilted,
 * soft, drifting with the hand — until the brackets find it and it snaps sharp.
 */
function Camera({
  screen,
  code,
  hasCode,
  dimmed,
}: {
  screen: PhoneScreen;
  code: string;
  hasCode: boolean;
  dimmed: boolean;
}) {
  const reduced = useReducedMotion();
  const locked = screen !== "scan";
  return (
    <motion.div
      className="absolute inset-0"
      animate={{ opacity: dimmed ? 0.45 : 1, filter: dimmed ? "blur(6px)" : "blur(0px)" }}
      transition={{ duration: 0.3, ease: EASE_OUT }}
    >
      {/* The room: a dark desk, the Mac's display a soft glow in it. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_48%,#26262b_0%,#111114_55%,#050506_100%)]" />
      <div className="absolute top-[22%] left-1/2 h-[52%] w-[130%] -translate-x-1/2 rotate-[-3deg] rounded-[22px] bg-white/[0.06] shadow-[0_0_80px_rgba(255,255,255,0.06)] ring-1 ring-white/10" />
      <div className="absolute inset-x-0 top-14 z-10 text-center text-sm font-semibold text-white">
        Scan pairing code
      </div>

      {hasCode ? (
        <motion.div
          className="absolute top-1/2 left-1/2 -mt-[64px] -ml-[64px]"
          animate={
            locked || reduced
              ? { x: 0, y: 0, rotate: -3, filter: "blur(0px)" }
              : {
                  x: [0, 3, -2, 1, 0],
                  y: [0, -2, 2, -1, 0],
                  rotate: [-3, -2, -4, -3, -3],
                  filter: "blur(1.2px)",
                }
          }
          transition={
            locked || reduced
              ? { duration: 0.2, ease: EASE_OUT }
              : { duration: 3.2, ease: "easeInOut", repeat: Infinity }
          }
        >
          <QrCode payload={`${code}:${HOST_KEY_FINGERPRINT}`} size={128} />
        </motion.div>
      ) : null}

      {/* The viewfinder: four corners that close on the code once it reads. */}
      <motion.div
        className="absolute top-1/2 left-1/2 size-[184px] -translate-x-1/2 -translate-y-1/2"
        animate={{ scale: locked && hasCode ? 0.8 : 1 }}
        transition={{ duration: 0.26, ease: EASE_OUT }}
      >
        {(["tl", "tr", "bl", "br"] as const).map((corner) => (
          <span
            key={corner}
            className={cn(
              "absolute size-8 border-[3px] transition-colors duration-200",
              locked && hasCode ? "border-[#ffd60a]" : "border-white/85",
              corner === "tl" && "top-0 left-0 rounded-tl-[14px] border-r-0 border-b-0",
              corner === "tr" && "top-0 right-0 rounded-tr-[14px] border-b-0 border-l-0",
              corner === "bl" && "bottom-0 left-0 rounded-bl-[14px] border-t-0 border-r-0",
              corner === "br" && "right-0 bottom-0 rounded-br-[14px] border-t-0 border-l-0",
            )}
          />
        ))}
      </motion.div>

      <AnimatePresence>
        {screen === "locked" ? (
          <motion.div
            key="flash"
            className="absolute inset-0 bg-white"
            initial={{ opacity: 0.35 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
          />
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
