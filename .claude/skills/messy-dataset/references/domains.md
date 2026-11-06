# Domains

Every domain has the same roles, so downstream skills (for example `pbip-layout`) can always map
revenue, count, customer, product, category and date – only the names differ.

## Role contract

| Role | retail | hotel | saas |
|---|---|---|---|
| Fact (amount, date, status, quantity) | `fact_orders` | `fact_bookings` (nights × rate) | `fact_invoices` (MRR lines, seats × seat price) |
| Customer | `dim_customers` | `dim_guests` | `dim_accounts` |
| Product | `dim_products` | `dim_room_types` | `dim_plans` |
| Category (column on product) | `category` | `room_class` | `plan_tier` |
| Location / geography | `dim_locations` | `dim_hotels` | `dim_regions` |
| Many-to-many bridge | `bridge_customer_sales_reps` | `bridge_guest_agencies` | `bridge_account_managers` |
| Wide targets (12 month columns) | `wide_monthly_targets` (currency) | `wide_occupancy_targets` (%) | `wide_mrr_targets` (currency) |
| Price history (SCD) | `hist_product_prices` | `hist_room_rates` | `hist_plan_prices` |
| Second customer source | `erp_customers` (ERP) | `pms_guests` (PMS) | `billing_accounts` (Billing) |
| Revenue statuses | Completed, Shipped | Checked-out, Invoiced | Paid, Invoiced |
| Non-revenue statuses | Cancelled, Returned | Cancelled, No-show | Refunded, Trial |

`DATA_DICTIONARY.md` explains every status in business terms (e.g. "Invoiced = stay completed, invoice
sent, not yet paid"), so a builder can tell earned-but-unpaid from open. Until 1.0.1 the second revenue
status was `Confirmed` (hotel) / `Open` (saas); a builder in run `2026-10-30_hotel_s42` read `Confirmed` as an
open booking and excluded 13.6 % of revenue – a defensible decision caused by the name.

All eight tables exist in every run, also when the related error type is not injected (then the
table is simply clean: one price version per product, one rep per customer, no empty target cells,
regions that agree).

## Columns

Fact: `<fact id>, <date>, <customer id>, <product id>, <location id>, <quantity>, <unit price>, amount,
status, <flag>`

| | retail | hotel | saas |
|---|---|---|---|
| fact id | `order_id` (`ORD-000001`) | `booking_id` (`BKG-…`) | `invoice_id` (`INV-…`) |
| date | `order_date` | `stay_date` | `invoice_date` |
| quantity | `quantity` 1–6 | `nights` 1–8 | `seats` 1–40 |
| unit price | `unit_price` 5–500 | `nightly_rate` 600–3500 | `seat_price` 10–200 |
| flag (boolean) | `is_paid` | `is_prepaid` | `is_autorenew` |

- Customer dimension: `<id>, <name>, segment, region, signup_date`. Ids `CUST-0001` / `GST-0001` /
  `ACC-0001`. Count = max(50, rows / 15). Region is one of North, South, East, West, Central.
- Product dimension: `<id>, <name>, <category>, list_price` (current price). retail 60 products in 6
  categories, hotel 20 room types in 5 classes, saas 12 plans in 4 tiers. Price rises with category.
- Location dimension: `<id>, <name>, city, country`. retail 12 stores, hotel 8 hotels, saas 6 regions.
- Bridge: `<customer id>, <rep id>, <rep name>`.
- Wide targets: `<location id>, year, jan … dec`, one row per location and calendar year in range.
- Price history: `<product id>, price, valid_from, valid_to` (empty `valid_to` = current).
- Second source: `<customer id>, <name>, region`.

## Grain and amounts

- One fact row per business key (`order_id` …). Amount = quantity × unit price, where unit price is
  the price valid on the row's date in the price history.
- Status mix ≈ 75 % / 12 % revenue, 8 % / 5 % non-revenue. Non-revenue rows have amount 0 unless
  error 7 is injected.
- Dates span 24–36 whole months ending in `-EndMonth` (default 2026-09). With error 10 the data
  stops on day 3–20 of that month.
- Wide targets cover whole calendar years, so months before the first and after the last data month
  have targets but no facts (by design, not an error type).
