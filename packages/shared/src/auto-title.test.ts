import { describe, expect, it } from "vite-plus/test";

import type { ModelSelection } from "./agent-runtime";
import {
  AUTO_TITLE_MAX_SUBJECT_CHARS,
  AUTO_TITLE_MAX_WORDS,
  AUTO_TITLE_SYSTEM_PROMPT,
  autoTitleSubject,
  resolveAutoTitleModel,
  sanitizeAutoTitle,
} from "./auto-title";

const UTILITY: ModelSelection = { providerId: "openai", modelId: "luna", reasoningLevel: "off" };
const SESSION: ModelSelection = {
  providerId: "anthropic",
  modelId: "opus",
  reasoningLevel: "high",
};
const ROLE: ModelSelection = { providerId: "anthropic", modelId: "role", reasoningLevel: "medium" };

describe("resolveAutoTitleModel", () => {
  it("prefers the explicit cost-efficient choice", () => {
    expect(resolveAutoTitleModel({ utility: UTILITY, session: SESSION, roleDefault: ROLE })).toBe(
      UTILITY,
    );
  });

  it("falls to the model the chat already runs under, not the Role's orchestration default", () => {
    expect(resolveAutoTitleModel({ utility: null, session: SESSION, roleDefault: ROLE })).toBe(
      SESSION,
    );
  });

  it("falls to the Role default only when the Session records no model", () => {
    expect(resolveAutoTitleModel({ utility: null, session: null, roleDefault: ROLE })).toBe(ROLE);
  });

  it("resolves nothing for a profile that configured nothing", () => {
    expect(resolveAutoTitleModel({ utility: null, session: null, roleDefault: null })).toBeNull();
  });
});

describe("autoTitleSubject", () => {
  it("passes a normal first message through untouched", () => {
    expect(autoTitleSubject("The login button is broken")).toBe("The login button is broken");
  });

  it("cuts a pasted wall of text to the prompt budget", () => {
    const subject = autoTitleSubject("x".repeat(AUTO_TITLE_MAX_SUBJECT_CHARS + 5000));
    expect(subject).toHaveLength(AUTO_TITLE_MAX_SUBJECT_CHARS);
  });

  it("leaves no trailing whitespace at the cut", () => {
    const message = `${"word ".repeat(AUTO_TITLE_MAX_SUBJECT_CHARS)}tail`;
    expect(autoTitleSubject(message)).toBe(autoTitleSubject(message).trimEnd());
  });
});

describe("AUTO_TITLE_SYSTEM_PROMPT", () => {
  it("demands the six-word ceiling and forbids everything but the title", () => {
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("six words");
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("only");
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("no quotes");
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("no punctuation");
    expect(AUTO_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain("no explanation");
  });
});

describe("sanitizeAutoTitle", () => {
  it("keeps a clean short title", () => {
    expect(sanitizeAutoTitle("Fix the login flow")).toBe("Fix the login flow");
  });

  it("collapses whitespace and reads only the first line", () => {
    expect(sanitizeAutoTitle("  Fix   the\tlogin flow\nSome explanation below.")).toBe(
      "Fix the login flow",
    );
  });

  it("strips surrounding quotes", () => {
    expect(sanitizeAutoTitle('"Fix the login flow"')).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("'Fix the login flow'")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("`Fix the login flow`")).toBe("Fix the login flow");
  });

  it("strips a trailing period and other trailing punctuation", () => {
    expect(sanitizeAutoTitle("Fix the login flow.")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("Fix the login flow!")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("Fix the login flow,")).toBe("Fix the login flow");
  });

  it("strips a `Title:` prefix the model answered with anyway", () => {
    expect(sanitizeAutoTitle("Title: Fix the login flow")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("Title - Fix the login flow")).toBe("Fix the login flow");
    expect(sanitizeAutoTitle("Title \u2013 Fix the login flow")).toBe("Fix the login flow");
  });

  it("drops a conversational lead-in clause and keeps what follows it", () => {
    expect(sanitizeAutoTitle("Sure! Here is your title: Fix the parser")).toBe("Fix the parser");
  });

  it("keeps a short colon prefix, which is part of the title", () => {
    expect(sanitizeAutoTitle("VC-81: model titles")).toBe("VC-81: model titles");
    expect(sanitizeAutoTitle("Auth: login and signup")).toBe("Auth: login and signup");
  });

  it("keeps a colon that lands past the word ceiling, which cannot be a lead-in", () => {
    expect(sanitizeAutoTitle("one two three four five six seven: title")).toBe(
      "one two three four five six",
    );
  });

  it("refuses a reply that is only a lead-in", () => {
    expect(sanitizeAutoTitle("Here is the title:")).toBeNull();
  });

  it("refuses prose rather than shipping its first six words as a fragment", () => {
    expect(
      sanitizeAutoTitle("I would be happy to help you with that request and here is what I think"),
    ).toBeNull();
  });

  it("keeps a legitimate title that begins with the word Title", () => {
    expect(sanitizeAutoTitle("Title Case conventions")).toBe("Title Case conventions");
  });

  it(`cuts answers longer than ${AUTO_TITLE_MAX_WORDS} words down to that many`, () => {
    expect(sanitizeAutoTitle("The quick brown fox jumps over the lazy dog")).toBe(
      "The quick brown fox jumps over",
    );
  });

  it("caps length at the session-title budget on a word boundary", () => {
    expect(
      sanitizeAutoTitle(
        "Internationalization infrastructure investigation compatibility documentation rationalization",
      ),
    ).toBe("Internationalization infrastructure…");
  });

  it("returns null when nothing survives", () => {
    expect(sanitizeAutoTitle("")).toBeNull();
    expect(sanitizeAutoTitle("   \n\t ")).toBeNull();
    expect(sanitizeAutoTitle(".")).toBeNull();
    expect(sanitizeAutoTitle('""')).toBeNull();
    expect(sanitizeAutoTitle("Title:")).toBeNull();
  });
});
