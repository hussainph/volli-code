# Agent turn critical path on the real Session path (VC-456)

Fixture `vc456-turn-real-path-v1` · generated 2026-09-29T20:25:11.003Z · 20 measured waves per arm after 1 discarded warm-up wave · in flight 1 / 5 / 15 / 20.

Reproduction: `VC456_OUTPUT=$PWD/performance-results/vc-456-turn-real-path pnpm -C apps/desktop bench:turn-real-path`.

All values are p50 / p95 in ms, nearest-rank, over individual turns. Turns in one wave share a host interval and are not independent. "Watched" means a live subscriber per Session, as a chat open in a tab; "no Session watched" is Sessions working in the background.

## Production path: file transcript artifacts, every Session watched

| In flight | Turns | Submit → accepted | Submit → turn start (`queuedMs`) | `turn-queue` → `turn.started` committed | Runtime turn (VC-119) | First message → completion | Submit → `command()` resolved | Commit → subscriber (`turn.completed`) | Loop delay p95 / max (ms) | CPU per turn (ms) | Loop busy (% one core) | Load 1m after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 21.5 / 26.7 | 22.0 / 28.0 | 0.3 / 0.4 | 253.0 / 284.0 | 276.9 / 301.8 | 279.9 / 302.7 | 0.0 / 0.0 | 1.755 / 12.755 | 59.498 | 21.249 | 6.245 |
| 5 | 100 | 45.8 / 66.5 | 48.0 / 72.0 | 0.2 / 0.6 | 520.0 / 610.0 | 567.1 / 680.9 | 569.0 / 681.6 | 0.0 / 0.0 | 1.96 / 31.588 | 48.856 | 41.797 | 6.072 |
| 15 | 300 | 82.8 / 102.8 | 94.0 / 114.0 | 0.2 / 0.8 | 982.0 / 1161.0 | 1087.0 / 1264.5 | 1087.7 / 1265.1 | 0.0 / 0.0 | 2.134 / 76.874 | 38.84 | 52.118 | 8.682 |
| 20 | 400 | 109.8 / 158.2 | 124.0 / 181.0 | 0.2 / 0.5 | 1259.0 / 1433.0 | 1384.6 / 1604.4 | 1391.4 / 1607.0 | 0.0 / 0.0 | 2.238 / 115.474 | 35.475 | 49.881 | 7.979 |

| In flight | Provider per turn | `read` ×2 per turn | `bash` | Authority wait | Wait start → question seen | `interaction.resolve` round trip | Compaction | Unaccounted gap (runtime turn) | Artifact write, per call | Artifact writes, per turn | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | Ledger txn queue wait |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 88.0 / 90.0 | 1.0 / 2.0 | 5.0 / 6.0 | 31.0 / 37.0 | 0.4 / 1.1 | 18.3 / 23.4 | 21.0 / 22.0 | 104.2 / 140.0 | 17.8 / 25.7 | 126.7 / 145.8 | 4 / 4 | 24 / 24 | 8.77 / 13.05 | 0.03 / 0.07 |
| 5 | 87.0 / 91.0 | 4.0 / 18.0 | 6.0 / 11.0 | 69.0 / 93.0 | 0.6 / 6.6 | 54.6 / 80.0 | 21.0 / 28.0 | 323.0 / 407.0 | 45.6 / 70.2 | 329.7 / 428.7 | 4 / 4 | 24 / 24 | 11.18 / 23.07 | 0.01 / 0.09 |
| 15 | 89.0 / 97.0 | 14.0 / 35.0 | 11.0 / 18.0 | 133.0 / 190.0 | 0.5 / 2.0 | 119.8 / 176.7 | 28.0 / 41.0 | 715.0 / 871.0 | 100.9 / 145.9 | 701.3 / 884.9 | 27 / 31 | 48 / 53 | 9.93 / 23.65 | 0.01 / 0.12 |
| 20 | 89.0 / 94.0 | 15.0 / 37.0 | 15.0 / 30.0 | 163.0 / 235.0 | 0.5 / 2.2 | 150.0 / 221.7 | 32.0 / 43.0 | 934.0 / 1077.0 | 130.8 / 183.8 | 934.9 / 1152.3 | 29 / 33 | 51 / 55 | 10.02 / 25.42 | 0.01 / 0.16 |

