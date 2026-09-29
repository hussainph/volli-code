### Main memory after forced GC (MiB; median [min–max] across launches)

| bound | entries | launches | main heapUsed pre → Δ | heapUsed Δ per context | main heapTotal Δ | main footprint pre → Δ | main working set pre → Δ | main RSS Δ | renderer footprint Δ | renderer working set Δ |
|---:|---:|---:|---|---:|---|---|---|---|---|---|
| control (0) | — | 6 | 57.5 → 0.04 [0.04–0.07] | — | -34.6 [-36.0–0.3] | 202.5 → 1.0 [-4.0–2.0] | 279.3 → -3.1 [-80.1–2.1] | -3.0 [-80.1–2.2] | 2.0 [1.0–3.0] | 2.4 [-37.3–9.1] |
| 1 | 4500 | 6 | 57.5 → 15.84 [15.83–15.86] | 15.84 | 13.3 [0.8–15.0] | 203.0 → 29.5 [26.0–40.0] | 260.3 → 18.7 [-29.3–50.1] | 18.7 [-29.3–50.1] | 2.0 [1.0–2.0] | -1.1 [-44.4–3.2] |
| 1 | 13500 | 6 | 57.5 → 44.11 [44.10–44.12] | 44.11 | 69.6 [69.0–71.0] | 203.5 → 68.5 [58.0–159.0] | 265.5 → 62.0 [26.7–84.3] | 62.0 [26.7–84.3] | 1.5 [1.0–2.0] | -13.4 [-31.2–4.2] |

### Process topology (count; median [min–max] across launches)

| bound | entries | descendants of main by parent pid, pre → post | `app.getAppMetrics()` processes, pre → post |
|---:|---:|---|---|
| control (0) | — | 3 [3–3] → 3 [3–3] | 4 [4–4] → 4 [4–4] |
| 1 | 4500 | 3 [3–3] → 3 [3–3] | 4 [4–4] → 4 [4–4] |
| 1 | 13500 | 3 [3–3] → 3 [3–3] | 4 [4–4] → 4 [4–4] |

### Forced full GC pause over the live heap (ms; median [min–max] across launches)

| bound | entries | before hydration | after hydration |
|---:|---:|---|---|
| control (0) | — | 26.4 [18.0–48.2] | 22.3 [18.5–27.7] |
| 1 | 4500 | 23.4 [19.7–30.3] | 24.6 [18.2–31.5] |
| 1 | 13500 | 22.4 [17.3–27.1] | 28.9 [17.6–37.0] |

### idle window — main loop and renderer→main IPC (ms)

Loop-delay histogram columns are median [min–max] across launches of each launch's own percentile; pooled columns are `p50 / p95 / max (samples)` over every launch's raw samples.

| bound | entries | window ms | ELD p50 | ELD p95 | ELD max | 10 ms tick gap (pooled) | IPC echo (pooled) | Session RPC (pooled) | GCs / launch | GC ms / launch | GC pause (pooled) | r(loop, echo) |
|---:|---:|---|---|---|---|---|---|---|---|---|---|---:|
| control (0) | — | 6050 [6034–6061] | 1.27 [1.20–1.34] | 1.92 [1.42–2.49] | 25.3 [9.9–57.8] | 10.4 / 11.7 / 59.4 (3448) | 0.30 / 2.10 / 56.20 (5577) | 0.40 / 3.20 / 47.10 (1347) | 0 [0–3] | 0.0 [0.0–18.1] | 5.52 / 9.72 / 9.72 (6) | 0.89 (366) |
| 1 | 4500 | 6045 [6029–6087] | 1.25 [1.18–1.32] | 1.47 [1.26–1.67] | 21.2 [3.0–99.0] | 10.4 / 11.0 / 98.9 (3503) | 0.20 / 0.60 / 129.50 (5786) | 0.40 / 1.10 / 125.60 (1363) | 0 [0–3] | 0.0 [0.0–24.0] | 8.91 / 11.56 / 11.56 (4) | 0.94 (366) |
| 1 | 13500 | 6049 [6040–6062] | 1.25 [1.18–1.42] | 1.40 [1.27–2.87] | 12.7 [4.9–24.2] | 10.4 / 11.2 / 25.3 (3508) | 0.30 / 1.00 / 22.90 (5762) | 0.40 / 1.40 / 19.00 (1362) | 2 [0–3] | 10.6 [0.0–19.9] | 7.14 / 11.62 / 11.62 (10) | 0.82 (366) |

### hydration window — main loop and renderer→main IPC (ms)

Loop-delay histogram columns are median [min–max] across launches of each launch's own percentile; pooled columns are `p50 / p95 / max (samples)` over every launch's raw samples.

