# Demo files for `/pipeline-power-bi`

Two small, made-up files to try the skill without your own data. Nothing in them is real.

| File | What it is | What the skill should find |
|---|---|---|
| `orders.csv` | 12 order rows (11 orders), semicolon-separated, Danish number and date formats | two title lines above the header, four date formats, amounts like `1.234,50`, `ja`/`Ja`/`NEJ`, ids `K002` and `K-003 ` next to `K-001`, region case variants (`nord`/`SYD`), a duplicated order, an empty row and an `I alt` total row, a date in 2030, a negative amount, a channel code column (10/20/30), an empty `Note` column with `N/A`, and customer `K-009`, which is not in the customer list |
| `customers.csv` | 5 customers, comma-separated | a `TEST ACCOUNT` row |

Run it:

```
/pipeline-power-bi demo --name Demo
```

Choose "Accept all recommended" at each question for the quickest run (10–12 minutes without the extras,
20–30 minutes with dashboard, catalog and governance). With the recommended steps the report should show
Total sales 4,054.70, 11 orders, 5 customers and a paid share of 63.6 %. That is not the file's `I alt` row
(4,147.45), which does not even match its own rows: the copy of order 1002 is removed, and the negative amount
(order 1003) and the order dated 2030 (order 1010) are flagged and left out of Total sales.
`expected-values.md` in the run folder shows every number and which steps it assumes.

The same files are the test fixtures in `.claude/skills/pipeline-power-bi/tests/fixtures/`.
