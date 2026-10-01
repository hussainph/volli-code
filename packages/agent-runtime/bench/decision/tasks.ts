/**
 * The VC-478 decision benchmark's tasks: decisions an agent makes over and
 * over, each with a known right answer.
 *
 * Generated, not hand-written, from a seeded generator, so every arm and every
 * trial sees byte-identical inputs and a re-run measures the same thing.
 *
 * - `browser` — which state is this page in, and is a modal in the way? The
 *   page-state check a browser-use agent repeats after every action, over
 *   accessibility snapshots shaped like `browser_snapshot`'s.
 * - `triage` — label 200 support messages with one of five categories: the
 *   bulk data-classification case.
 * - `control` — is this multiplication right? A decision a classifier is the
 *   wrong tool for: it needs arithmetic, which the tool's own description
 *   tells an agent not to hand it. It is here to show the limit honestly.
 */

import type { DecisionQuestion } from "@volli/shared";

export type TaskId = "browser" | "triage" | "control";

/** One decision: the state it is about and the answer each question should get. */
export interface DecisionItem {
  state: Record<string, unknown>;
  /** Question name to the correct option key, level, or boolean. */
  expected: Record<string, string | boolean>;
}

export interface DecisionTask {
  id: TaskId;
  title: string;
  questions: Record<string, DecisionQuestion>;
  items: readonly DecisionItem[];
}

