# VC-354 — React/Zustand sidebar subscription profile

Recorded against `09acc82e67c810d48e791d80b1605e86daa224d9` on an Apple M1 with 16 GB RAM while other Volli workloads were active. The benchmark uses a development renderer, so absolute durations are not release-build claims and the final after run was not captured under the baseline's identical background load. The before and after runs are useful primarily for render-count attribution.

Raw artifacts:

- [`vc354-before.json`](../../../apps/desktop/e2e/bench/sidebar-store/vc354-before.json)
- [`vc354-after.json`](../../../apps/desktop/e2e/bench/sidebar-store/vc354-after.json)

## Reproduction

Start the renderer lab, then run the matrix:

```bash
pnpm lab
node apps/desktop/e2e/sidebar-store-bench.mjs \
  --label local --samples 24 --busy-cores 1 \
  --output /tmp/vc354-sidebar.json
```

The lab scratch mounts the shipped `ActiveSessions` in a non-StrictMode React root. Its deterministic fixture has 1,198 Sessions (392 terminal, 806 chat), 392 tickets, 50 worktree paths, 16 Active rows, 1,182 Previous rows, and 3,714 descendants under the sidebar host. Each trigger runs 24 samples in an idle arm and again with one synthetic busy core. `<Profiler>` callbacks cover the full component and both bands; the artifact also contains commit/paint wall time and `PerformanceObserver("longtask")` entries.

This is the VC-354 component/store probe, not a replacement for VC-353's full migrated-database interaction harness. VC-353 had not published its harness contract or committed baseline when these runs were captured. Both artifacts are dirty-worktree captures at the same Git SHA; the final after artifact additionally records SHA-256 `86684b82d952df8e2700ffe105876f5da4ffdeda34e9a7f6fcc373a74862b6c7` over the measured component, listing helper, and lab scratch. The original baseline predates that provenance field, so its `before` label and raw contents remain the provenance available for that arm.

## What the baseline disproved

The broad-map hypothesis was only partly correct.

- `bumpOutput` does **not** replace `byOwner`, `parkState`, or `harness`. The existing `listingOutputStamps` selector already prevented another project's terminal output from rendering this listing: 24 writes produced zero renders before this change.
- A resident chat-slice write whose title did not change also produced zero renders. `useShallow` suppressed React work, although its selector still scanned and allocated over all resident chat slices on every `sessions` write.
- The remaining broad subscriptions were real. Another project's `openTabs`, `parkState`, `harness`, or `byOwner` write each rendered all 3,714 sidebar descendants 24 times.

## Before/after profile

### Idle arm

| Trigger | Renders | React total (ms) | p95 render (ms) | Long tasks |
|---|---:|---:|---:|---:|
| Project chat burst (144 writes) | 24 → 24 | 238.8 → 299.4 | 21.0 → 25.0 | 0 → 0 |
| Resident chat slice | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| Own open chat tabs | 48 → 48 | 262.3 → 305.5 | 18.7 → 21.5 | 0 → 0 |
| **Other-project open chat tabs** | **24 → 0** | **140.0 → 0** | **12.7 → 0** | 0 → 0 |
| Own terminal output | 24 → 24 | 193.5 → 238.0 | 19.5 → 23.5 | 0 → 0 |
| Other-project terminal output | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| Own park state | 24 → 24 | 193.6 → 456.3 | 20.5 → 38.7 | 0 → 0 |
| **Other-project park state** | **24 → 0** | **200.7 → 0** | **19.7 → 0** | 0 → 0 |
| Own harness | 24 → 24 | 199.9 → 241.2 | 22.2 → 24.1 | 0 → 0 |
| **Other-project harness** | **24 → 0** | **158.1 → 0** | **18.2 → 0** | 0 → 0 |
| Own container | 24 → 24 | 105.3 → 230.9 | 12.0 → 21.8 | 0 → 0 |
| **Other-project container** | **24 → 0** | **173.6 → 0** | **16.0 → 0** | 0 → 0 |

