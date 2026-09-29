### Main memory after forced GC (MiB; median [min–max] across launches)

| bound | entries | launches | main heapUsed pre → Δ | heapUsed Δ per context | main heapTotal Δ | main footprint pre → Δ | main working set pre → Δ | main RSS Δ | renderer footprint Δ | renderer working set Δ |
|---:|---:|---:|---|---:|---|---|---|---|---|---|
| control (0) | — | 6 | 57.5 → 0.04 [0.04–0.07] | — | -35.0 [-36.8–-34.5] | 203.0 → -0.5 [-2.0–1.0] | 277.9 → -36.0 [-127.4–-0.3] | -36.0 [-127.4–-0.3] | 2.0 [1.0–2.0] | -14.2 [-81.3–3.7] |
| 1 | 4500 | 6 | 57.6 → 15.80 [15.80–15.86] | 15.80 | 14.9 [1.0–15.5] | 203.0 → 30.5 [26.0–33.0] | 270.0 → 50.2 [37.0–58.8] | 50.2 [37.0–58.8] | 2.0 [1.0–3.0] | 2.8 [-27.7–8.7] |
| 1 | 13500 | 6 | 57.5 → 44.12 [44.10–44.16] | 44.12 | 68.9 [68.0–70.5] | 203.0 → 57.0 [55.0–68.0] | 292.3 → 68.5 [-9.2–112.1] | 68.5 [-9.2–112.1] | 2.5 [1.0–3.0] | -11.3 [-51.1–12.9] |

### Process topology (count; median [min–max] across launches)

| bound | entries | descendants of main by parent pid, pre → post | `app.getAppMetrics()` processes, pre → post |
|---:|---:|---|---|
| control (0) | — | 3 [3–3] → 3 [3–3] | 4 [4–4] → 4 [4–4] |
| 1 | 4500 | 3 [3–3] → 3 [3–3] | 4 [4–4] → 4 [4–4] |
| 1 | 13500 | 3 [3–3] → 3 [3–3] | 4 [4–4] → 4 [4–4] |

### Forced full GC pause over the live heap (ms; median [min–max] across launches)

| bound | entries | before hydration | after hydration |
|---:|---:|---|---|
| control (0) | — | 20.6 [19.3–29.0] | 32.3 [20.7–85.0] |
| 1 | 4500 | 19.9 [19.1–23.6] | 22.9 [20.8–32.9] |
| 1 | 13500 | 23.4 [19.8–30.5] | 24.3 [22.1–63.8] |

### idle window — main loop and renderer→main IPC (ms)

Loop-delay histogram (ELD) columns are median [min–max] across launches of each launch's own percentile, with the histogram's total sample count beside them; pooled columns are `p50 / p95 / max (samples)` over every launch's raw samples.

| bound | entries | window ms | ELD samples | ELD p50 | ELD p95 | ELD max | 10 ms tick gap (pooled) | IPC echo (pooled) | Session RPC (pooled) | GCs / launch | GC ms / launch | GC pause (pooled) | r(loop, echo) |
|---:|---:|---|---:|---|---|---|---|---|---|---|---|---|---:|
| control (0) | — | 6053 [6028–6075] | 26214 | 1.32 [1.31–1.34] | 1.55 [1.43–2.58] | 12.3 [3.9–38.2] | 10.4 / 11.1 / 41.6 (3497) | 0.30 / 1.20 / 35.30 (5534) | 0.40 / 1.60 / 30.20 (1360) | 1 [0–1] | 8.0 [0.0–11.1] | 8.18 / 11.09† / 11.09 (4) | 0.81 (366) |
| 1 | 4500 | 6039 [6038–6042] | 25964 | 1.32 [1.31–1.34] | 1.53 [1.43–3.32] | 11.5 [7.5–32.8] | 10.4 / 11.3 / 42.3 (3472) | 0.30 / 1.30 / 31.10 (5496) | 0.40 / 1.90 / 26.00 (1356) | 3 [0–3] | 13.9 [0.0–16.7] | 6.34 / 10.67† / 10.67 (13) | 0.92 (366) |
| 1 | 13500 | 6040 [6034–6067] | 24207 | 1.31 [1.30–1.39] | 1.61 [1.41–8.99] | 49.9 [9.0–84.1] | 10.4 / 12.0 / 92.2 (3359) | 0.30 / 2.20 / 83.00 (5285) | 0.40 / 3.90 / 106.20 (1328) | 1 [0–3] | 3.9 [0.0–24.1] | 7.71 / 15.40† / 15.40 (7) | 0.91 (367) |