/** Mulberry32: a tiny seeded PRNG, so every run generates the same items. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

// ---- browser: page-state checks ---------------------------------------------

const PAGE_STATES = {
  "sign-in": "A sign-in form asking for an email and password",
  "two-factor": "A prompt for a one-time verification code",
  dashboard: "A signed-in home page or dashboard",
  checkout: "A cart or checkout page with items and a button to pay or place the order",
  "not-found": "A page saying what was asked for does not exist (404)",
  error: "A page saying something went wrong on the server, often with a retry",
  loading: "A page still loading: placeholders or a progress indicator, no real content",
} as const;

type PageState = keyof typeof PAGE_STATES;

const SITES = ["Acme Cloud", "Northwind", "Globex Mail", "Initech HR", "Umbrella Shop", "Hooli"];

function chrome(random: () => number, site: string): string[] {
  const links = ["Docs", "Pricing", "Blog", "Status", "Support", "Careers"];
  return [
    `- banner`,
    `  - link "${site}" [ref=e1]`,
    `  - navigation "Main"`,
    ...links
      .filter(() => random() > 0.4)
      .map((label, index) => `    - link "${label}" [ref=e${2 + index}]`),
  ];
}

const FOOTER = [
  `- contentinfo`,
  `  - link "Privacy" [ref=e90]`,
  `  - link "Terms" [ref=e91]`,
  `  - text "© 2026"`,
];

function pageBody(random: () => number, state: PageState, site: string): string[] {
  switch (state) {
    case "sign-in":
      return [
        `- main`,
        `  - heading "${pick(random, ["Sign in", "Log in to your account", "Welcome back"])}" [level=1]`,
        `  - textbox "Email" [ref=e20]`,
        `  - textbox "Password" [ref=e21]`,
        `  - checkbox "Remember me" [ref=e22]`,
        `  - button "${pick(random, ["Sign in", "Continue", "Log in"])}" [ref=e23]`,
        `  - link "Forgot password?" [ref=e24]`,
      ];
    case "two-factor":
      return [
        `- main`,
        `  - heading "${pick(random, ["Two-step verification", "Enter your code", "Verify it's you"])}" [level=1]`,
        `  - text "We sent a 6-digit code to ${pick(random, ["your phone", "your authenticator app", "j***@example.com"])}."`,
        `  - textbox "Verification code" [ref=e30]`,
        `  - button "Verify" [ref=e31]`,
        `  - link "Use a backup code" [ref=e32]`,
      ];
    case "dashboard":
      return [
        `- main`,
        `  - heading "${pick(random, ["Overview", "Dashboard", `Welcome, ${pick(random, ["Ada", "Sam", "Noor"])}`])}" [level=1]`,
        `  - button "Account menu" [ref=e40]`,
        `  - region "Recent activity"`,
        `    - listitem "Invoice #${100 + Math.floor(random() * 900)} paid"`,
        `    - listitem "${pick(random, ["New sign-in from Safari", "Project Atlas updated", "2 new messages"])}"`,
        `  - link "Settings" [ref=e41]`,
        `  - button "Sign out" [ref=e42]`,
      ];
    case "checkout":
      return [
        `- main`,
        `  - heading "${pick(random, ["Your cart", "Checkout", "Review your order"])}" [level=1]`,
        `  - listitem "${pick(random, ["Wireless mouse", "USB-C hub", "Desk lamp"])} — $${10 + Math.floor(random() * 90)}.00"`,
        `  - listitem "${pick(random, ["Notebook", "Cable pack", "Mug"])} — $${5 + Math.floor(random() * 20)}.00"`,
        `  - text "Subtotal: $${40 + Math.floor(random() * 80)}.00"`,
        `  - button "${pick(random, ["Place order", "Pay now", "Proceed to payment"])}" [ref=e50]`,
      ];
    case "not-found":
      return [
        `- main`,
        `  - heading "${pick(random, ["404", "Page not found", "We couldn't find that page"])}" [level=1]`,
        `  - text "The page you are looking for ${pick(random, ["does not exist", "may have moved", "was removed"])}."`,
        `  - link "Go to ${site} home" [ref=e60]`,
      ];
    case "error":
      return [
        `- main`,
        `  - heading "${pick(random, ["Something went wrong", "500 — Internal server error", "We hit a snag"])}" [level=1]`,
        `  - text "${pick(random, ["Our servers had a problem handling your request.", "An unexpected error occurred.", "Please try again in a moment."])}"`,
        `  - button "Try again" [ref=e70]`,
      ];
    case "loading":
      return [
        `- main`,
        `  - progressbar "${pick(random, ["Loading", "Loading content", "Please wait"])}"`,
        `  - generic "placeholder"`,
        `  - generic "placeholder"`,
        `  - generic "placeholder"`,
      ];
  }
}

const MODALS = [
  [
    `- dialog "We value your privacy" [modal]`,
    `  - text "We use cookies to improve your experience."`,
    `  - button "Accept all" [ref=e80]`,
    `  - button "Reject" [ref=e81]`,
  ],
  [`- dialog "Your session is about to expire" [modal]`, `  - button "Stay signed in" [ref=e82]`],
  [
    `- dialog "Subscribe to our newsletter" [modal]`,
    `  - textbox "Email" [ref=e83]`,
    `  - button "Close" [ref=e84]`,
  ],
];

function browserTask(count: number): DecisionTask {
  const random = seeded(478);
  const states = Object.keys(PAGE_STATES) as PageState[];
  const items: DecisionItem[] = [];
  for (let index = 0; index < count; index++) {
    const state = states[index % states.length]!;
    const site = pick(random, SITES);
    const blocked = random() < 0.35;
    const lines = [
      `Tab t${index + 1}: ${site} — ${pick(random, ["https", "https"])}://${site.toLowerCase().replaceAll(" ", "")}.example/${state}`,
      ...chrome(random, site),
      ...pageBody(random, state, site),
      ...FOOTER,
      ...(blocked ? pick(random, MODALS) : []),
    ];
    items.push({ state: { snapshot: lines.join("\n") }, expected: { state, blocked } });
  }
  return {
    id: "browser",
    title: "Browser page-state checks",
    questions: {
      state: {
        type: "choice",
        instructions: "Which state is the page in, judging from its accessibility snapshot?",
        criteria: PAGE_STATES,
      },
      blocked: {
        type: "bool",
        instructions:
          "Is a modal dialog open over the page, so it must be dealt with before anything else on the page can be used?",
        criteria: {
          true: "A modal dialog is open over the page",
          false: "No modal dialog is open",
        },
      },
    },
    items,
  };
}

// ---- triage: bulk data classification ---------------------------------------

const CATEGORIES = {
  bug: "Something is broken or behaves wrongly: a crash, an error, wrong output",
  feature: "A request for something new or for a change to how it works",
  question: "Asking how to do something or how something works",
  billing: "About charges, invoices, refunds, plans or payment methods",
  account: "About signing in, passwords, two-factor, or the account itself",
} as const;

type Category = keyof typeof CATEGORIES;

const AREAS = [
  "the dashboard",
  "CSV export",
  "the mobile app",
  "search",
  "notifications",
  "the API",
];
const TEMPLATES: Record<Category, readonly ((area: string, n: number) => string)[]> = {
  bug: [
    (area) => `Every time I open ${area} it crashes with a white screen.`,
    (area, n) => `${area} shows ${n} results but there are clearly more, the count is wrong.`,
    (area) => `Getting "500 internal error" when I use ${area} since this morning.`,
    (area) => `${area} freezes after the last update, nothing responds until I reload.`,
  ],
  feature: [
    (area) => `It would be great if ${area} could be filtered by date range.`,
    (area) => `Could you add dark mode to ${area}? My eyes would thank you.`,
    (area) => `Please let us schedule ${area} to run weekly instead of by hand.`,
    (area) => `Feature request: keyboard shortcuts for ${area}.`,
  ],
  question: [
    (area) => `How do I share ${area} with someone outside my team?`,
    (area) => `Is there a way to see who changed something in ${area}?`,
    (area) => `Where do I find the settings for ${area}? I can't locate them.`,
    (area) => `What's the difference between the two views in ${area}?`,
  ],
  billing: [
    (_area, n) => `I was charged twice this month, $${n} each time. Please refund one.`,
    (_area, n) => `Can I get an invoice with our VAT number for the $${n} payment?`,
    () => `How do I downgrade from the Team plan to the free plan?`,
    () => `My card expired, where do I update the payment method?`,
  ],
  account: [
    () => `I'm locked out after too many password attempts, please help.`,
    () => `I lost my phone and can't get my two-factor codes anymore.`,
    () => `The password reset email never arrives, I checked spam.`,
    () => `Please delete my account and all of my data.`,
  ],
};

function triageTask(count: number): DecisionTask {
  const random = seeded(4780);
  const categories = Object.keys(CATEGORIES) as Category[];
  const items: DecisionItem[] = [];
  for (let index = 0; index < count; index++) {
    const category = categories[index % categories.length]!;
    const message = pick(random, TEMPLATES[category])(
      pick(random, AREAS),
      10 + Math.floor(random() * 190),
    );
    items.push({ state: { message }, expected: { category } });
  }
  return {
    id: "triage",
    title: "Support triage (labelling)",
    questions: {
      category: {
        type: "choice",
        instructions: "Which category does this support message belong to?",
        criteria: CATEGORIES,
      },
    },
    items,
  };
}

// ---- control: a decision a classifier is the wrong tool for -----------------

function controlTask(count: number): DecisionTask {
  const random = seeded(47800);
  const items: DecisionItem[] = [];
  for (let index = 0; index < count; index++) {
    const a = 12 + Math.floor(random() * 88);
    const b = 12 + Math.floor(random() * 88);
    const correct = index % 2 === 0;
    const shown = correct ? a * b : a * b + pick(random, [-10, -2, 1, 9, 20]);
    items.push({ state: { claim: `${a} × ${b} = ${shown}` }, expected: { correct } });
  }
  return {
    id: "control",
    title: "Control: arithmetic (classifier not suited)",
    questions: {
      correct: {
        type: "bool",
        instructions: "Is the multiplication in the claim correct?",
        criteria: { true: "The product is right", false: "The product is wrong" },
      },
    },
    items,
  };
}

export function decisionTasks(sizes: { browser: number; triage: number; control: number }) {
  return [browserTask(sizes.browser), triageTask(sizes.triage), controlTask(sizes.control)];
}

export const DEFAULT_SIZES = { browser: 28, triage: 200, control: 20 } as const;
