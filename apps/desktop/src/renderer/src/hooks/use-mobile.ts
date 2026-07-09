/**
 * Always false: this is a desktop app — there is no mobile layout. shadcn's
 * stock 768px matchMedia version swapped the sidebar into a hidden Sheet
 * whenever the viewport narrowed (e.g. DevTools docked to the window's side),
 * which read as the sidebar vanishing. Kept as a hook so the vendored shadcn
 * components' imports stay untouched.
 */
export function useIsMobile() {
  return false;
}
