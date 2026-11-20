# Cleaning log – Retail (run)

Every finding from the profile, what was chosen, and the Power Query step that does it. Every step can be
switched off later in Power BI Desktop → Transform data → *Applied steps*. Written by `build-docs.js`.

## bridge_customer_sales_reps.csv → staging `stg_bridge_customer_sales_reps` → bridge_customer_sales_reps

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F11 | customer_id | 104 | kept | CUST-9999 | `F11 Normalise customer_id` |
| F02 | – | 3 | not kept | – | – |
| F17 | – | 3 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: F02 (3 of 3 names can be made readable (e.g. customer_id -> Customer ID, sales_rep_id -> Sales rep ID, sales_rep_name -> Sales rep name)).

## dim_customers.csv → staging `stg_dim_customers` → dim_customers

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F02 | – | 5 | kept | – | readable names in the model tables' final columns |
| F17 | – | 5 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: none.

## dim_locations.csv → staging `stg_dim_locations` → dim_locations

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F02 | – | 4 | not kept | – | – |
| F17 | – | 4 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: F02 (4 of 4 names can be made readable (e.g. location_id -> Location ID, location_name -> Location name, city -> City)).

## dim_products.csv → staging `stg_dim_products` → dim_products

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F02 | – | 4 | not kept | – | – |
| F17 | – | 4 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: F02 (4 of 4 names can be made readable (e.g. product_id -> Product ID, product_name -> Product name, category -> Category)).

## erp_customers.csv → staging `stg_erp_customers` → fact_erp_customers

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F02 | – | 3 | not kept | – | – |
| F17 | – | 3 | kept | – | `F17 Empty text to null`, `F17 Set types` |
| F11 | customer_id | 133 | kept | CUST-9999 | `F11 Normalise customer_id` |

Not kept: F02 (3 of 3 names can be made readable (e.g. customer_id -> Customer ID, customer_name -> Customer name, region -> Region)).

## fact_orders.csv → staging `stg_fact_orders` → dim_customers, fact_orders

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F08 | order_date | 1467 | kept | day-first | `F08 Parse order_date` |
| F11 | customer_id | 1488 | kept | CUST-9999 | `F11 Normalise customer_id` |
| F11 | product_id | 1494 | kept | PROD-9999 | `F11 Normalise product_id` |
| F09 | amount | 1153 | kept | – | `F09 Parse amount` |
| F14 | amount | 8 | kept | flag | `F14 Flag amount` |
| F14 | amount | 268 | kept | flag | `F14 Flag amount` |
| F14 | amount | 3 | kept | flag | `F14 Flag amount` |
| F10 | is_paid | 2000 | kept | – | `F10 Parse is_paid` |
| F02 | – | 10 | kept | – | readable names in the model tables' final columns |
| F17 | – | 10 | kept | – | `F17 Empty text to null`, `F17 Set types` |
| F18 | customer_id | 34 | kept | add-members | in dim_customers: `F18 Missing customer_id values`, `F18 Add missing customer_id values` |

Not kept: none.

## hist_product_prices.csv → staging `stg_hist_product_prices` → fact_hist_product_prices

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F02 | – | 4 | not kept | – | – |
| F17 | – | 4 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: F02 (4 of 4 names can be made readable (e.g. product_id -> Product ID, price -> Price, valid_from -> Valid from)).

## wide_monthly_targets.csv → staging `stg_wide_monthly_targets` → fact_wide_monthly_targets

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F02 | – | 14 | kept | – | readable names in the model tables' final columns |
| F16 | jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec | 397 | kept | – | `F16 Unpivot Period`, `F16 Period as date` |
| F17 | – | 14 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: none.

## Model steps

| Table | Step |
|---|---|
| bridge_customer_sales_reps | `M10 Select and name columns` |
| dim_customers | `F18 Missing customer_id values` |
| dim_customers | `F18 Add missing customer_id values` |
| dim_customers | `M10 Select and name columns` |
| dim_locations | `M10 Select and name columns` |
| dim_products | `M10 Select and name columns` |
| fact_erp_customers | `M10 Select and name columns` |
| fact_orders | `M10 Select and name columns` |
| fact_hist_product_prices | `M10 Select and name columns` |
| fact_wide_monthly_targets | `M10 Select and name columns` |