## Production path: file transcript artifacts, no Session watched

| In flight | Turns | Submit → accepted | Submit → turn start (`queuedMs`) | `turn-queue` → `turn.started` committed | Runtime turn (VC-119) | First message → completion | Submit → `command()` resolved | Commit → subscriber (`turn.completed`) | Loop delay p95 / max (ms) | CPU per turn (ms) | Loop busy (% one core) | Load 1m after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 13.5 / 18.3 | 14.0 / 19.0 | 0.2 / 1.5 | 219.0 / 231.0 | 231.2 / 244.4 | 231.8 / 245.1 | n/a | 1.82 / 33.62 | 40.62 | 17.078 | 7.66 |
| 5 | 100 | 38.1 / 50.2 | 41.0 / 56.0 | 0.2 / 0.7 | 424.0 / 509.0 | 465.4 / 552.9 | 467.7 / 553.6 | n/a | 2.101 / 50.397 | 40.819 | 41.682 | 7.718 |
| 15 | 300 | 85.2 / 111.9 | 96.0 / 119.0 | 0.2 / 0.7 | 968.0 / 1091.0 | 1066.7 / 1207.3 | 1070.3 / 1207.8 | n/a | 2.527 / 130.679 | 36.835 | 50.304 | 7.339 |
| 20 | 400 | 96.3 / 119.6 | 107.0 / 132.0 | 0.2 / 0.8 | 1188.0 / 1361.0 | 1292.5 / 1477.1 | 1294.1 / 1477.7 | n/a | 2.744 / 136.446 | 34.874 | 52.066 | 6.957 |

| In flight | Provider per turn | `read` ×2 per turn | `bash` | Authority wait | Wait start → question seen | `interaction.resolve` round trip | Compaction | Unaccounted gap (runtime turn) | Artifact write, per call | Artifact writes, per turn | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | Ledger txn queue wait |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 87.0 / 91.0 | 1.0 / 2.0 | 4.0 / 6.0 | 28.0 / 33.0 | 0.5 / 1.4 | 15.2 / 20.6 | 20.0 / 22.0 | 74.0 / 85.0 | 12.6 / 16.9 | 89.5 / 102.8 | 4 / 4 | 24 / 24 | 8.54 / 10.17 | 0.03 / 0.06 |
| 5 | 88.0 / 96.0 | 3.0 / 10.0 | 6.0 / 12.0 | 55.0 / 69.0 | 0.6 / 2.1 | 42.5 / 57.0 | 21.0 / 29.0 | 252.0 / 313.0 | 37.4 / 54.7 | 266.8 / 311.1 | 4 / 4 | 24 / 24 | 10.69 / 24.54 | 0.01 / 0.09 |
| 15 | 89.0 / 96.0 | 20.0 / 53.0 | 13.0 / 24.0 | 125.0 / 158.0 | 0.4 / 4.5 | 111.2 / 146.0 | 27.0 / 39.0 | 685.0 / 797.5 | 99.5 / 140.8 | 702.5 / 864.4 | 21 / 30 | 88 / 116 | 12.48 / 33.47 | 0.00 / 0.04 |
| 20 | 91.0 / 115.0 | 22.0 / 47.0 | 16.0 / 37.0 | 150.0 / 180.0 | 0.4 / 3.3 | 136.1 / 167.7 | 33.0 / 102.0 | 869.2 / 1001.0 | 125.9 / 174.9 | 877.6 / 1058.8 | 25 / 32 | 102 / 124 | 12.23 / 31.99 | 0.00 / 0.04 |

## Diagnostic control: in-memory transcript artifacts, every Session watched

Everything else identical: SQLite ledger, Pi sidecars, tools, gate, subscribers. Not a product configuration; it isolates what durable artifact publication costs.

