# Scorecard – Retail

**Result: Passed** – 7/7 injected error types found; 41 numbers equal, 0 explained, 0 unexplained.

Dataset: retail, seed 7919, 2000 rows, error types 1, 2, 3, 5, 8, 10, 11, 13. Scored by `score-run.js` against the answer key in `answers`; numbers recomputed from the source files with this run's cleaning (source-stats.js).

## 1. Errors found

| # | Type | Injected? | Fix | Found / answer key | Verdict |
|---|---|---|---|---|---|
| 1 | Mixed ID formats | yes | F11 | 4 id columns / 4 id columns | ✅ found |
| 2 | Mixed date/amount/boolean formats | yes | F08, F09, F10 | 3 columns / 3 columns | ✅ found |
| 3 | Duplicates without timestamp | yes | F12, F13 | 43 rows / 43 rows | ✅ found |
| 4 | Orphan fact keys | no | – | 0 rows | ✔ not applicable – checked |
| 5 | Many-to-many fanout | yes | F12 | 7 duplicated pairs / 7 duplicated pairs | ✅ found |
| 6 | Wide month columns with gaps | no | F16 | unpivoted | ✔ not applicable – checked |
| 7 | Revenue on non-revenue statuses | no | – | – | ✔ not applicable – checked |
| 8 | Amount anomalies | yes | F14 | 20 rows flagged / 20 rows | ✅ found |
| 9 | Missing and future dates | no | – | 0 rows | ✔ not applicable – checked |
| 10 | Incomplete last month | yes | M01 | flagged / last date 2026-09-20 | ✅ found |
| 11 | Versioned prices (SCD) | yes | M03 | 24 products / 24 products | ✅ found |
| 12 | Conflicting source attribute | no | – | – | ✔ not applicable – checked |
| 13 | Data dictionary lies | yes | – | – | – out of scope (the skill does not read DATA_DICTIONARY.md) |

## 2. Numbers

Reference rules: revenue statuses Completed, Shipped; `amount_issue` = "ok"; months only for valid dates.

| Key | Answer key | This run | Difference | Explanation |
|---|---|---|---|---|
| fact_rows_after_dedupe | 1,957 | 1,957 | 0 | – |
| clean_rows | 1,662 | 1,662 | 0 | – |
| clean_revenue | 1,398,445.61 | 1,398,445.61 | 0 | – |
| unique_customers | 133 | 133 | 0 | – |
| revenue_by_category | 6 values | all 6 equal | 0 | – |
| customers_in_dimension | 133 | 133 | 0 | – |
| wide_long_rows | 432 | 432 | 0 | – |
| revenue_by_month | 29 months | all 29 equal | 0 | – |

## 3. Result

**Passed**

A **?** needs an explanation from a logged decision (answers-format.md → "Typical explained deviations") or a fix; follow the reconcile skill for one you cannot explain at once.
