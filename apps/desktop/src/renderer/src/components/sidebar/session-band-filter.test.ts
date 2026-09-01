/**
 * How the menu's checkbox state becomes the listing model's filter and the
 * trigger's narrowed signal. The two shapes disagree on purpose: the menu needs
 * a state per box, while the model uses `null` for an untouched axis.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SESSION_BAND_FILTER,
  isSessionBandFilterNarrowed,
  sessionListingFilter,
  type SessionBandFilter,
} from "./session-band-filter";

const bandFilter = (overrides: Partial<SessionBandFilter> = {}): SessionBandFilter => ({
  ...DEFAULT_SESSION_BAND_FILTER,
  ...overrides,
});

describe("sessionListingFilter", () => {
  it("starts unnarrowed on both axes", () => {
    expect(sessionListingFilter(DEFAULT_SESSION_BAND_FILTER)).toEqual({
      kinds: null,
      scopes: null,
      showCleaned: false,
    });
  });

  it("sends an axis as a set only once a box is unchecked", () => {
    expect(sessionListingFilter(bandFilter({ scopes: { project: true, ticket: false } }))).toEqual({
      kinds: null,
      scopes: new Set(["project"]),
      showCleaned: false,
    });
    expect(sessionListingFilter(bandFilter({ kinds: { chat: false, terminal: true } }))).toEqual({
      kinds: new Set(["terminal"]),
      scopes: null,
      showCleaned: false,
    });
  });

  it("narrows the two axes independently, and carries cleanup through untouched", () => {
    expect(
      sessionListingFilter({
        kinds: { chat: true, terminal: false },
        scopes: { project: true, ticket: false },
        showCleaned: true,
      }),
    ).toEqual({
      kinds: new Set(["chat"]),
      scopes: new Set(["project"]),
      showCleaned: true,
    });
  });

  it("sends an empty set for an axis with nothing checked, rather than every row", () => {
    // A reader who unchecks both boxes has asked for nothing on that axis, and
    // an empty band is the honest answer. Collapsing it to `null` would show
    // them the full list back and read as the control being broken.
    expect(sessionListingFilter(bandFilter({ scopes: { project: false, ticket: false } }))).toEqual(
      { kinds: null, scopes: new Set(), showCleaned: false },
    );
  });
});

describe("isSessionBandFilterNarrowed", () => {
  it("tracks every way the band can differ from the default", () => {
    expect(isSessionBandFilterNarrowed(DEFAULT_SESSION_BAND_FILTER)).toBe(false);
    expect(
      isSessionBandFilterNarrowed(bandFilter({ kinds: { chat: false, terminal: true } })),
    ).toBe(true);
    expect(
      isSessionBandFilterNarrowed(bandFilter({ scopes: { project: true, ticket: false } })),
    ).toBe(true);
    expect(isSessionBandFilterNarrowed(bandFilter({ showCleaned: true }))).toBe(true);
  });
});