### One-busy-core arm

| Trigger | Renders | React total (ms) | p95 render (ms) | Long tasks |
|---|---:|---:|---:|---:|
| Project chat burst (144 writes) | 24 → 24 | 262.0 → 302.8 | 23.2 → 27.2 | 0 → 0 |
| Resident chat slice | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| Own open chat tabs | 48 → 48 | 286.3 → 306.2 | 22.7 → 23.7 | 0 → 0 |
| **Other-project open chat tabs** | **24 → 0** | **148.1 → 0** | **15.3 → 0** | 0 → 0 |
| Own terminal output | 24 → 24 | 207.6 → 237.3 | 20.7 → 25.0 | 0 → 0 |
| Other-project terminal output | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| Own park state | 24 → 24 | 209.8 → 401.3 | 24.0 → 32.6 | 0 → 1 (51 ms) |
| **Other-project park state** | **24 → 0** | **195.9 → 0** | **20.5 → 0** | 0 → 0 |
| Own harness | 24 → 24 | 187.9 → 241.7 | 19.2 → 24.0 | 0 → 0 |
| **Other-project harness** | **24 → 0** | **141.2 → 0** | **15.7 → 0** | 0 → 0 |
| Own container | 24 → 24 | 103.8 → 226.4 | 11.7 → 25.1 | 0 → 0 |
| **Other-project container** | **24 → 0** | **159.5 → 0** | **15.5 → 0** | 0 → 0 |

The exact, repeatable result is the render-count change: all four irrelevant cross-project paths fell from 24/24 renders to zero in both arms. Relevant writes retained their counts. The final run's relevant-write durations were uniformly slower than the baseline and included an isolated 51 ms busy-arm long task during an own-project park update. Earlier runs placed an isolated 50–60 ms task in different scenarios. Because the background load was not controlled between captures, the data does not support attributing duration-tail movement to one selector; render counts and back-to-back local reproduction are the reliable claims.

After the change, the ranked renderer work contains only relevant updates: own open-tab changes (two commits per write because the ticket-history effect settles), project chat activity, and own terminal state. Cross-project entries disappear rather than merely becoming cheaper.

Across the complete trigger matrix, the Profiler boundaries rank as follows. The outer boundary includes both inner bands, so rows are not additive.

| Profiler boundary | Idle commits / total | Busy commits / total |
|---|---:|---:|
| `ActiveSessions` before | 264 / 1,865.8 ms | 264 / 1,902.1 ms |
| `ActiveSessions` after | 168 / 1,771.3 ms | 168 / 1,715.7 ms |
| Previous band before → after | 264 / 593.7 → 168 / 530.4 ms | 264 / 613.5 → 168 / 490.7 ms |
| Active band before → after | 264 / 225.1 → 168 / 233.0 ms | 264 / 230.4 → 168 / 213.3 ms |

That is 36% fewer commits across the matrix. The machine-local outer duration happened to fall 5% idle and 10% in the busy arm, but the relevant-write slowdown above makes that timing aggregate unsuitable as a product claim.

## Selector design

`ActiveSessions` now projects:

- `byOwner` and `openTabs` to the current project id plus its current ticket ids;
- `lastOutputAt`, `parkState`, and `harness` to the tab roots and split-pane ids found in those scoped containers;
- resident titles to chat Session ids in the current project's durable listing.

The selectors are identity-gated. Every Zustand write still invokes each selector, but an unchanged source slice returns in O(1). A `byOwner` write performs one bounded project-owner projection; its derived root/pane id list preserves identity when membership did not change, so a title or active-pane-only container update does not recreate the three per-session selector caches. When a relevant flat map changes, its selector walks only those stable ids and retains its previous result if every selected value is referentially equal. This avoids the blanket-`useShallow` failure mode where an O(n) comparison runs after every unrelated store write.

