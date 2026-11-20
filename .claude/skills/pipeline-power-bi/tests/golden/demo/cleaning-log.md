# Cleaning log – Demo (run)

Every finding from the profile, what was chosen, and the Power Query step that does it. Every step can be
switched off later in Power BI Desktop → Transform data → *Applied steps*. Written by `build-docs.js`.

## orders.csv → staging `stg_orders` → fact_orders, dim_customers

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F01 | – | 2 | kept | – | `F01 Skip 2 title lines`, `F01 Promote headers`, `F01 Keep data columns` |
| F08 | Dato | 4 | kept | day-first | `F08 Parse Dato` |
| F15 | Dato | 1 | kept | flag | `F15 Flag Dato` |
| F05 | KundeID | 1 | kept | – | `F05 Trim KundeID` |
| F11 | KundeID | 2 | kept | K-999 | `F11 Normalise KundeID` |
| F07 | Region | 3 | kept | – | `F07 Unify Region spelling` |
| F09 | Beløb | 12 | kept | – | `F09 Parse Beløb` |
| F14 | Beløb | 1 | kept | flag | `F14 Flag Beløb` |
| F10 | Betalt | 12 | kept | – | `F10 Parse Betalt` |
| F19 | Note | 12 | kept | – | `F19 Remove empty column Note` |
| F28 | Kanal | 12 | not kept | – | – |
| F02 | – | 1 | kept | – | readable names in the model tables' final columns |
| F03 | – | 1 | kept | – | `F03 Remove empty rows` |
| F04 | – | 1 | kept | – | `F04 Remove total rows` |
| F12 | – | 1 | kept | – | `F12 Remove exact duplicates` |
| F17 | – | 8 | kept | – | `F17 Empty text to null`, `F17 Set types` |
| F18 | KundeID | 1 | kept | add-members | in dim_customers: `F18 Missing KundeID values`, `F18 Add missing KundeID values` |

Not kept: F28 Kanal (Code column: 3 numbers that stand for names (10, 20, 30) - add their names).

## customers.csv → staging `stg_customers` → dim_customers

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F27 | – | 1 | kept | remove | `F27 Remove test rows` |
| F02 | – | 1 | kept | – | readable names in the model tables' final columns |
| F17 | – | 3 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: none.

## Model steps

| Table | Step |
|---|---|
| fact_orders | `M10 Select and name columns` |
| dim_customers | `F18 Missing KundeID values` |
| dim_customers | `F18 Add missing KundeID values` |
| dim_customers | `M10 Select and name columns` |
