/**
 * The opt-OUT from a Browser Tab's native-plane overlay watch
 * (`components/browser/browser-plane-freeze.ts`): presentational chrome that is
 * drawn fixed or portalled but never covers a plane's content meaningfully —
 * the app's scroll thumbs, which sit on a scroller's own edge and move every
 * scroll frame. Its own module so the thumb does not depend on the Browser's
 * freeze rules (or on a test's mock of them).
 */
export const NATIVE_PLANE_IGNORE_ATTR = "data-native-plane-ignore";
