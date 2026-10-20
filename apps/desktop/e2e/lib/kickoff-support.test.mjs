import assert from "node:assert/strict";
import test from "node:test";

import {
  KICKOFF_OPENING,
  kickoffTurnEvidence,
  openTicketCard,
  preparedChatSelected,
  ticketWorkspaceOpen,
} from "./kickoff-support.mjs";

const SESSION_ID = "session-1";
const TURN_ID = "turn-1";
const MARKER = "KICKOFF-READY-ALPHA42";
const frame = (payload, transcript = null, sessionId = SESSION_ID) => ({
  sessionId,
  event: { payload },
  transcript,
});
const transcript = (role, text, turnId = null) => ({
  turnId,
  message: { role, parts: [{ type: "text", text }] },
});
const openingFrames = () => [
  frame(
    { kind: "command.recorded", command: { id: "command-1" } },
    transcript("user", KICKOFF_OPENING),
  ),
  frame({
    kind: "command.receipt.recorded",
    receipt: {
      commandId: "command-1",
      status: "accepted",
      result: { kind: "message.submitted", sessionId: SESSION_ID },
    },
  }),
  frame({ kind: "turn.started", turnId: TURN_ID }),
  frame(
    { kind: "transcript.referenced", turnId: TURN_ID },
    transcript("assistant", MARKER, TURN_ID),
  ),
  frame({ kind: "turn.completed", turnId: TURN_ID }),
];

test("a Session row or recorded opening without execution proves nothing", () => {
  for (const frames of [[], openingFrames().slice(0, 1), openingFrames().slice(0, 2)]) {
    const evidence = kickoffTurnEvidence(frames, SESSION_ID, MARKER);
    assert.equal(evidence.started, false);
    assert.equal(evidence.answered, false);
  }
});

test("accepted opening plus runtime start proves background execution, but not completion", () => {
  assert.deepEqual(kickoffTurnEvidence(openingFrames().slice(0, 3), SESSION_ID, MARKER), {
    sessionId: SESSION_ID,
    commandId: "command-1",
    turnId: TURN_ID,
    accepted: true,
    started: true,
    completed: false,
    answered: false,
  });
});

test("the completed opening requires its own settled assistant marker", () => {
  assert.equal(kickoffTurnEvidence(openingFrames(), SESSION_ID, MARKER).answered, true);
  assert.equal(
    kickoffTurnEvidence(openingFrames().slice(0, 4), SESSION_ID, MARKER).answered,
    false,
  );
  assert.equal(kickoffTurnEvidence(openingFrames(), SESSION_ID, "another-marker").answered, false);
});

test("receipt must accept the stock opening for this exact Session", () => {
  const mutations = [
    (frames) => {
      frames[0].transcript.message.parts[0].text = "not the stock opening";
    },
    (frames) => {
      frames[1].event.payload.receipt.commandId = "another-command";
    },
    (frames) => {
      frames[1].event.payload.receipt.status = "rejected";
    },
    (frames) => {
      frames[1].event.payload.receipt.result.kind = "executor.start.requested";
    },
    (frames) => {
      frames[1].event.payload.receipt.result.sessionId = "another-session";
    },
  ];
  for (const mutate of mutations) {
    const frames = openingFrames();
    mutate(frames);
    const evidence = kickoffTurnEvidence(frames, SESSION_ID, MARKER);
    assert.equal(evidence.accepted, false);
    assert.equal(evidence.started, false);
    assert.equal(evidence.answered, false);
  }
});