| In flight | Turns | Submit → accepted | Submit → turn start (`queuedMs`) | `turn-queue` → `turn.started` committed | Runtime turn (VC-119) | First message → completion | Submit → `command()` resolved | Commit → subscriber (`turn.completed`) | Loop delay p95 / max (ms) | CPU per turn (ms) | Loop busy (% one core) | Load 1m after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 0.3 / 0.5 | 1.0 / 2.0 | 0.2 / 0.3 | 137.0 / 141.0 | 137.8 / 141.5 | 138.5 / 146.8 | 0.0 / 0.0 | 1.592 / 16.433 | 22.799 | 16.291 | 6.957 |
| 5 | 100 | 1.3 / 4.4 | 3.0 / 7.0 | 0.2 / 0.4 | 170.0 / 180.0 | 173.7 / 182.9 | 174.7 / 184.1 | 0.0 / 0.0 | 2.628 / 22.151 | 17.279 | 48.468 | 6.8 |
| 15 | 300 | 6.6 / 14.3 | 17.0 / 24.0 | 0.2 / 0.8 | 265.0 / 319.0 | 280.8 / 335.9 | 281.6 / 336.4 | 0.0 / 0.0 | 6.697 / 100.598 | 18.121 | 90.166 | 7.131 |
| 20 | 400 | 8.4 / 16.1 | 20.0 / 33.0 | 0.2 / 0.7 | 317.0 / 378.0 | 339.4 / 401.2 | 340.5 / 403.1 | 0.0 / 0.0 | 8.028 / 101.581 | 17.88 | 98.397 | 6.877 |

| In flight | Provider per turn | `read` ×2 per turn | `bash` | Authority wait | Wait start → question seen | `interaction.resolve` round trip | Compaction | Unaccounted gap (runtime turn) | Artifact write, per call | Artifact writes, per turn | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | Ledger txn queue wait |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 87.0 / 88.0 | 1.0 / 2.0 | 4.0 / 6.0 | 14.0 / 15.0 | 0.6 / 1.5 | 1.4 / 2.1 | 19.0 / 21.0 | 10.5 / 15.0 | 0.1 / 0.2 | 0.4 / 0.8 | 4 / 4 | 24 / 24 | 7.25 / 10.24 | 0.01 / 0.04 |
| 5 | 88.0 / 90.0 | 5.0 / 11.0 | 7.0 / 9.0 | 16.0 / 20.0 | 0.4 / 1.1 | 1.2 / 4.1 | 22.0 / 28.0 | 31.0 / 38.0 | 0.0 / 0.1 | 0.4 / 0.6 | 4 / 4 | 24 / 24 | 6.55 / 11.79 | 0.01 / 0.23 |
| 15 | 88.0 / 98.0 | 18.0 / 37.0 | 17.0 / 26.0 | 20.0 / 28.0 | 0.5 / 2.8 | 1.1 / 5.6 | 27.0 / 38.0 | 89.0 / 134.0 | 0.0 / 0.1 | 0.3 / 0.6 | 27 / 31 | 48 / 54 | 8.72 / 15.91 | 0.01 / 0.53 |
| 20 | 89.0 / 99.0 | 24.0 / 48.0 | 21.0 / 36.0 | 23.0 / 37.0 | 0.5 / 3.4 | 1.0 / 6.2 | 33.0 / 40.0 | 128.0 / 163.6 | 0.0 / 0.1 | 0.3 / 0.5 | 29 / 32 | 51 / 55 | 8.68 / 16.75 | 0.01 / 0.79 |

## Diagnostic control: in-memory transcript artifacts, no Session watched

Everything else identical: SQLite ledger, Pi sidecars, tools, gate, subscribers. Not a product configuration; it isolates what durable artifact publication costs.

