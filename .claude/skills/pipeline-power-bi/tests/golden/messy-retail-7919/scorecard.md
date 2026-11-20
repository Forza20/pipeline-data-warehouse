# Scorecard – Retail

**Result: Failed** – 6/7 injected error types found; 35 numbers equal, 0 explained, 6 unexplained.

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
| 8 | Amount anomalies | yes | F14 | 300 rows flagged / 20 rows | ✅ found |
| 9 | Missing and future dates | no | – | 0 rows | ✔ not applicable – checked |
| 10 | Incomplete last month | yes | M01 | flagged / last date 2026-09-20 | ✅ found |
| 11 | Versioned prices (SCD) | yes | – | – / 24 products | ❌ missed |
| 12 | Conflicting source attribute | no | – | – | ✔ not applicable – checked |
| 13 | Data dictionary lies | yes | – | – | – out of scope (the skill does not read DATA_DICTIONARY.md) |

## 2. Numbers

Reference rules: revenue statuses Completed, Shipped; `amount_issue` = "ok"; months only for valid dates.

| Key | Answer key | This run | Difference | Explanation |
|---|---|---|---|---|
| fact_rows_after_dedupe | 1,957 | 1,957 | 0 | – |
| clean_rows | 1,662 | 1,670 | +8 | **?** |
| clean_revenue | 1,398,445.61 | 1,403,991.06 | +5,545.45 | **?** |
| unique_customers | 133 | 133 | 0 | – |
| revenue_by_category.Electronics | 41,126.26 | 41,927.1 | +800.84 | **?** |
| revenue_by_category.Home | 111,930.87 | 111,930.87 | 0 | – |
| revenue_by_category.Outdoor | 201,424.26 | 206,168.87 | +4,744.61 | **?** |
| revenue_by_category.Clothing | 256,863.62 | 256,863.62 | 0 | – |
| revenue_by_category.Toys | 417,629.14 | 417,629.14 | 0 | – |
| revenue_by_category.Books | 369,471.46 | 369,471.46 | 0 | – |
| customers_in_dimension | 133 | 133 | 0 | – |
| wide_long_rows | 432 | 432 | 0 | – |
| revenue_by_month.2024-05 | 49,180.15 | 49,180.15 | 0 | – |
| revenue_by_month.2024-06 | 46,443.75 | 46,443.75 | 0 | – |
| revenue_by_month.2024-07 | 53,100.16 | 53,100.16 | 0 | – |
| revenue_by_month.2024-08 | 39,118.57 | 39,118.57 | 0 | – |
| revenue_by_month.2024-09 | 40,828.06 | 40,828.06 | 0 | – |
| revenue_by_month.2024-10 | 62,621.25 | 62,621.25 | 0 | – |
| revenue_by_month.2024-11 | 42,509.94 | 42,509.94 | 0 | – |
| revenue_by_month.2024-12 | 59,613.06 | 59,613.06 | 0 | – |
| revenue_by_month.2025-01 | 48,658.29 | 48,658.29 | 0 | – |
| revenue_by_month.2025-02 | 42,203.94 | 43,004.78 | +800.84 | **?** |
| revenue_by_month.2025-03 | 44,058.47 | 44,058.47 | 0 | – |
| revenue_by_month.2025-04 | 59,738.46 | 59,738.46 | 0 | – |
| revenue_by_month.2025-05 | 48,499.3 | 48,499.3 | 0 | – |
| revenue_by_month.2025-06 | 43,522.18 | 48,266.79 | +4,744.61 | **?** |
| revenue_by_month.2025-07 | 39,329.13 | 39,329.13 | 0 | – |
| revenue_by_month.2025-08 | 54,199.09 | 54,199.09 | 0 | – |
| revenue_by_month.2025-09 | 33,892.47 | 33,892.47 | 0 | – |
| revenue_by_month.2025-10 | 40,044.92 | 40,044.92 | 0 | – |
| revenue_by_month.2025-11 | 45,876.6 | 45,876.6 | 0 | – |
| revenue_by_month.2025-12 | 60,346.02 | 60,346.02 | 0 | – |
| revenue_by_month.2026-01 | 46,827.52 | 46,827.52 | 0 | – |
| revenue_by_month.2026-02 | 44,050.29 | 44,050.29 | 0 | – |
| revenue_by_month.2026-03 | 49,474.34 | 49,474.34 | 0 | – |
| revenue_by_month.2026-04 | 67,865.54 | 67,865.54 | 0 | – |
| revenue_by_month.2026-05 | 62,850.09 | 62,850.09 | 0 | – |
| revenue_by_month.2026-06 | 48,327.3 | 48,327.3 | 0 | – |
| revenue_by_month.2026-07 | 45,469.6 | 45,469.6 | 0 | – |
| revenue_by_month.2026-08 | 48,618.73 | 48,618.73 | 0 | – |
| revenue_by_month.2026-09 | 31,178.39 | 31,178.39 | 0 | – |

## 3. Result

**Failed**

Errors:
- type 11 Versioned prices (SCD) not found
- clean_rows: 1,662 expected, 1,670 in the run
- clean_revenue: 1,398,445.61 expected, 1,403,991.06 in the run
- revenue_by_category.Electronics: 41,126.26 expected, 41,927.1 in the run
- revenue_by_category.Outdoor: 201,424.26 expected, 206,168.87 in the run
- revenue_by_month.2025-02: 42,203.94 expected, 43,004.78 in the run
- revenue_by_month.2025-06: 43,522.18 expected, 48,266.79 in the run

A **?** needs an explanation from a logged decision (answers-format.md → "Typical explained deviations") or a fix; follow the reconcile skill for one you cannot explain at once.
