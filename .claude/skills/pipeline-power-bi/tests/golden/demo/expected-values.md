# Expected values – Demo (run)

Computed from the source files with the kept cleaning steps, not from the model. "In Power BI" and "Difference"
are written by `record-checks.js` after a refresh and a run of `checks.dax`. Rows marked (auto) are model checks
added by `build-docs.js`.

| Check | Expected | Assumes | In Power BI | Difference |
|---|---|---|---|---|
| fact_orders rows | 11 | – | | |
| fact_orders sum of beloeb | 4,049.70 | – | | |
| fact_orders sum of kanal | 210 | – | | |
| dim_customers rows | 5 | – | | |
| fact_orders rows without dim_customers (auto) | 0 | relationship fact_orders[kunde_id] → dim_customers[kunde_id] | | |
| fact_orders rows without dim_date (auto) | 0 | relationship fact_orders[dato] → dim_date[date] | | |
| Test rows left in dim_customers (K-100) (auto) | 0 | F27 | | |
