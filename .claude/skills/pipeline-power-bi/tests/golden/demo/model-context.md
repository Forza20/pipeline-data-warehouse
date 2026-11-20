# Demo – model context for AI assistants

Use this file as the definition of the model. Answer with the measures below – never re-derive a number from
raw columns when a measure exists. If a question uses a term from the glossary, use its measure. If a question
needs something the model does not hold, say so instead of guessing. Every number is subject to the access
rules: a user sees only the rows their role allows.

## Glossary

_No glossary yet – the measures below carry their own descriptions._

## Tables

### fact_orders (fact)
Drafted from orders.csv.

| Column | Type | Meaning |
|---|---|---|
| ordrenr | text | – |
| dato | date | – |
| kunde_id | text | – |
| region | text | – |
| beloeb | number | – |
| betalt | bool | – |
| kanal | int | – |
| dato_status | text | – |
| beloeb_issue | text | – |

### dim_customers (dimension)
Drafted from customers.csv.

| Column | Type | Meaning |
|---|---|---|
| kunde_id | text | – |
| navn | text | – |
| segment | text | – |
| is_inferred | bool | – |

### dim_date (calendar)
Whole years covering fact_orders[dato].

## Relationships

All many-to-one, filtering from the one side (dimension) to the many side (fact).

- fact_orders[kunde_id] → dim_customers[kunde_id]
- fact_orders[dato] → dim_date[date]

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
