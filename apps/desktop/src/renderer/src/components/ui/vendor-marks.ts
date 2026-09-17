/**
 * The vendor marks the app draws, as path data and nothing else.
 *
 * Data rather than components, because two different surfaces need the same
 * drawing under different rules: `models/model-identity.tsx` paints a model's
 * mark in that vendor's own brand-adjacent tint, and `ui/session-mark.tsx`
 * paints a Session's mark in the STATUS tone the dot it replaces would have
 * used. A component could not serve both without a colour prop that means
 * opposite things to its two callers, and a second copy of the path strings is
 * how a vendor's mark quietly stops being the vendor's mark on one surface.
 *
 * Inline path strings rather than the `simple-icons` package: the renderer's
 * CSP allows no external origins, a package read at runtime would ship 3,000
 * icons to reach five, and an inline `<svg>` takes `currentColor`, a size and a
 * tint like any other glyph in the app. Everything here is one path on a 24-box
 * with the source's own coordinates, never retyped or rescaled.
 *
 * SOURCES. Anthropic, Cursor, OpenCode and Z.ai are lifted verbatim from
 * simple-icons (CC0 1.0). OpenAI is not in that package — it was withdrawn over
 * the vendor's trademark policy — so it is a trace of the public brand SVG,
 * already in the tree since `model-identity.tsx` shipped. The trademarks remain
 * their owners'; they identify a harness or a provider the user themselves
 * chose.
 */

import { isFirstClassHarnessId, type FirstClassHarnessId, type HarnessId } from "@volli/shared";

export interface VendorMark {
  /** The vendor's name, for an accessible name a harness label does not already give. */
  label: string;
  /** Single path, 24×24 viewBox, correct under the default nonzero fill rule. */
  path: string;
}

/**
 * Every vendor the app has a mark for. The key is the VENDOR, not a harness id
 * and not a provider id: Codex and `openai-codex` are one company's mark seen
 * from two vocabularies, and keying this by either of them would need the other
 * one's alias table living here.
 */
export const VENDOR_MARKS = {
  anthropic: {
    label: "Anthropic",
    path: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  },
  openai: {
    label: "OpenAI",
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  },
  cursor: {
    label: "Cursor",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
  opencode: {
    label: "OpenCode",
    // A square with a square hole. The counter is a reverse-wound subpath, so
    // the default nonzero rule renders the hole with no `fill-rule` override —
    // exactly as simple-icons ships it.
    path: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
  },
  zai: {
    label: "Z.ai",
    path: "M12.606 1.806l-1.677 2.388c-0.258 0.374-0.697 0.606-1.161 0.606h-9.162V1.794C0.594 1.806 12.606 1.806 12.606 1.806zM24 1.806L9.6 22.206 0 22.206 14.4 1.806zM11.394 22.206l1.69-2.4c0.258-0.374 0.697-0.606 1.161-0.606h9.149v3.006H11.394z",
  },
} as const satisfies Record<string, VendorMark>;

/** Which vendors this build can draw. */
export type VendorMarkId = keyof typeof VENDOR_MARKS;

/**
 * WHICH CLI a terminal companion runs, as the vendor behind it.
 *
 * A registered bring-your-own slug is deliberately absent rather than given a
 * generic mark: there is no artwork we could invent for it that would mean
 * anything, and a second neutral symbol would only teach a reader a glyph that
 * says "not one of the four". Such a row keeps the status dot it has always
 * drawn.
 */
const HARNESS_VENDOR: Record<FirstClassHarnessId, VendorMarkId> = {
  "claude-code": "anthropic",
  codex: "openai",
  cursor: "cursor",
  opencode: "opencode",
};

/**
 * WHO a structured Session's model is billed through — the PROVIDER of its
 * current selection, never the family that made the model.
 *
 * The distinction is the whole rule: a Claude model reached through a gateway
 * is that gateway's row, because the provider is what a person picked and what
 * an authentication failure will name. `models/model-identity.tsx` draws the
 * same choice for the same reason, with a lettermark where there is no mark;
 * here an unknown provider draws no mark at all and the row keeps its dot,
 * because a band of Sessions is scanned for status and a lettermark in the
 * status slot would be a second kind of thing in one column.
 *
 * Keyed by pi's own provider ids, which are plain strings with no union to
 * exhaust — so this is a partial lookup by construction, not an incomplete one.
 */
const PROVIDER_VENDOR: Readonly<Record<string, VendorMarkId>> = {
  anthropic: "anthropic",
  "openai-codex": "openai",
  "opencode-go": "opencode",
  zai: "zai",
};

/** The mark a terminal companion draws, or `null` for a shell or a custom slug. */
export function harnessVendorMark(harnessId: HarnessId | null): VendorMark | null {
  if (harnessId === null || !isFirstClassHarnessId(harnessId)) return null;
  return VENDOR_MARKS[HARNESS_VENDOR[harnessId]];
}

/** The mark a structured Session draws, or `null` for a provider this build has none for. */
export function providerVendorMark(providerId: string | null): VendorMark | null {
  if (providerId === null) return null;
  const vendor = PROVIDER_VENDOR[providerId];
  return vendor === undefined ? null : VENDOR_MARKS[vendor];
}
