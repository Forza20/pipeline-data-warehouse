# Expected values – Retail (run)

Computed from the source files with the kept cleaning steps, not from the model. "In Power BI" and "Difference"
are written by `record-checks.js` after a refresh and a run of `checks.dax`. Rows marked (auto) are model checks
added by `build-docs.js`.

| Check | Expected | Assumes | In Power BI | Difference |
|---|---|---|---|---|
| bridge_customer_sales_reps rows | 133 | – | | |
| dim_customers rows | 155 | – | | |
| dim_locations rows | 12 | – | | |
| dim_products rows | 60 | – | | |
| dim_products sum of list_price | 15,835.26 | – | | |
| fact_erp_customers rows | 133 | – | | |
| fact_orders rows | 2,000 | – | | |
| fact_orders sum of quantity | 7,099 | – | | |
| fact_orders sum of unit_price | 518,999.39 | – | | |
| fact_orders sum of amount | 1,640,687.12 | – | | |
| fact_hist_product_prices rows | 98 | – | | |
| fact_hist_product_prices sum of price | 25,772.88 | – | | |
| fact_wide_monthly_targets rows | 432 | – | | |
| fact_wide_monthly_targets sum of year | 874,800 | – | | |
| fact_wide_monthly_targets sum of value | 1,646,500 | – | | |
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