† fewer than 20 samples: the nearest-rank p95 is the maximum, not a tail estimate.

### hydration window — main loop and renderer→main IPC (ms)

Loop-delay histogram (ELD) columns are median [min–max] across launches of each launch's own percentile, with the histogram's total sample count beside them; pooled columns are `p50 / p95 / max (samples)` over every launch's raw samples.

| bound | entries | window ms | ELD samples | ELD p50 | ELD p95 | ELD max | 10 ms tick gap (pooled) | IPC echo (pooled) | Session RPC (pooled) | GCs / launch | GC ms / launch | GC pause (pooled) | r(loop, echo) |
|---:|---:|---|---:|---|---|---|---|---|---|---|---|---|---:|
| control (0) | — | 29 [28–31] | 126 | 1.29 [1.28–1.32] | 1.34 [1.33–1.43] | 1.4 [1.3–1.8] | 10.3 / 11.2† / 11.2 (12) | 0.30 / 0.40† / 0.40 (6) | 0.50 / 0.60† / 0.60 (6) | 0 [0–0] | 0.0 [0.0–0.0] | — | -0.64 (6) |
| 1 | 4500 | 160 [135–189] | 296 | 1.28 [1.08–1.30] | 10.51 [9.72–14.04] | 61.9 [57.4–72.2] | 11.2 / 68.7 / 79.7 (49) | 2.10 / 61.90 / 70.30 (53) | 0.80 / 58.20 / 64.10 (22) | 3 [3–3] | 12.6 [7.8–14.0] | 0.31 / 13.25† / 13.25 (18) | 1.00 (14) |
| 1 | 13500 | 303 [288–462] | 531 | 1.14 [1.10–1.27] | 4.83 [2.63–7.00] | 187.7 [173.8–241.8] | 10.3 / 187.2 / 247.4 (73) | 0.70 / 167.60 / 241.50 (100) | 0.80 / 205.80 / 241.60 (34) | 8 [8–8] | 21.1 [15.5–33.3] | 0.45 / 9.54 / 11.75 (48) | 1.00 (18) |

† fewer than 20 samples: the nearest-rank p95 is the maximum, not a tail estimate.

### steady window — main loop and renderer→main IPC (ms)

Loop-delay histogram (ELD) columns are median [min–max] across launches of each launch's own percentile, with the histogram's total sample count beside them; pooled columns are `p50 / p95 / max (samples)` over every launch's raw samples.

| bound | entries | window ms | ELD samples | ELD p50 | ELD p95 | ELD max | 10 ms tick gap (pooled) | IPC echo (pooled) | Session RPC (pooled) | GCs / launch | GC ms / launch | GC pause (pooled) | r(loop, echo) |
|---:|---:|---|---:|---|---|---|---|---|---|---|---|---|---:|
| control (0) | — | 6058 [6032–6120] | 25717 | 1.32 [1.30–1.35] | 1.64 [1.41–2.55] | 17.5 [11.8–38.7] | 10.4 / 11.2 / 38.7 (3486) | 0.30 / 1.20 / 36.90 (5487) | 0.40 / 1.80 / 36.90 (1357) | 0 [0–0] | 0.0 [0.0–0.0] | — | 0.93 (366) |
| 1 | 4500 | 6048 [6033–6056] | 25635 | 1.31 [1.31–1.34] | 1.52 [1.42–3.35] | 14.1 [8.1–69.9] | 10.4 / 11.3 / 69.9 (3463) | 0.30 / 1.30 / 69.80 (5461) | 0.40 / 2.10 / 43.80 (1351) | 0 [0–0] | 0.0 [0.0–0.0] | — | 0.97 (366) |
| 1 | 13500 | 6060 [6039–6152] | 26292 | 1.32 [1.31–1.33] | 1.51 [1.43–2.29] | 15.7 [3.6–55.7] | 10.4 / 11.1 / 55.8 (3496) | 0.30 / 1.10 / 41.60 (5510) | 0.50 / 1.70 / 44.20 (1357) | 1 [1–3] | 2.9 [2.3–18.9] | 2.84 / 9.99† / 9.99 (8) | 0.95 (366) |

