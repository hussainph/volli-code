# VC-358 — `+ Chat` to usable composer, measured

The acceptance item this file answers: *"Time from `+ Chat` press to usable
composer improves materially against the harness baseline, under both load
arms."*

## What was compared

Both runs used the **same instrument** and the **same fixture**; only the app
build differs. The harness is `apps/desktop/e2e/bench/performance/run.mjs` with
`--interactions new_chat`, which times the `+ Chat` press until the composer is
visible, enabled and focusable.

| | before | after |
|---|---|---|
| app build | `75edfd85` (`origin/main`) | `8f9d2549` (this branch) |
| fixture | `real`, seed `353259855` — 1,198 Sessions / 259,855 Session Events / 392 Tickets | same generated profile, reused |
| repetitions | 10 per arm | 10 per arm |
| arms | idle, 2-busy-core | idle, 2-busy-core |
| device | MacBookPro17,1 — Apple M1, 8 logical cores, 16 GiB, macOS 26.5.1 | same, same session |

The `before` run carried this branch's `run.mjs` and `presets.mjs` over the
`origin/main` checkout as untracked edits, so the measuring code is identical on
both sides. Those two files are the only thing this branch changes about the
harness; the `new_chat` measurement itself is untouched.

## Result

| arm | p50 before | p50 after | Δ | p95 before | p95 after | Δ |
|---|---:|---:|---:|---:|---:|---:|
| idle | 510.9 ms | 352.4 ms | **−31.0%** | 1147.2 ms | 455.3 ms | **−60.3%** |
| 2-busy-core | 540.1 ms | 224.4 ms | **−58.5%** | 749.0 ms | 281.0 ms | **−62.5%** |

Spread, which moved further than the median:

| arm | mean | standard deviation | worst sample |
|---|---|---|---|
| idle | 668.9 → 340.7 ms | 338.3 → 82.7 ms | 1480.1 → 476.0 ms |
| 2-busy-core | 659.2 → 242.7 ms | 290.4 → 45.8 ms | 1478.4 → 352.4 ms |

Dropped frames at p95 fell from 45 to 9 (idle) and from 36 to 1 (loaded); frame
p95 under load fell from 33.4 ms to 18.5 ms.

## Reading it

The median is the smaller half of the story. What `+ Chat` stopped doing — a
`session.create` round trip, a Session Attachment, a worktree ensure and an
Agent Runtime boot — was never a fixed cost: it was work queued behind whatever
else the machine was doing, which is why the before-run's standard deviation
(290–338 ms) is comparable to its own median. Removing it takes the **worst**
case from ~1.5 s to under 0.5 s and collapses the variance by roughly 94–97%.

That is also why the loaded arm improves *more* than the idle one. Under two
busy cores the deferred work was contending for exactly the cores the press
needed; with nothing deferred, the loaded arm is now faster than the idle
arm's before-figure by a factor of two.

The remaining ~250–350 ms is not the Session. It is the Model Access catalog
read the composer waits on before it will accept a message — `useModelAccess`
in `components/chat/chat-plane.tsx`, gating `composable`. Knowing the model
before the box opens is deliberate (VC-53): a box that takes a message before
the model is known spends it before the warning it was owed. That read is now
the whole critical path, and is the next thing to measure if this number needs
to fall further.

## Reproducing

```
pnpm run build
node apps/desktop/e2e/bench/performance/run.mjs \
  --preset real --interactions new_chat --repetitions 10 \
  --arms idle,loaded --skip-build --output <dir>
```

Numbers are comparable only on the same machine, in the same power and thermal
state, with the same load arm.
