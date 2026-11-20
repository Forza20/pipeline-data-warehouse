# Cleaning log – Retail (run)

Every finding from the profile, what was chosen, and the Power Query step that does it. Every step can be
switched off later in Power BI Desktop → Transform data → *Applied steps*. Written by `build-docs.js`.

## bridge_customer_sales_reps.csv → staging `stg_bridge_customer_sales_reps` → bridge_customer_sales_reps

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F11 | customer_id | 176 | kept | CUST-9999 | `F11 Normalise customer_id` |
| F02 | – | 3 | not kept | – | – |
| F12 | – | 7 | kept | – | `F12 Remove exact duplicates` |
| F17 | – | 3 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: F02 (3 of 3 names can be made readable (e.g. customer_id -> Customer ID, sales_rep_id -> Sales rep ID, sales_rep_name -> Sales rep name)).

## dim_customers.csv → staging `stg_dim_customers` → dim_customers

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F02 | – | 5 | not kept | – | – |
| F17 | – | 5 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: F02 (5 of 5 names can be made readable (e.g. customer_id -> Customer ID, customer_name -> Customer name, segment -> Segment)).

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

## fact_orders.csv → staging `stg_fact_orders` → fact_orders

| Fix | Column | Rows | Choice | Variant | Step |
|---|---|---|---|---|---|
| F08 | order_date | 1522 | kept | day-first | `F08 Parse order_date` |
| F11 | customer_id | 1467 | kept | CUST-9999 | `F11 Normalise customer_id` |
| F11 | product_id | 1544 | kept | PROD-9999 | `F11 Normalise product_id` |
| F09 | amount | 1122 | kept | – | `F09 Parse amount` |
| F14 | amount | 8 | kept | flag | `F14 Flag amount` |
| F14 | amount | 288 | kept | flag | `F14 Flag amount` |
| F10 | is_paid | 2000 | kept | – | `F10 Parse is_paid` |
| F14 | amount | 6 | kept | flag | `F14 Flag amount` |
| F14 | amount | 6 | kept | flag | `F14 Flag amount` |
| F02 | – | 10 | kept | – | readable names in the model tables' final columns |
| F12 | – | 18 | kept | – | `F12 Remove exact duplicates` |
| F13 | order_id | 25 | kept | keep-first | `F13 Keep first row per order_id` |
| F17 | – | 10 | kept | – | `F17 Empty text to null`, `F17 Set types` |

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
| F16 | jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec | 432 | kept | – | `F16 Unpivot Period`, `F16 Period as date` |
| F17 | – | 14 | kept | – | `F17 Empty text to null`, `F17 Set types` |

Not kept: none.

## Model steps

| Table | Step |
|---|---|
| bridge_customer_sales_reps | `M10 Select and name columns` |
| dim_customers | `M10 Select and name columns` |
| dim_locations | `M10 Select and name columns` |
| dim_products | `M10 Select and name columns` |
| fact_erp_customers | `M10 Select and name columns` |
| fact_orders | `M10 Select and name columns` |
| fact_hist_product_prices | `M10 Select and name columns` |
| fact_wide_monthly_targets | `M10 Select and name columns` |