| bound | entries | window ms | ELD p50 | ELD p95 | ELD max | 10 ms tick gap (pooled) | IPC echo (pooled) | Session RPC (pooled) | GCs / launch | GC ms / launch | GC pause (pooled) | r(loop, echo) |
|---:|---:|---|---|---|---|---|---|---|---|---|---|---:|
| control (0) | — | 30 [29–41] | 1.26 [1.19–1.38] | 1.58 [1.27–2.07] | 2.0 [1.3–8.9] | 10.3 / 11.3 / 11.3 (14) | 0.40 / 1.40 / 1.40 (6) | 0.60 / 1.60 / 1.60 (6) | 0 [0–0] | 0.0 [0.0–0.0] | — | 0.70 (6) |
| 1 | 4500 | 204 [140–272] | 1.21 [1.13–1.31] | 10.87 [3.21–19.27] | 74.1 [58.5–109.5] | 11.0 / 92.6 / 116.7 (51) | 1.00 / 80.90 / 109.10 (58) | 1.70 / 89.90 / 105.50 (24) | 3 [3–3] | 10.9 [8.0–19.1] | 0.48 / 18.51 / 18.51 (18) | 0.62 (16) |
| 1 | 13500 | 369 [329–510] | 1.25 [1.16–1.30] | 4.43 [2.49–7.01] | 211.1 [173.8–288.1] | 10.2 / 195.7 / 295.3 (90) | 0.90 / 172.50 / 285.30 (114) | 1.20 / 229.90 / 274.70 (39) | 8 [8–8] | 22.5 [17.3–32.2] | 0.73 / 8.55 / 11.52 (48) | 1.00 (19) |

### steady window — main loop and renderer→main IPC (ms)

Loop-delay histogram columns are median [min–max] across launches of each launch's own percentile; pooled columns are `p50 / p95 / max (samples)` over every launch's raw samples.

| bound | entries | window ms | ELD p50 | ELD p95 | ELD max | 10 ms tick gap (pooled) | IPC echo (pooled) | Session RPC (pooled) | GCs / launch | GC ms / launch | GC pause (pooled) | r(loop, echo) |
|---:|---:|---|---|---|---|---|---|---|---|---|---|---:|
| control (0) | — | 6059 [6029–6085] | 1.25 [1.18–1.42] | 1.39 [1.34–3.52] | 13.5 [5.9–22.5] | 10.4 / 11.2 / 31.9 (3504) | 0.30 / 1.00 / 26.70 (5729) | 0.40 / 1.90 / 15.70 (1362) | 0 [0–0] | 0.0 [0.0–0.0] | — | 0.86 (366) |
| 1 | 4500 | 6063 [6041–6083] | 1.25 [1.19–1.32] | 1.42 [1.31–1.54] | 14.5 [6.7–33.2] | 10.4 / 11.0 / 35.7 (3528) | 0.20 / 0.60 / 33.20 (5811) | 0.40 / 0.90 / 17.40 (1371) | 0 [0–0] | 0.0 [0.0–0.0] | — | 0.86 (366) |
| 1 | 13500 | 6066 [6049–6119] | 1.25 [1.19–1.36] | 1.68 [1.27–2.92] | 18.6 [17.5–98.2] | 10.4 / 11.5 / 105.7 (3479) | 0.20 / 1.70 / 99.10 (5650) | 0.40 / 2.80 / 103.30 (1353) | 2 [1–3] | 14.7 [2.5–96.9] | 4.25 / 96.86 / 96.86 (12) | 0.94 (367) |

### Hydration: one `model.select` that rebinds one Session (ms)

| bound | entries | every bind p50 / p95 / max (n) | first bind after boot | later binds | whole window median [min–max] |
|---:|---:|---|---|---|---|
| 1 | 4500 | 150.0 / 225.4 / 225.4 (6) | 150.0 / 225.4 / 225.4 (6) | — | 204 [140–272] |
| 1 | 13500 | 323.5 / 469.7 / 469.7 (6) | 323.5 / 469.7 / 469.7 (6) | — | 369 [329–510] |

### Per-context slope of the post-GC delta (MiB per bound context; control arm as N = 0)

| entries | heapUsed slope (r²) | main footprint slope (r²) | main working set slope (r²) | main RSS slope (r²) |
|---:|---|---|---|---|
| 4500 | 15.795 (1.00) | 28.500 (1.00) | 21.734 (1.00) | 21.727 (1.00) |
| 13500 | 44.067 (1.00) | 67.500 (1.00) | 65.015 (1.00) | 64.953 (1.00) |

Host 1-minute load across measured launches (worst of start/end): p50 9.04, p95 23.91, max 23.91 (18 launches); memory-pressure levels seen: 1, 2.

### Load sensitivity: only launches with 1-minute load ≤ 12.0 (10 kept, 8 dropped)

| arm | launches | heapUsed Δ MiB | later binds ms | hydration tick gap | hydration IPC echo | steady tick gap | steady IPC echo |
|---|---:|---|---|---|---|---|---|
| control | 3 | 0.04 [0.04–0.04] | — | 10.4 / 11.3 / 11.3 (8) | 0.90 / 1.40 / 1.40 (3) | 10.4 / 11.7 / 21.7 (1734) | 0.30 / 1.80 / 20.00 (2784) |
| n1-h4500 | 3 | 15.84 [15.83–15.86] | — | 11.1 / 67.4 / 68.1 (23) | 0.60 / 59.40 / 64.30 (26) | 10.4 / 10.9 / 22.4 (1767) | 0.20 / 0.40 / 11.00 (2909) |
| n1-h13500 | 4 | 44.10 [44.10–44.12] | — | 10.2 / 195.7 / 230.0 (58) | 0.90 / 172.50 / 223.50 (75) | 10.4 / 11.2 / 105.7 (2330) | 0.20 / 1.20 / 99.10 (3798) |