| In flight | Turns | Submit → accepted | Submit → turn start (`queuedMs`) | `turn-queue` → `turn.started` committed | Runtime turn (VC-119) | First message → completion | Submit → `command()` resolved | Commit → subscriber (`turn.completed`) | Loop delay p95 / max (ms) | CPU per turn (ms) | Loop busy (% one core) | Load 1m after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 0.4 / 0.8 | 1.0 / 2.0 | 0.3 / 0.7 | 140.0 / 150.0 | 141.3 / 152.4 | 143.6 / 153.2 | n/a | 1.816 / 7.819 | 26.038 | 17.947 | 7.447 |
| 5 | 100 | 1.5 / 4.2 | 4.0 / 8.0 | 0.2 / 0.5 | 172.0 / 218.0 | 177.1 / 224.1 | 178.3 / 227.9 | n/a | 3.146 / 34.144 | 19.441 | 50.805 | 7.251 |
| 15 | 300 | 7.5 / 13.3 | 16.0 / 26.0 | 0.2 / 0.7 | 269.0 / 327.0 | 285.4 / 345.4 | 286.1 / 346.0 | n/a | 6.963 / 116.982 | 19.058 | 93.21 | 7.07 |
| 20 | 400 | 11.1 / 18.4 | 23.0 / 33.0 | 0.2 / 0.9 | 340.0 / 434.0 | 362.7 / 458.8 | 363.4 / 460.6 | n/a | 9.126 / 120.979 | 20.076 | 101.981 | 6.469 |

| In flight | Provider per turn | `read` ×2 per turn | `bash` | Authority wait | Wait start → question seen | `interaction.resolve` round trip | Compaction | Unaccounted gap (runtime turn) | Artifact write, per call | Artifact writes, per turn | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | Ledger txn queue wait |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 87.0 / 89.0 | 1.0 / 2.0 | 5.0 / 7.0 | 14.0 / 16.0 | 0.3 / 1.3 | 1.9 / 3.1 | 20.0 / 22.0 | 14.0 / 21.3 | 0.1 / 0.1 | 0.4 / 0.6 | 4 / 4 | 24 / 24 | 7.88 / 10.77 | 0.01 / 0.06 |
| 5 | 88.0 / 91.0 | 6.0 / 11.0 | 8.0 / 12.0 | 17.0 / 22.0 | 0.4 / 1.7 | 1.1 / 4.8 | 23.0 / 32.0 | 31.0 / 62.0 | 0.1 / 0.1 | 0.4 / 0.7 | 4 / 4 | 24 / 24 | 7.56 / 16.67 | 0.01 / 0.27 |
| 15 | 90.0 / 100.0 | 20.0 / 38.0 | 19.0 / 32.0 | 20.0 / 29.0 | 0.4 / 3.4 | 1.1 / 5.7 | 28.0 / 42.0 | 94.0 / 119.0 | 0.0 / 0.1 | 0.3 / 0.5 | 28 / 31 | 110 / 120 | 10.62 / 17.00 | 0.00 / 0.03 |
| 20 | 94.0 / 107.0 | 28.0 / 58.0 | 24.0 / 36.0 | 24.0 / 39.0 | 0.4 / 1.7 | 1.2 / 5.7 | 32.0 / 42.0 | 138.0 / 208.0 | 0.0 / 0.1 | 0.3 / 0.6 | 29 / 32 | 114 / 123 | 11.04 / 19.98 | 0.00 / 0.03 |

## Overlay cache sweep: either side of eight Sessions streaming

In-memory artifacts (so bottleneck 1 is out of the way), 20 waves per row. The Session runtime keeps a live overlay for at most eight Sessions (`OVERLAY_CACHE_LIMIT`), and a fold for at most eight unwatched ones (`PROJECTION_CACHE_LIMIT`).

