# Model health

Model: `pbip` · 48 columns · 10 relationships · facts: bridge_customer_sales_reps, fact_erp_customers, fact_hist_product_prices, fact_orders, fact_wide_monthly_targets

**14 warnings, 9 info.**

| | Finding | Where | Why / what to do |
|---|---|---|---|
| ⚠ | unused column | bridge_customer_sales_reps[sales_rep_name] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_erp_customers[customer_name] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_erp_customers[region] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_hist_product_prices[price] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_hist_product_prices[valid_to] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[amount] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[amount_issue] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[is_paid] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[quantity] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[status] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[unit_price] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_wide_monthly_targets[period] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_wide_monthly_targets[value] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_wide_monthly_targets[year] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ℹ | text key | bridge_customer_sales_reps[customer_id] → dim_customers[customer_id] | relationship on a text column – an integer surrogate key is smaller and faster |
| ℹ | text key | fact_erp_customers[customer_id] → dim_customers[customer_id] | relationship on a text column – an integer surrogate key is smaller and faster |
| ℹ | text key | fact_hist_product_prices[product_id] → dim_products[product_id] | relationship on a text column – an integer surrogate key is smaller and faster |
| ℹ | text key | fact_orders[customer_id] → dim_customers[customer_id] | relationship on a text column – an integer surrogate key is smaller and faster |
| ℹ | text key | fact_orders[location_id] → dim_locations[location_id] | relationship on a text column – an integer surrogate key is smaller and faster |
| ℹ | text key | fact_orders[product_id] → dim_products[product_id] | relationship on a text column – an integer surrogate key is smaller and faster |
| ℹ | text key | fact_wide_monthly_targets[location_id] → dim_locations[location_id] | relationship on a text column – an integer surrogate key is smaller and faster |
| ℹ | unused column | bridge_customer_sales_reps[sales_rep_id] | id in a fact – keep it only for drill-through or a detail table |
| ℹ | unused column | fact_orders[order_id] | id in a fact – keep it only for drill-through or a detail table |