† fewer than 20 samples: the nearest-rank p95 is the maximum, not a tail estimate.

### Loop and IPC deltas against the same launch's idle window (ms; median [min–max] across launches)

| bound | entries | hydration ΔELD p95 | hydration ΔELD max | hydration Δtick-gap p95 | hydration ΔIPC echo p95 | steady ΔELD p95 | steady ΔELD max | steady Δtick-gap p95 | steady ΔIPC echo p95 | steady ΔSession RPC p95 |
|---:|---:|---|---|---|---|---|---|---|---|---|
| control (0) | — | -0.21 [-1.24–0.01] | -10.9 [-36.8–-2.1] | -0.6 [-1.7–0.4] | -0.60 [-1.90–-0.20] | -0.01 [-0.98–1.10] | 3.7 [-15.0–32.3] | 0.1 [-1.0–2.5] | -0.10 [-1.50–2.30] | -0.10 [-1.20–3.70] |
| 1 | 4500 | 8.93 [6.87–12.59] | 50.8 [24.6–61.4] | 55.8 [50.6–68.7] | 61.00 [55.00–69.50] | 0.00 [-0.15–0.37] | 3.1 [0.2–37.1] | 0.1 [-0.2–0.7] | -0.10 [-0.50–0.60] | -0.05 [-0.60–0.80] |
| 1 | 13500 | 3.38 [-4.46–5.23] | 166.3 [91.6–187.4] | 178.9 [163.8–236.2] | 180.90 [166.90–240.30] | -0.13 [-6.70–0.10] | -30.4 [-79.3–45.5] | -0.0 [-11.2–0.2] | 0.00 [-10.40–0.40] | 0.00 [-13.90–0.60] |

Hydration windows are short (tens to hundreds of ms), so a single launch's hydration p95 often rests on few samples; read those deltas beside the pooled hydration table above.

### Hydration: one `model.select` that rebinds one Session (ms)

| bound | entries | every bind p50 / p95 / max (n) | first bind after boot | later binds | whole window median [min–max] |
|---:|---:|---|---|---|---|
| 1 | 4500 | 119.2 / 143.3† / 143.3 (6) | 119.2 / 143.3† / 143.3 (6) | — | 160 [135–189] |
| 1 | 13500 | 286.9 / 427.7† / 427.7 (6) | 286.9 / 427.7† / 427.7 (6) | — | 303 [288–462] |

† fewer than 20 samples: the nearest-rank p95 is the maximum, not a tail estimate.

### Per-context slope of the post-GC delta (MiB per bound context; control arm as N = 0)

A fit needs at least three arms; with fewer it is left blank rather than reported with a meaningless r² of 1.

| entries | heapUsed slope (r²) | main footprint slope (r²) | main working set slope (r²) | main RSS slope (r²) |
|---:|---|---|---|---|
| 4500 | — | — | — | — |
| 13500 | — | — | — | — |

Host 1-minute load across measured launches (worst of start/end): p50 6.04, p95 15.24, max 15.24 (18 launches); memory-pressure levels seen: 1, 2.

### Load sensitivity: only launches with 1-minute load ≤ 12.0 (17 kept, 1 dropped)

| arm | launches | heapUsed Δ MiB | later binds ms | hydration tick gap | hydration IPC echo | steady tick gap | steady IPC echo |
|---|---:|---|---|---|---|---|---|
| control | 6 | 0.04 [0.04–0.07] | — | 10.3 / 11.2† / 11.2 (12) | 0.30 / 0.40† / 0.40 (6) | 10.4 / 11.2 / 38.7 (3486) | 0.30 / 1.20 / 36.90 (5487) |
| n1-h4500 | 6 | 15.80 [15.80–15.86] | — | 11.2 / 68.7 / 79.7 (49) | 2.10 / 61.90 / 70.30 (53) | 10.4 / 11.3 / 69.9 (3463) | 0.30 / 1.30 / 69.80 (5461) |
| n1-h13500 | 5 | 44.10 [44.10–44.14] | — | 10.2 / 180.7 / 247.4 (62) | 0.70 / 167.60 / 241.50 (84) | 10.4 / 11.0 / 55.8 (2919) | 0.30 / 0.90 / 41.60 (4616) |

† fewer than 20 samples: the nearest-rank p95 is the maximum, not a tail estimate.