| Watched | Deltas per reply | In flight | Ledger reads per turn | Ledger txns per turn | Ledger txn CPU per turn | CPU per turn (ms) | Loop busy (% one core) | Runtime turn | First message → completion |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 8 | 8 | 4 / 4 | 24 / 24 | 7.3 / 12.9 | 17.716 | 64.878 | 189.0 / 266.0 | 195.7 / 278.5 |
| all | 8 | 9 | 20 / 24 | 40 / 45 | 8.0 / 14.9 | 17.429 | 68.194 | 206.0 / 258.0 | 213.2 / 284.1 |
| all | 8 | 20 | 29 / 32 | 51 / 55 | 8.7 / 18.2 | 17.168 | 91.983 | 316.0 / 429.0 | 339.0 / 454.7 |
| all | 256 | 8 | 4 / 4 | 24 / 24 | 7.5 / 13.6 | 23.258 | 78.946 | 210.0 / 252.0 | 216.5 / 258.6 |
| all | 256 | 9 | 479 / 597 | 499 / 618 | 19.7 / 30.1 | 37.717 | 88.716 | 349.0 / 497.0 | 356.5 / 503.9 |
| all | 256 | 20 | 758 / 776 | 779 / 799 | 28.6 / 44.5 | 46.647 | 90.086 | 912.0 / 1369.0 | 940.7 / 1395.4 |
| none | 8 | 8 | 4 / 4 | 24 / 24 | 8.7 / 29.0 | 19.081 | 57.038 | 212.0 / 470.0 | 218.5 / 475.9 |
| none | 8 | 9 | 18 / 23 | 58 / 72 | 9.5 / 19.2 | 19.329 | 69.924 | 210.0 / 277.0 | 221.5 / 380.7 |
| none | 8 | 20 | 29 / 32 | 114 / 124 | 13.4 / 24.2 | 21.632 | 90.547 | 409.0 / 576.0 | 436.0 / 611.2 |
| none | 256 | 8 | 4 / 4 | 24 / 24 | 7.1 / 13.7 | 22.353 | 78.648 | 200.0 / 261.0 | 208.3 / 268.1 |
| none | 256 | 9 | 516 / 650 | 1558 / 1961 | 44.0 / 65.7 | 61.336 | 88.026 | 602.0 / 882.0 | 610.2 / 895.1 |
| none | 256 | 20 | 765 / 776 | 2325 / 2358 | 74.7 / 164.3 | 94.708 | 76.478 | 1950.0 / 3970.0 | 1966.3 / 3984.8 |

## Accounting and cross-checks

| Section | Artifact store | Watched | Deltas | In flight | Complete turns | VC-119 order violations | Turns with all 6 facts paired | Envelope/ledger order inversions | Causality violations | Commits ≠ SQLite read-back | Live stream ≠ SQLite read-back | Distinct ledger shapes | Network attempts |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| matrix | file | all | 8 | 1 | 20 / 20 | 0 | 20 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | file | all | 8 | 5 | 100 / 100 | 0 | 100 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | file | all | 8 | 15 | 300 / 300 | 0 | 300 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | file | all | 8 | 20 | 400 / 400 | 0 | 400 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | file | none | 8 | 1 | 20 / 20 | 0 | 20 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | file | none | 8 | 5 | 100 / 100 | 0 | 100 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | file | none | 8 | 15 | 300 / 300 | 0 | 300 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | file | none | 8 | 20 | 400 / 400 | 0 | 400 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | memory | all | 8 | 1 | 20 / 20 | 0 | 20 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | memory | all | 8 | 5 | 100 / 100 | 0 | 100 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | memory | all | 8 | 15 | 300 / 300 | 0 | 300 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | memory | all | 8 | 20 | 400 / 400 | 0 | 400 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | memory | none | 8 | 1 | 20 / 20 | 0 | 20 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | memory | none | 8 | 5 | 100 / 100 | 0 | 100 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | memory | none | 8 | 15 | 300 / 300 | 0 | 300 | 0 | 0 | 0 | 0 | 1 | 0 |
| matrix | memory | none | 8 | 20 | 400 / 400 | 0 | 400 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | all | 8 | 8 | 160 / 160 | 0 | 160 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | all | 8 | 9 | 180 / 180 | 0 | 180 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | all | 8 | 20 | 400 / 400 | 0 | 400 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | all | 256 | 8 | 160 / 160 | 0 | 160 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | all | 256 | 9 | 180 / 180 | 0 | 180 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | all | 256 | 20 | 400 / 400 | 0 | 400 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | none | 8 | 8 | 160 / 160 | 0 | 160 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | none | 8 | 9 | 180 / 180 | 0 | 180 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | none | 8 | 20 | 400 / 400 | 0 | 400 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | none | 256 | 8 | 160 / 160 | 0 | 160 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | none | 256 | 9 | 180 / 180 | 0 | 180 | 0 | 0 | 0 | 0 | 1 | 0 |
| cliff | memory | none | 256 | 20 | 400 / 400 | 0 | 400 | 0 | 0 | 0 | 0 | 1 | 0 |

