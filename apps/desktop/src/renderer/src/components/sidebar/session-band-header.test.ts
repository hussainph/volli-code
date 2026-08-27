/**
 * The one decision the filter menu owns rather than draws: how a row of
 * checkboxes becomes the listing model's filter.
 *
 * Worth a test of its own because the two shapes disagree on purpose. The menu
 * needs a state per box whether or not the axis is narrowed; the model wants
 * `null` for "not narrowed", which is what its own default carries and what a
 * reader of `SessionListingFilter` checks against. A full set and `null` filter
 * the same rows, so nothing downstream would ever fail if this drifted — the
 * assertion has to be made here or not at all.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SESSION_BAND_FILTER,
  sessionListingFilter,
  type SessionBandFilter,
} from "./session-band-header";

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