The listing's observable shape did not move: before and after both report 16 Active rows, 1,182 Previous rows, and 3,714 sidebar descendants. Existing listing and row tests were left unmodified.

## Listing rebuild cost

The post-change artifact separately times the pure derivation over all 1,198 Sessions (480 repetitions per arm):

| Pure operation | Idle p50 / p95 | Busy p50 / p95 |
|---|---:|---:|
| Full `buildActiveSessionListing` | 0.5 / 1.5 ms | 0.5 / 1.0 ms |
| 392-record `recordsById` index | <0.1 / 0.1 ms | <0.1 / 0.1 ms |
| 392-ticket `ticketsById` index | <0.1 / 0.1 ms | <0.1 / 0.1 ms |

The ticket and terminal-record arrays are stable during terminal output, park, and harness writes. Chat activity replaces the chat row array but not those two arrays. Hoisting the two indexes would therefore be possible, but the measured combined indexing p95 is about 0.2 ms and the full build remains at or below 1.5 ms at p95. Adding an indexed-input API to the well-covered pure builder would save little after irrelevant rebuilds are removed, so VC-354 leaves it pure and unchanged.

## Persisted-store audit

Each row below is 480 writes. The workspace fixture contains one project record with 392 ticket-tab records and 50 project-file tabs; the draft fixture contains the capped 50 drafts with roughly 1 KiB of text each.

| Store/action | Envelope | Idle action p50 / p95 | Busy action p50 / p95 | Partialize p95 | JSON p95 |
|---|---:|---:|---:|---:|---:|
| UI transient `setSettingsOpen` | 329 B | <0.1 / <0.1 ms | <0.1 / <0.1 ms | <0.1 ms | <0.1 ms |
| Workspace transient `recordNav` | 59,623 B | 0.1 / 0.2 ms | 0.1 / 0.2 ms | <0.1 ms | 0.1–0.2 ms |
| Chat draft keystroke | 55,366 B | <0.1 / 0.1 ms | <0.1 / 0.1 ms | 0.1 ms | 0.1 ms |

Zustand persist still partializes and serializes after every `set`, including actions whose changed fields are excluded from persistence. `app-state-storage` updates its cache and schedules a trailing-edge 200 ms debounce synchronously; that stage stayed below 0.1 ms p95. IPC and the SQLite UPSERT occur later and are coalesced per key, so they do not extend the renderer task measured above.

This is unnecessary work, but it is bounded and did not create a long task in this profile. VC-361 owns the persistent-slice-only follow-up. `chat-drafts.ts` was audited but not edited because VC-358 owns its promotion path; its measurements were posted to VC-358.

## React 19 verdict

### React Compiler: defer behind VC-216

The renderer is already on React 19.2 and its Babel-based `@vitejs/plugin-react` pipeline can host React Compiler. It should not be enabled by VC-354. VC-216 records 206 findings across the ten currently disabled compiler lint rules, led by `react/refs` (71), `react/set-state-in-effect` (52), and `react/exhaustive-effect-dependencies` (34). Enabling the compiler first would skip or reject important hot components and create false confidence while the existing manual memo layer remains load-bearing.

Recommendation: finish VC-216, retain existing memoization during adoption, then enable the compiler incrementally per renderer directory with this benchmark and the chat benchmark as before/after gates.

### `useDeferredValue` / `startTransition`: do not add here

The store writes arrive externally, so `startTransition` has no honest user-event seam. Deferring the volatile listing inputs would not prevent the subscription render: React would first render urgently with stale values and later render the full listing with the deferred values. That trades one semantically current commit for an extra temporarily stale commit.

The measured pure build is 0.5 ms p50 and at most 1.5 ms p95 across the two arms; the material waste was irrelevant cross-project renders, which selector scoping removes completely. There is no measured rebuild cost large enough to justify doubled commit scheduling or temporarily stale attention/park state. Reconsider deferral only if a release-mode interaction trace demonstrates urgent-input delay after these selectors are in place.
