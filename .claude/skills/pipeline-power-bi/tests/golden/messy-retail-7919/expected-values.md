# Expected values – Retail (run)

Computed from the source files with the kept cleaning steps, not from the model. "In Power BI" and "Difference"
are written by `record-checks.js` after a refresh and a run of `checks.dax`. Rows marked (auto) are model checks
added by `build-docs.js`.

| Check | Expected | Assumes | In Power BI | Difference |
|---|---|---|---|---|
| bridge_customer_sales_reps rows | 234 | – | | |
| dim_customers rows | 133 | – | | |
| dim_locations rows | 12 | – | | |
| dim_products rows | 60 | – | | |
| dim_products sum of list_price | 15,612.42 | – | | |
| fact_erp_customers rows | 133 | – | | |
| fact_orders rows | 1,957 | – | | |
| fact_orders sum of quantity | 6,817 | – | | |
| fact_orders sum of unit_price | 473,413.58 | – | | |
| fact_orders sum of amount | 1,450,060.57 | – | | |
| fact_hist_product_prices rows | 113 | – | | |
| fact_hist_product_prices sum of price | 29,620.87 | – | | |
| fact_wide_monthly_targets rows | 432 | – | | |
| fact_wide_monthly_targets sum of year | 874,800 | – | | |
| fact_wide_monthly_targets sum of value | 1,781,400 | – | | |
| fact_orders rows without dim_customers (auto) | 0 | relationship fact_orders[customer_id] → dim_customers[customer_id] | | |
| bridge_customer_sales_reps rows without dim_customers (auto) | 0 | relationship bridge_customer_sales_reps[customer_id] → dim_customers[customer_id] | | |
| fact_orders rows without dim_products (auto) | 0 | relationship fact_orders[product_id] → dim_products[product_id] | | |
| fact_wide_monthly_targets rows without dim_locations (auto) | 0 | relationship fact_wide_monthly_targets[location_id] → dim_locations[location_id] | | |
| fact_hist_product_prices rows without dim_products (auto) | 0 | relationship fact_hist_product_prices[product_id] → dim_products[product_id] | | |
| fact_erp_customers rows without dim_customers (auto) | 0 | relationship fact_erp_customers[customer_id] → dim_customers[customer_id] | | |
| fact_orders rows without dim_locations (auto) | 0 | relationship fact_orders[location_id] → dim_locations[location_id] | | |
| fact_orders rows without dim_date (auto) | 0 | relationship fact_orders[order_date] → dim_date[date] | | |
| fact_hist_product_prices rows without dim_date (auto) | 0 | relationship fact_hist_product_prices[valid_from] → dim_date[date] | | |
| fact_wide_monthly_targets rows without dim_date (auto) | 0 | relationship fact_wide_monthly_targets[period_start] → dim_date[date] | | |
