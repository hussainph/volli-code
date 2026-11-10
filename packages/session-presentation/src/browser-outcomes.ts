export interface BrowserOutcome {
  status: "done" | "denied";
  label: string;
  note: string;
  count: number | null;
  rule: string | null;
}

/** Whole producer messages only; never classify a page/console body's words. */
export function readBrowserOutcome(text: string, toolName: string): BrowserOutcome | null {
  const lines = text.split("\n");
  if (
    lines.length === 3 &&
    lines[0] === "Volli refused the browser action, and nothing was done."
  ) {
    const rule =
      /^Refused by rule (.+)\. The policy is not yours to adjust, and this must not be attempted another way: act on what the refusal says, or continue without it\.$/.exec(
        lines[2]!,
      );
    if (rule)
      return {
        status: "denied",
        label: "Action blocked",
        note: lines[1]!,
        count: null,
        rule: rule[1]!,
      };
  }
  if (
    toolName === "browser_tabs" &&
    text ===
      "No Browser Tabs are open to this Session. browser_navigate with a URL and no tabId opens a new one."
  )
    return { status: "done", label: "Listed 0 tabs", note: "No open tabs", count: 0, rule: null };
  if (
    toolName === "browser_console" &&
    /^Browser Tab \S+ at [^\n]+ has no recorded console messages or page errors\.$/.test(text)
  )
    return {
      status: "done",
      label: "Read console",
      note: "No console messages or page errors",
      count: 0,
      rule: null,
    };
  if (toolName === "browser_acquire") {
    if (
      /^You hold Browser Tab \S+\. It is yours to drive until you release it or your turn ends\.$/.test(
        text,
      )
    )
      return {
        status: "done",
        label: "Took control of tab",
        note: "Control acquired",
        count: null,
        rule: null,
      };
    if (
      /^Browser Tab \S+ is not yours: (?:the person has taken it|Session \S+ holds it)\. Open your own tab with browser_navigate and no tabId, or wait and try again\.$/.test(
        text,
      )
    )
      return {
        status: "denied",
        label: "Tab in use",
        note: "The tab is controlled elsewhere.",
        count: null,
        rule: "browser.tab-held",
      };
  }
  if (
    toolName === "browser_release" &&
    /^Browser Tab \S+ is released\. Your next write there would take the hold again\.$/.test(text)
  )
    return {
      status: "done",
      label: "Released tab",
      note: "Control released",
      count: null,
      rule: null,
    };
  if (["browser_snapshot", "browser_navigate", "browser_act", "browser_find"].includes(toolName)) {
    const empty =
      "The tree exposes nothing yet: the page may still be loading, the URL may not serve the page you expected, or it draws without accessible structure.";
    const suffix = `${empty} There are no refs to act on. Wait and take a snapshot again, check browser_console for errors, or take a screenshot.`;
    if (
      ["browser_snapshot", "browser_navigate"].includes(toolName) &&
      /^Volli read Browser Tab \S+ at [^\n]+, accessibility tree at generation \d+\. /.test(text) &&
      text.endsWith(suffix)
    )
      return {
        status: "done",
        label: "Read page",
        note: "No accessible page content",
        count: null,
        rule: null,
      };
    if (
      toolName === "browser_find" &&
      /^Volli searched Browser Tab \S+ at [^\n]+, accessibility tree at generation \d+, for the literal text [^\n]+ and found no element whose accessible name or text contains it\./.test(
        text,
      ) &&
      text.endsWith(
        "Refs from your latest snapshot still stand. Search for different words, or take a snapshot to see what the page does expose.",
      )
    )
      return {
        status: "done",
        label: "Searched page",
        note: "No matching elements",
        count: 0,
        rule: null,
      };
  }
  return null;
}
