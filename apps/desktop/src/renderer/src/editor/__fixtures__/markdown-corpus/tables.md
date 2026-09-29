# Tables

## Alignment

| Left | Center | Right |
| :--- | :----: | ----: |
| a | b | c |
| `code` | **bold** | *italic* |
| [link](https://example.com) | ~~struck~~ | 1,234 |

## A decision log

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 1 | Tickets own their Sessions' history | A Session ends; the work does not | **Accepted** |
| 2 | One worktree per ticket | Parallel work without stepping on the main checkout | **Accepted** |
| 3 | Durable ids are UUIDs or content hashes | Nothing may depend on insertion order | **Accepted** |
| 4 | Settings are per project first | A global default is a fallback, not the source | *Proposed* |
| 5 | Delete the old theme picker | The canvas replaced it | ~~Rejected~~ **Accepted** |

## Cells with markup

| Command | What it does |
| --- | --- |
| `volli board` | Prints the board, one column per block. |
| `volli ticket show <id>` | Prints one ticket with its comments. |
| `volli ticket move <id> --to <column>` | Moves a ticket; the column is data. |
| `volli session list` | Lists Sessions with their **status**. |
| `a \| b` | An escaped pipe stays inside its cell. |

## Numbers

| Preset | Sessions | Tickets | Bytes |
|:-------|---------:|--------:|------:|
| small | 120 | 40 | 37.3 MB |
| real | 1,198 | 392 | 373 MB |
| 2x | 2,396 | 784 | 746 MB |
