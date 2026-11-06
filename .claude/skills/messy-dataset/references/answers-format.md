# Answer key format and reference rules

> Answer-key material. A model builder that is being scored must not read this file before the run.

Both files are UTF-8 JSON with stable key order. Amounts are in the run's currency (`-Currency`, default USD) with 2 decimals.

## expected_findings.json

```json
{
  "run_id": "2026-10-30_hotel_s42", "domain": "hotel", "seed": 42, "rows": 20000,
  "errors": [1, 3, 4, 5, 7, 8, 9, 10],
  "injected": { "duplicates": { "identical": 210, "shifted_date": 180, "other_amount": 150, "extra_rows": 540 } },
  "not_injected": ["mixed_formats", "wide_table", "scd_prices", "source_conflict", "lying_docs"],
  "generator_version": "1.0.0"
}
```

`injected` has one block per injected type (keys from `error-catalog.md`):

| Key | Fields |
|---|---|
| `id_formats` | `canonical`, `tables.<table>.<column>` = list of formats used |
| `mixed_formats` | `table`, `columns.<column>` = list of `{variant, rows}` (rows after dedupe; dates exclude empty ones) |
| `duplicates` | `business_key`, `identical`, `shifted_date`, `other_amount`, `extra_rows`, `has_timestamp` |
| `orphans` | `column`, `dimension`, `rows`, `ids`, `id_range` (canonical ids), `clean_revenue_on_orphans` |
| `bridge_fanout` | `customers_by_rep_count` {1,2,3}, `raw_rows`, `distinct_pairs`, `duplicated_pairs`, `naive_total`, `correct_total` |
| `wide_table` | `rows`, `month_columns`, `empty_cells`, `expected_long_rows` |
| `status_revenue` | `revenue_statuses`, `non_revenue_statuses`, `by_status.<status>` = `{rows, amount, share_pct}` (after dedupe, before anomaly exclusion) |
| `amount_anomalies` | `negative`, `spike`, `zero_on_status`, `zero_status`, `spike_rule` |
| `bad_dates` | `column`, `missing`, `future`, `extract_end` |
| `incomplete_month` | `last_date`, `last_complete_month` |
| `scd_prices` | `products`, `products_with_changes`, `versions` |
| `source_conflict` | `attribute`, `sources`, `customers`, `conflicts` |
| `lying_docs` | `file`, `topic`, `claimed_pct`, `actual_pct` |

## expected_values.json

| Key | Meaning |
|---|---|
| `tables` | data rows per CSV file |
| `fact_rows_in_file` / `fact_rows_after_dedupe` | before / after removing duplicate business keys |
| `clean_rows`, `clean_revenue` | rows and amount that count as revenue (rules below) |
| `unique_customers` | distinct customer ids among clean rows, **orphan ids included** (inferred members) |
| `customers_in_dimension` | rows in the customer dimension |
| `revenue_by_category` | clean revenue per category/class/tier (orphans included – the product is known) |
| `revenue_by_month` | clean revenue per `yyyy-MM`; rows with a missing or future date are left out |
| `revenue_without_valid_date` | clean revenue on rows with a missing or future date (in the total, not in any month) |
| `first_date`, `last_date`, `latest_complete_month` | data range; the latest complete month is the month before the last when error 10 is injected |
| `revenue_latest_complete_month`, `revenue_previous_month` | for month-over-month cards |
| `bridge.naive_total` | clean revenue joined through every raw bridge row (fanout + duplicated pairs) – the wrong number |
| `bridge.correct_total` | clean revenue of customers that have a rep, allocated 1/n over distinct pairs |
| `bridge.revenue_without_rep` | clean revenue on customers without a bridge row (the orphans) |
| `wide_long_rows` | rows after unpivoting the wide targets and dropping empty cells |

## Reference rules

The expected numbers follow these rules. A run may decide differently (and log it); the scorecard
then explains the difference with that decision instead of counting it as an error.

1. **Duplicates:** one row per business key; the original (first line in the file) wins. Shifted
   dates and changed amounts are never kept.
2. **Revenue statuses:** only the two revenue statuses count. Non-revenue statuses are excluded even
   when they carry an amount (error 7).
3. **Amount anomalies:** negative amounts, spikes (> 5 × quantity × unit price) and zero amounts on the
   main revenue status are excluded from revenue (flagged, not deleted).
4. **Dates:** rows with a missing or future date stay in the total and in per-category/per-customer
   numbers, but are not in any month.
5. **Orphans:** kept, with one inferred member per unknown id; they count as distinct customers.
6. **Prices:** the fact's own unit price (valid at the row date) is the truth; amounts are not
   recalculated from `list_price`.
7. **Bridge:** revenue is allocated 1/n over distinct customer–rep pairs; duplicated pairs are removed.
8. **Wide targets:** empty cells are dropped, not turned into 0.
9. **Source conflict:** the expected numbers do not depend on which region wins; the decision only has
   to be logged.
10. **Latest complete month:** with error 10 the last month is incomplete and month-over-month cards
    compare the two months before it.

## Typical explained deviations

| Logged decision | Effect on the numbers |
|---|---|
| Keep the highest-scoring duplicate instead of the first line | none for identical / changed amount; a shifted date can move revenue between months |
| Count non-revenue statuses with an amount | `clean_revenue` higher by their amount |
| Keep spikes | `clean_revenue` higher by the spike amounts |
| Drop rows with bad dates | `clean_revenue` lower by `revenue_without_valid_date` |
| One "Unknown" customer instead of inferred members | `unique_customers` lower by `orphans.ids − 1` |
| Credit every rep in full | bridge total = `naive_total` without duplicated pairs |
