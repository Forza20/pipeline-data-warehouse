# Demo files for the Business dashboard

Made-up sample data for pbip-layout's **Business** template (Home + Marketing, Sales and Finance modules),
taken from the template's own model. Nothing in it is real. Unlike `demo/orders.csv` the files are clean:
they test the dashboard (template choice, data contract, measures, pages), not the cleaning.

| File | Rows | Module | Grain |
|---|---|---|---|
| `marketing_daily.csv` | 272 | Marketing | date × campaign × channel × content type: leads, MQLs, SQLs, conversions, spend, attributed revenue, engagements, downloads |
| `campaigns.csv` | 8 | Marketing | one row per campaign |
| `channels.csv` | 4 | Marketing | SEO, SEM, Social, Content … |
| `opportunities.csv` | 468 | Sales | one row per deal: created / close date, stage (`Closed Won`, `Closed Lost`, `Open`), amount, new-customer flag, cycle days, pipeline stage, age bucket |
| `sales_targets.csv` | 126 | Sales | quota per rep per month |
| `sales_reps.csv` | 6 | Sales | rep, team, territory |
| `customers.csv` | 60 | Sales | customer name, segment, country |
| `products.csv` | 9 | Sales | product, category |
| `ledger.csv` | 420 | Finance | one row per ledger entry: amount (positive), operating cash movement, description, status (`Confirmed`, `Pending`, `Reversed`) |
| `accounts.csv` | 11 | Finance | account name, type (`Revenue`, `COGS`, `OpEx`, `Other`), expense category |

Dates run from January 2023 to September 2024; open deals have an expected close date up to December 2024.

Run it:

```
/pipeline-power-bi demo/business --name BusinessDemo
```

Choose **Business** in step 6 (it should be the recommended template) and all three modules. The data
contract should map by name with no value mapping (the stages, account types and statuses are the
template's own), and `gen-measures.js` should make all 100 measures.

Expected values (from the CSV files; Finance leaves `Reversed` entries out):

| KPI | 2023 | 2024 (Jan–Sep) |
|---|---|---|
| Closed-won revenue | 2,734,250 | 2,815,320 |
| Win rate | 37.2 % | 38.1 % |
| New customers | 48 | 9 |
| MQLs | 2,610 | 2,623 |
| Marketing spend | 194,476.94 | 187,065.26 |
| Revenue (Finance) | 5,459,065.98 | 4,549,252.08 |
| Operating expenses | 2,189,785.69 | 1,727,155.85 |
| Net profit margin | 24.6 % | 24.9 % |

2024 is a part year, so its YoY figures compare January–September 2024 with the same months of 2023
(`SAMEPERIODLASTYEAR`); filter the report to 2024 to see them.