Ledger shape of a turn, `command.recorded` → `turn.completed`: `command.recorded>turn.started>usage.recorded>transcript.referenced>transcript.referenced>interaction.opened>command.recorded>interaction.resolved>command.receipt.recorded>transcript.referenced>transcript.referenced>usage.recorded>usage.recorded>context.compacted>usage.recorded>transcript.referenced>turn.completed`.

## Method

- Composition: `SessionRuntime` + the desktop Pi adapter over `createPiAgentRuntime` + the desktop `SqliteSessionLedger` on a migrated `volli.db` opened by `openVolliDb`, the file transcript-artifact store, and one VC-119 sink shared by the Session runtime and the Pi runtime, as `createDesktopSessionRuntime` composes them. Differences: an Electron-free location resolver answering a fixed directory, and a fixed `resolveRuntimeContext`.

- Script per turn (8 text deltas per reply): a tool round (`read` inside the workspace, `read` outside it, `bash printf`), a provider overflow error, Pi's local overflow compaction, and a final reply. Provider stand-in timings per request: tool-round 34 ms (first event 11 ms), overflow 23 ms (first event 9 ms), summary 18 ms (first event 6 ms), final 31 ms (first event 10 ms). Expected per turn: 3 provider attempts, 3 tools, 1 authority wait, 1 compaction, 1 retry, 1 `turn-queue`.

- Authority: `enforcement: "enforce"` with a one-refusal fallback (the shipped default is `observe`, which installs no gate). The outside read is refused by `path.outside-workspace` and escalated; a live subscriber answers `once` via `interaction.resolve` after 12 ms.

- Clocks: `queuedMs` and every VC-119 duration come from the product's own `Date.now` clocks, so they have 1 ms resolution. Submit, frame arrival and envelope record times are the harness's `performance.now()`.

- Accepted is this command's `command.recorded` committed: the engine call that wrote it resolved. Commit times are read when `SessionEngine.observe` / `submit` resolve and are checked against the SQLite read-back. `turn-queue` → `turn.started` committed is one fact's durable write; commit → subscriber is its publish. Artifact and ledger timings wrap the real store and ledger and are filed per Session through `AsyncLocalStorage`, which also joins VC-119 envelopes to turns.

- Cross-check facts (VC-119 envelope ↔ ledger event): turn start (`turn-queue` ↔ `turn.started`), first attempt (first `provider-attempt` ↔ first `usage.recorded`), authority answer (wait-bearing `authority` ↔ `interaction.resolved`), compaction (`compaction` ↔ `context.compacted`), final attempt (last of each), turn end (`turn` ↔ `turn.completed`).

- The control arms swap only the transcript-artifact store for the in-memory one. Unwatched arms have no subscriber; their stand-in person answers when `interaction.opened` commits.

File sync on the profile's volume (`FileHandle.sync()`, 600-byte file): one at a time p50 / p95 8.84 / 11.34 ms; 40 at once p50 / p95 82.8 / 165.2 ms each, 174.123 ms wall, 229.723 syncs/s.

Environment: Node v24.18.0 · darwin 25.5.0 · Apple M1 · 8 logical cores · 17179869184 bytes RAM · UV_THREADPOOL_SIZE 4 (default) · initial load [6.092,6.032,7.372] · commit 7c27285f18e795dbfde907136accfa38e4479fc0 (dirty=false).
