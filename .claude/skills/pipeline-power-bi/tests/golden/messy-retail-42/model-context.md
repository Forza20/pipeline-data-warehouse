# Retail – model context for AI assistants

Use this file as the definition of the model. Answer with the measures below – never re-derive a number from
raw columns when a measure exists. If a question uses a term from the glossary, use its measure. If a question
needs something the model does not hold, say so instead of guessing. Every number is subject to the access
rules: a user sees only the rows their role allows.

## Glossary

_No glossary yet – the measures below carry their own descriptions._

## Tables

### bridge_customer_sales_reps (fact)
Drafted from bridge_customer_sales_reps.csv.

| Column | Type | Meaning |
|---|---|---|
| customer_id | text | – |
| sales_rep_id | text | – |
| sales_rep_name | text | – |

### dim_customers (dimension)
Drafted from dim_customers.csv.

| Column | Type | Meaning |
|---|---|---|
| customer_id | text | – |
| customer_name | text | – |
| segment | text | – |
| region | text | – |
| signup_date | date | – |
| is_inferred | bool | – |

### dim_locations (dimension)
Drafted from dim_locations.csv.

| Column | Type | Meaning |
|---|---|---|
| location_id | text | – |
| location_name | text | – |
| city | text | – |
| country | text | – |

### dim_products (dimension)
Drafted from dim_products.csv.

| Column | Type | Meaning |
|---|---|---|
| product_id | text | – |
| product_name | text | – |
| category | text | – |
| list_price | number | – |

### fact_erp_customers (fact)
Drafted from erp_customers.csv.

| Column | Type | Meaning |
|---|---|---|
| customer_id | text | – |
| customer_name | text | – |
| region | text | – |

### fact_orders (fact)
Drafted from fact_orders.csv.

| Column | Type | Meaning |
|---|---|---|
| order_id | text | – |
| order_date | date | – |
| customer_id | text | – |
| product_id | text | – |
| location_id | text | – |
| quantity | int | – |
| unit_price | number | – |
| amount | number | – |
| status | text | – |
| is_paid | bool | – |
| amount_issue | text | – |

### fact_hist_product_prices (fact)
Drafted from hist_product_prices.csv.

| Column | Type | Meaning |
|---|---|---|
| product_id | text | – |
| price | number | – |
| valid_from | date | – |
| valid_to | date | – |

### fact_wide_monthly_targets (fact)
Drafted from wide_monthly_targets.csv.

| Column | Type | Meaning |
|---|---|---|
| location_id | text | – |
| year | int | – |
| period | text | – |
| value | number | – |
| period_start | date | – |

### dim_date (calendar)
Whole years covering fact_orders[order_date], fact_hist_product_prices[valid_from], fact_hist_product_prices[valid_to], fact_wide_monthly_targets[period_start]. `is_complete_month` marks months with data up to their last day.

## Relationships

All many-to-one, filtering from the one side (dimension) to the many side (fact).

- fact_orders[customer_id] → dim_customers[customer_id]
- bridge_customer_sales_reps[customer_id] → dim_customers[customer_id]
- fact_orders[product_id] → dim_products[product_id]
- fact_wide_monthly_targets[location_id] → dim_locations[location_id]
- fact_hist_product_prices[product_id] → dim_products[product_id]
- fact_erp_customers[customer_id] → dim_customers[customer_id]
- fact_orders[location_id] → dim_locations[location_id]
- fact_orders[order_date] → dim_date[date]
- fact_hist_product_prices[valid_from] → dim_date[date]
- fact_wide_monthly_targets[period_start] → dim_date[date]

## Measures

| Measure | Term | Meaning | Format | DAX |
|---|---|---|---|---|

## Access rules

- No row-level security: every viewer sees all rows.

## Known limits

- None recorded.

## Source

Files: <SRC>\ (folder parameter `SourceFolder`).
Cleaning steps per source are named after their fix (F01 …) in Power Query; see cleaning-log.md.