test("wrong turn completion, assistant role, or assistant turn cannot satisfy the reply", () => {
  const mutations = [
    (frames) => {
      frames[4].event.payload.turnId = "another-turn";
    },
    (frames) => {
      frames[3].transcript.turnId = "another-turn";
    },
    (frames) => {
      frames[3].transcript.message.role = "user";
    },
    (frames) => {
      frames[3].transcript.message.parts[0].type = "reasoning";
    },
    (frames) => {
      frames[3].transcript.message.parts[0].text = `extra prose ${MARKER}`;
    },
    (frames) => {
      frames.push(frame({ kind: "turn.interrupted", turnId: TURN_ID }));
    },
    (frames) => {
      frames.push(frame({ kind: "turn.started", turnId: "another-turn" }));
    },
  ];
  for (const mutate of mutations) {
    const frames = openingFrames();
    mutate(frames);
    assert.equal(kickoffTurnEvidence(frames, SESSION_ID, MARKER).answered, false);
  }
});

test("another Session's accepted completed turn cannot satisfy this kickoff", () => {
  const other = openingFrames();
  for (const entry of other) entry.sessionId = "another-session";
  assert.equal(kickoffTurnEvidence(other, SESSION_ID, MARKER).started, false);
  assert.equal(
    kickoffTurnEvidence([...openingFrames().slice(0, 3), ...other], SESSION_ID, MARKER).answered,
    false,
  );
});

function workspaceFixture({ opensOnClick = 1, selectedTabs = 1, selectedSession = 1 } = {}) {
  let clicks = 0;
  const queries = [];
  const card = {
    dblclick: async () => {
      clicks += 1;
    },
  };
  const page = {
    locator(selector) {
      queries.push(selector);
      if (selector === "article") return { filter: () => card };
      return { count: async () => selectedSession };
    },
    getByRole(role, options) {
      assert.equal(role, "tablist");
      assert.deepEqual(options, {
        name: "Ticket tabs",
        exact: true,
        ...(options.includeHidden === undefined ? {} : { includeHidden: true }),
      });
      return {
        getByRole: (tabRole, tabOptions) => {
          assert.equal(tabRole, "tab");
          assert.equal(options.includeHidden, true);
          assert.deepEqual(tabOptions, { includeHidden: true });
          return { count: async () => (clicks >= opensOnClick ? 2 : 0) };
        },
        locator: (selector) => {
          assert.equal(selector, '[role="tab"][aria-selected="true"]');
          return { count: async () => selectedTabs };
        },
      };
    },
  };
  return { page, queries, clicks: () => clicks };
}

test("card opening checks the named Ticket strip and stops on the first successful gesture", async () => {
  const fixture = workspaceFixture();
  assert.equal(await ticketWorkspaceOpen(fixture.page), false);
  assert.equal(await openTicketCard(fixture.page, "KO-1"), true);
  assert.equal(fixture.clicks(), 1);
});

test("card opening retries a missed gesture", async () => {
  const fixture = workspaceFixture({ opensOnClick: 2 });
  assert.equal(await openTicketCard(fixture.page, "KO-1", { timeout: 1 }), true);
  assert.equal(fixture.clicks(), 2);
});

test("card opening reports exhaustion after three attempts", async () => {
  const fixture = workspaceFixture({ opensOnClick: Infinity });
  assert.equal(await openTicketCard(fixture.page, "KO-1", { timeout: 1 }), false);
  assert.equal(fixture.clicks(), 3);
});

test("card gesture failures propagate instead of masquerading as a missed navigation", async () => {
  const fixture = workspaceFixture();
  fixture.page.locator = () => ({
    filter: () => ({
      dblclick: async () => {
        throw new Error("card missing");
      },
    }),
  });
  await assert.rejects(openTicketCard(fixture.page, "KO-1"), /card missing/);
});

test("prepared chat selection uses expected Session identity, not any title", async () => {
  const fixture = workspaceFixture();
  assert.equal(await preparedChatSelected(fixture.page, SESSION_ID), true);
  assert.deepEqual(fixture.queries, [
    '[data-peek-surface="nav"][data-peek-row="chat:session-1"] [data-active="true"]',
  ]);
  for (const options of [{ selectedTabs: 0 }, { selectedSession: 0 }, { selectedSession: 2 }]) {
    assert.equal(await preparedChatSelected(workspaceFixture(options).page, SESSION_ID), false);
  }
});
