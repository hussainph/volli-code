/** Fixed, in-memory fixtures for the VC-442 read-only reduction prototype. */

/** Declared harness delays, shared by every lane, sweep, report and test. */
export const SCRIPTED_PROVIDER_ROUND_MS = 35;
export const FIXTURE_READ_LATENCY_MS = 8;
/** Declared per-call waits for the mocked MCP-like network tool. */
export const MOCK_CALL_LATENCIES_MS = [50, 250, 900] as const;

export const FIXTURE_PATHS = [
  "/fixture/team.txt",
  "/fixture/service.md",
  "/fixture/deploy.md",
  "/fixture/runbook.md",
  "/fixture/index.json",
  "/fixture/shards/a.log",
  "/fixture/shards/b.log",
  "/fixture/shards/c.log",
  "/fixture/noisy.log",
] as const;

export type FixturePath = (typeof FIXTURE_PATHS)[number];

function buildNoisyLog(): string {
  const lines = Array.from({ length: 500 }, (_, index) => {
    const seq = String(index).padStart(4, "0");
    return `seq=${seq} level=info tenant=acme route=/v1/items latency_ms=${20 + (index % 80)} note=${"x".repeat(56)}`;
  });
  lines[73] = "seq=0073 level=critical tenant=acme incident=INC-742 route=/checkout code=E42";
  lines[218] = "seq=0218 level=critical tenant=acme incident=INC-815 route=/invoice code=E43";
  lines[441] = "seq=0441 level=critical tenant=acme incident=INC-902 route=/search code=E51";
  return `${lines.join("\n")}\n`;
}

/** These values never come from a Session, workspace, user file or provider. */
export const FIXTURES: Readonly<Record<FixturePath, string>> = Object.freeze({
  "/fixture/team.txt": [
    "Workspace: Northstar",
    "Owner: Atlas Crew",
    "Release status: green",
    "This fixture has no other owner record.",
  ].join("\n"),
  "/fixture/service.md": [
    "service=payments owner=Platform",
    "service=search owner=Discovery",
    "payments service is maintained by the Platform group.",
  ].join("\n"),
  "/fixture/deploy.md": [
    "payments.deploy=green revision=rev-17",
    "search.deploy=yellow revision=rev-11",
  ].join("\n"),
  "/fixture/runbook.md": [
    "payments.escalation=#payments-oncall",
    "search.escalation=#search-oncall",
  ].join("\n"),
  "/fixture/index.json": JSON.stringify(
    {
      collection: "payment-shards",
      files: ["/fixture/shards/a.log", "/fixture/shards/b.log", "/fixture/shards/c.log"],
    },
    null,
    2,
  ),
  "/fixture/shards/a.log": [
    "route=checkout severity=ERROR code=E42 incident=INC-742",
    "route=search severity=INFO code=OK",
  ].join("\n"),
  "/fixture/shards/b.log": [
    "route=invoice severity=ERROR code=E43 incident=INC-815",
    "route=profile severity=INFO code=OK",
  ].join("\n"),
  "/fixture/shards/c.log": [
    "route=search severity=INFO code=OK",
    "route=checkout severity=WARN code=W12",
  ].join("\n"),
  "/fixture/noisy.log": buildNoisyLog(),
});

export const TASKS = {
  "single-call": {
    title: "Find the Northstar team owner",
    prompt: "Who owns the Northstar workspace? Return the exact owner.",
    paths: ["/fixture/team.txt"],
    requiredEvidence: ["Owner: Atlas Crew"],
    expectedAnswer: "Atlas Crew",
    filterTerms: ["Owner:"],
  },
  "independent-multi-read": {
    title: "Summarize the payments service state",
    prompt: "Read the service, deployment and runbook facts for payments.",
    paths: ["/fixture/service.md", "/fixture/deploy.md", "/fixture/runbook.md"],
    requiredEvidence: [
      "service=payments owner=Platform",
      "payments.deploy=green revision=rev-17",
      "payments.escalation=#payments-oncall",
    ],
    expectedAnswer: "payments: owner Platform; deploy green at rev-17; escalation #payments-oncall",
    filterTerms: ["service=payments", "payments.deploy=", "payments.escalation="],
  },
  "dependent-loop-filter": {
    title: "Find error records in indexed shards",
    prompt: "Read the shard index, inspect its files, and list only ERROR records.",
    indexPath: "/fixture/index.json",
    requiredEvidence: [
      "route=checkout severity=ERROR code=E42 incident=INC-742",
      "route=invoice severity=ERROR code=E43 incident=INC-815",
    ],
    expectedAnswer: "checkout E42 (INC-742); invoice E43 (INC-815)",
    filterTerms: ["severity=ERROR"],
  },
  "noisy-large-output": {
    title: "Find critical events in a noisy log",
    prompt: "List every critical incident id and route in the log.",
    paths: ["/fixture/noisy.log"],
    requiredEvidence: [
      "seq=0073 level=critical tenant=acme incident=INC-742 route=/checkout code=E42",
      "seq=0218 level=critical tenant=acme incident=INC-815 route=/invoice code=E43",
      "seq=0441 level=critical tenant=acme incident=INC-902 route=/search code=E51",
    ],
    expectedAnswer: "INC-742 /checkout; INC-815 /invoice; INC-902 /search",
    filterTerms: ["level=critical"],
  },
} as const;

export type FixtureTaskId = keyof typeof TASKS;
