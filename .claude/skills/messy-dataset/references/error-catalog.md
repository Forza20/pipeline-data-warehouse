# Error catalog (13 types)

> Answer-key material. A model builder that is being scored must not read this file before the run.

Default: the seed picks 7–10 types. `-Errors` overrides. Each type lists how it is injected, the key
in `expected_findings.json`, and how a builder should detect it (the matching decision in the
`supabase-medallion-powerbi` interview in brackets).

| # | Type | Key | Injection | Detection [decision] |
|---|---|---|---|---|
| 1 | Mixed ID formats | `id_formats` | Customer and product ids in the fact and customer ids in the bridge are written in 4 formats per row: `CUST-0001`, `CUST0001`, `C0001`, `0001`. The second customer source uses `CUST0001` throughout. Dimensions keep the canonical `CUST-0001`. | Distinct patterns per key column; join rate before/after normalising. [R1-3] |
| 2 | Mixed date/amount/boolean formats | `mixed_formats` | Per fact row: date as `yyyy-MM-dd`, `dd.MM.yyyy`, `yyyyMMdd` or `MMM d yyyy`; amount as `1234.50`, `"1,234.50"`, `1234.50 DKK` or `"1.234,50"`; flag in 8 variants (`true/false`, `TRUE/FALSE`, `True/False`, `yes/no`, `Y/N`, `1/0`, `T/F`, `YES/NO`). | Regex classes per column; counts per pattern; bronze must be `text`. [R1-3 / silver parsing] |
| 3 | Duplicates without timestamp | `duplicates` | Extra rows with an existing business key, inserted after the original: identical copies (~1 %), date shifted 1–3 days (~0.8 %), amount changed ±5–25 % (~0.7 %). No created/modified column. | `count(*) > 1` per business key, then classify by which columns differ. Keep the original (first line; a changed amount fails quantity × price). [R2-5] |
| 4 | Orphan fact keys | `orphans` | 1–2 % of fact rows point at 8–25 customer ids above the dimension's range. | Anti-join fact → customer dimension (after id normalisation). Inferred members keep distinct counts right. [R2-4] |
| 5 | Many-to-many fanout | `bridge_fanout` | Each customer has 1 (50 %), 2 (35 %) or 3 (15 %) reps; ~4 % of pairs appear twice. | Reps per customer; duplicated pairs; naive join total vs allocated total. [R3-6] |
| 6 | Wide month columns with gaps | `wide_table` | ~8 % of the 12 month cells are empty. | Count empty cells; unpivot drops them (not zeros). [silver unpivot] |
| 7 | Revenue on non-revenue statuses | `status_revenue` | Non-revenue statuses keep their full amount (instead of 0). | Amount share per status. [R3-7] |
| 8 | Amount anomalies | `amount_anomalies` | ~0.4 % negative amounts, ~0.3 % spikes (6–15 × quantity × price), ~0.3 % zero amounts on the main revenue status (min. 3 each). Only on revenue-status rows. | Flags: `amount < 0`, `amount > 5 × qty × price`, `amount = 0 and status = <main>`. [R2-6] |
| 9 | Missing and future dates | `bad_dates` | ~0.5 % empty dates, ~0.3 % dates 30–900 days after the extract end (min. 3 each). | NULL after parsing; date > max plausible date. [R2-2 / R2-6] |
| 10 | Incomplete last month | `incomplete_month` | Data ends on day 3–20 of the last month. | Days present in the last month vs calendar days. [R3-2 / R3-3] |
| 11 | Versioned prices (SCD) | `scd_prices` | ~40 % of products (min. 3) get 1–3 price changes; facts use the price valid on their date; `list_price` is the latest. | More than one row per product in the price history; facts priced off-list. [R1-4 / R2-1] |
| 12 | Conflicting source attribute | `source_conflict` | ~12 % of customers (min. 3) have a different region in the second source. | Join the two customer sources and compare region. [R2-3] |
| 13 | Data dictionary lies | `lying_docs` | `DATA_DICTIONARY.md` gets a "Data quality notes" section with a wrong percentage for one injected problem (orphans, duplicates, source conflict or anomalies; duplicates at 0 % if none of those is injected). | Measure the claim and report claimed vs measured. [Phase 0: measure every quality claim] |

## Interactions

- Rows hit by 3, 8 and 9 are disjoint (a duplicate's original is a clean row). Orphans (4) can overlap
  anything.
- With 1 and 4 together, orphan ids also appear in all four formats.
- With 7 absent, non-revenue rows carry 0 – so a "revenue statuses" decision is still logged, but the
  numbers do not move.
- A type that is **not** injected must be checked and logged as "not applicable – checked", not
  invented. The scorecard counts an invented finding as an error.
