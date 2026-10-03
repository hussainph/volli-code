/**
 * Shot: the Session cursor drives a Browser Tab (VC-238, VC-239).
 *
 * Real: `TabStrip`/`Tab` with the holder dot, `BrowserChrome` with the holder
 * pill, and `SessionCursor` — the component main's overlay view bundles over
 * a live tab. Fixture: the checkout page (see checkout-page.tsx) and the
 * Session. The cursor rides its own Surface a little above the page, which is
 * the truth of the product: it is painted by a separate overlay view over
 * the tab, never injected into the page.
 */
import { Surface } from "@webprodigies/flute";
import { pickSessionColor, type BrowserTabHolder } from "@volli/shared";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";

import { BrowserChrome } from "@renderer/components/browser/browser-chrome";
import { BrowserHolderDot } from "@renderer/components/browser/browser-holder-dot";
import { SessionCursor } from "@renderer/components/browser/session-cursor";
import { Tab, TabStrip } from "@renderer/components/ui/tab-strip";
import type { BrowserTabState } from "../../ipc/contract";

import { CheckoutPage, PAGE_HEIGHT, PAGE_WIDTH, TARGETS } from "../kit/checkout-page";
import { ease, progress, typed } from "../kit/clock";
import { FrameLayer, Supers, useFilm, Vignette, type Cue, type Format } from "../kit/film";
import { Backdrop, useFilmTheme } from "../kit/world";

const SESSION = { id: "ses-7c1e-checkout", name: "Fix checkout form" };
const COLOR = pickSessionColor(SESSION.id, []);
const HOLDER: BrowserTabHolder = {
  kind: "session",
  sessionId: SESSION.id,
  name: SESSION.name,
  color: COLOR,
};

const TAB: BrowserTabState = {
  tabId: "tab-checkout",
  projectId: "prj-voltaic",
  ticketId: "tkt-14",
  createdBy: "session",
  ownerSessionId: SESSION.id,
  presentation: "tab",
  url: "https://voltaic.example/checkout",
  title: "Checkout — Voltaic",
  loading: false,
  error: null,
  canGoBack: true,
  canGoForward: false,
  generation: 3,
  heldBy: null,
};

/**
 * Where the page starts inside the window: the 1px frame, the ticket strip
 * (28) and the chrome row (37). Measured in the lab, and mirrored by the rig
 * in scripts/film/shots.mjs.
 */
export const PAGE_TOP = 66;
export const WINDOW = { width: PAGE_WIDTH + 2, height: PAGE_TOP + PAGE_HEIGHT + 1 };

/** The Session's script, in scene ms. */
const T = {
  typeFrom: -260,
  typePerChar: 56,
  toPlan: 700,
  clickPlan: 960,
  planSet: 1060,
  toContinue: 1300,
  hover: 1520,
  clickContinue: 1760,
  saved: 1960,
  release: 3000,
};

function cursorTarget(t: number) {
  if (t < T.toPlan) return TARGETS.name;
  if (t < T.toContinue) return TARGETS.plan;
  return TARGETS.cont;
}

const noop = () => undefined;

function BrowserWindow({ t, holder }: { t: number; holder: BrowserTabHolder | null }) {
  const name = typed("Ada Lovelace", t, T.typeFrom, T.typePerChar);
  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-overlay"
      style={{ width: WINDOW.width, height: WINDOW.height }}
    >
      <TabStrip label="Ticket tabs" className="shrink-0">
        <Tab label="Body" active={false} tabStop={false} closable={false} onActivate={noop} />
        <Tab
          label="Fix checkout form"
          active={false}
          tabStop={false}
          status="working"
          onActivate={noop}
        />
        <Tab
          label="Checkout — Voltaic"
          active
          tabStop
          leading={
            <BrowserIcon
              aria-hidden
              weight="bold"
              className="size-3 shrink-0 text-muted-foreground"
            />
          }
          badge={<BrowserHolderDot holder={holder} />}
          onActivate={noop}
          onClose={noop}
        />
        <Tab
          label="Pricing"
          active={false}
          tabStop={false}
          leading={
            <BrowserIcon
              aria-hidden
              weight="bold"
              className="size-3 shrink-0 text-muted-foreground"
            />
          }
          onActivate={noop}
          onClose={noop}
        />
      </TabStrip>
      <BrowserChrome
        tab={TAB}
        address={TAB.url}
        error={null}
        holder={holder}
        onAddressChange={noop}
        onNavigate={noop}
        onBack={noop}
        onForward={noop}
        onReload={noop}
        onToggleDevTools={noop}
        onTakeOver={noop}
        onAskToLeave={noop}
        onHandBack={noop}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <CheckoutPage
          state={{
            name,
            nameFocused: t < T.toPlan,
            plan: t >= T.planSet ? "team" : "solo",
            planPressed: t >= T.clickPlan && t < T.clickPlan + 180,
            hoverContinue: t >= T.hover && t < T.clickContinue + 200,
            pressContinue: t >= T.clickContinue && t < T.clickContinue + 150,
            saved: progress(t, T.saved, T.saved + 300, ease.outCubic),
          }}
        />
      </div>
    </div>
  );
}

const CUES: Record<Format, Cue[]> = {
  landscape: [
    {
      at: 500,
      until: 3650,
      lines: ["Share a browser", "with your agent."],
      weights: [800, 320],
      sub: "Watch every click it makes.",
      place: "lower-right",
    },
  ],
  portrait: [
    {
      at: 500,
      until: 3650,
      lines: ["Share a browser", "with your agent."],
      weights: [800, 320],
      sub: "Watch every click it makes.",
      place: "upper",
    },
  ],
};

export function CursorShot({ format }: { format: Format }) {
  useFilmTheme("cobalt");
  const t = useFilm();
  const present = t < T.release;
  const holder = present ? HOLDER : null;
  const target = cursorTarget(t);
  const gesture =
    t < T.toPlan
      ? ("type" as const)
      : (t >= T.clickPlan && t < T.clickPlan + 240) ||
          (t >= T.clickContinue && t < T.clickContinue + 240)
        ? ("click" as const)
        : t >= T.hover && t < T.clickContinue
          ? ("hover" as const)
          : null;
  const pressKey = t >= T.clickContinue ? 2 : t >= T.clickPlan ? 1 : 0;

  return (
    <>
      <Surface
        id="browser"
        style={{
          position: "absolute",
          left: `calc(50% - ${WINDOW.width / 2}px)`,
          top: `calc(50% - ${WINDOW.height / 2}px)`,
          width: WINDOW.width,
          height: WINDOW.height,
        }}
        content={<BrowserWindow t={t} holder={holder} />}
      >
        <Surface
          id="cursor-layer"
          transform={{ z: 46 }}
          // A Surface's children are laid out AFTER its content, inside a
          // preserve-3d wrapper that is their containing block — so "the top
          // of the page" is measured back up from the end of the window.
          style={{
            position: "absolute",
            left: 1,
            top: PAGE_TOP - WINDOW.height,
            width: PAGE_WIDTH,
            height: PAGE_HEIGHT,
          }}
          content={
            <div style={{ position: "relative", width: PAGE_WIDTH, height: PAGE_HEIGHT }}>
              <SessionCursor
                color={COLOR}
                name={SESSION.name}
                x={target.x}
                y={target.y}
                present={present}
                gesture={gesture}
                pressKey={pressKey}
                labelPinned
              />
            </div>
          }
        />
      </Surface>
      <Backdrop t={t} theme="cobalt" />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
