/**
 * Signing in ON the host (VC-615 flow 4, the alternative to sending this
 * Mac's sign-ins). A headless box has no browser, so a subscription or GitHub
 * sign-in is a device-code flow: the host asks the provider for a code, this
 * Mac opens the provider's page, you approve there, and the row on the box
 * turns signed-in by itself. An API key is pasted here and stored only there.
 *
 * The rows are the same object in every direction the scratch compares, so a
 * row knows how to do both — send from this Mac, or sign in on the host — and
 * the direction decides which it offers.
 */
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Segmented } from "@renderer/components/ui/segmented";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";

import type { SignIn } from "./fixtures";
import { EASE_OUT, ProviderMark, StepMark, SwapText } from "./parts";
import { signInMeta } from "./sign-in-rows";

/** Where a sign-in on the host comes from. */
export type Source = "mac" | "host";

export type RowState =
  | { kind: "off" }
  | { kind: "mac" }
  | { kind: "host-none" }
  | { kind: "host-code"; code: string; opened: boolean }
  | { kind: "host-key" }
  | { kind: "host-ok"; account: string }
  | { kind: "expired" };

const PROVIDER_PAGE: Record<string, string> = {
  anthropic: "claude.ai",
  openai: "chatgpt.com",
  github: "github.com/login/device",
};

export const DEVICE_CODES: Record<string, string> = {
  anthropic: "WDJB-MJHT",
  openai: "KQ4P-7XRN",
  github: "C2F9-81B4",
};

export function usesKey(signIn: SignIn): boolean {
  return signIn.kind === "API key";
}

/** One sign-in, as a row; its sign-in steps open beneath it. */
export function SignInRow({
  signIn,
  host,
  state,
  onBegin,
  onChange,
  trailing,
  inlineBegin = false,
}: {
  signIn: SignIn;
  host: string;
  state: RowState;
  onBegin: () => void;
  onChange: (state: RowState) => void;
  /** A direction's own control (a switch, a segmented choice). */
  trailing?: React.ReactNode;
  /**
   * Offer "Sign in" inside the status line instead of as a button, for rows
   * whose trailing slot is already a control — two pills side by side read as
   * two decisions.
   */
  inlineBegin?: boolean;
}) {
  const status = statusLine(signIn, state, host);
  const open = state.kind === "host-code" || state.kind === "host-key";
  return (
    <div
      className={cn(
        "rounded-[12px] transition-colors duration-150",
        open && "bg-background shadow-raised",
      )}
    >
      <div className="flex items-center gap-2 px-2 py-2">
        <ProviderMark id={signIn.id} name={signIn.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium">{signIn.name}</div>
          <div
            className={cn(
              "flex items-center gap-1 truncate text-ui",
              state.kind === "expired" ? "text-attention" : "text-muted-foreground",
            )}
          >
            {state.kind === "host-ok" ? (
              <CheckIcon weight="bold" className="size-3 text-positive" />
            ) : null}
            <SwapText>
              {inlineBegin && state.kind === "host-none" ? "Not signed in" : status}
            </SwapText>
            {inlineBegin && state.kind === "host-none" ? (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={onBegin}
                  className="font-medium text-primary-text underline-offset-4 hover:underline"
                >
                  Sign in
                </button>
              </>
            ) : null}
          </div>
        </div>
        {trailing}
        {(state.kind === "host-none" && !inlineBegin) || state.kind === "expired" ? (
          <Button
            size="sm"
            variant={state.kind === "expired" ? "default" : "secondary"}
            onClick={onBegin}
          >
            {state.kind === "expired" ? "Sign in again" : "Sign in"}
          </Button>
        ) : null}
        {open ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => onChange({ kind: "host-none" })}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="px-2 pt-1 pb-4 pl-10">
              {state.kind === "host-code" ? (
                <DeviceCode
                  page={PROVIDER_PAGE[signIn.id] ?? "the provider"}
                  code={state.code}
                  opened={state.opened}
                  onOpen={() => onChange({ ...state, opened: true })}
                />
              ) : (
                <KeyEntry
                  host={host}
                  onSave={() => onChange({ kind: "host-ok", account: "API key" })}
                />
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function statusLine(signIn: SignIn, state: RowState, host: string): string {
  switch (state.kind) {
    case "off":
      return "Off";
    case "mac":
      return `From this Mac · ${signInMeta(signIn)}`;
    case "host-none":
      return signIn.kind === "API key" ? "API key" : signIn.kind;
    case "host-code":
      return state.opened
        ? `Waiting for ${PROVIDER_PAGE[signIn.id] ?? "approval"}`
        : `Signing in on ${host}`;
    case "host-key":
      return `Stored only on ${host}`;
    case "host-ok":
      return `Signed in on ${host} · ${state.account}`;
    case "expired":
      return `Expired on ${host}`;
  }
}

/**
 * The code is the thing you compare, so it is drawn large and copyable; the
 * button opens the page you type it into. After that the row waits on its own
 * — nothing to press when you come back.
 */
function DeviceCode({
  page,
  code,
  opened,
  onOpen,
}: {
  page: string;
  code: string;
  opened: boolean;
  onOpen: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
        className="group flex h-9 items-center gap-2 rounded-control border border-dashed border-border px-4 font-mono text-sm tracking-widest transition-colors hover:border-solid hover:bg-muted/50"
        aria-label={`Copy code ${code}`}
      >
        {code}
        <span className="text-muted-foreground">
          {copied ? (
            <CheckIcon weight="bold" className="size-3.5 text-positive" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </span>
      </button>
      <AnimatePresence initial={false} mode="popLayout">
        {opened ? (
          <motion.span
            key="waiting"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="flex items-center gap-2 text-ui text-muted-foreground"
          >
            <StepMark status="active" />
            Approve on {page}
          </motion.span>
        ) : (
          <motion.span key="open" exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
            <Button size="sm" onClick={onOpen}>
              Open {page.split("/")[0]}
              <ArrowSquareOutIcon />
            </Button>
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function KeyEntry({ host, onSave }: { host: string; onSave: () => void }) {
  const [value, setValue] = React.useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.length > 0) onSave();
      }}
    >
      <Input
        autoFocus
        type="password"
        aria-label={`API key, stored on ${host}`}
        placeholder="sk-or-…"
        className="h-8 flex-1 font-mono"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button size="sm" type="submit" disabled={value.length === 0}>
        Save
      </Button>
    </form>
  );
}

/* ── The direction-specific trailing controls ──────────────────────────── */

export function ForwardSwitch({
  signIn,
  on,
  onChange,
}: {
  signIn: SignIn;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Switch
      aria-label={`Use this Mac’s ${signIn.name} sign-in`}
      checked={on}
      onCheckedChange={onChange}
    />
  );
}

export function SourceChoice({
  signIn,
  value,
  onChange,
}: {
  signIn: SignIn;
  value: Source;
  onChange: (value: Source) => void;
}) {
  return (
    <Segmented
      ariaLabel={`Where ${signIn.name} signs in`}
      value={value}
      size="sm"
      options={[
        { key: "mac", label: "This Mac" },
        { key: "host", label: "On host" },
      ]}
      onChange={onChange}
    />
  );
}
