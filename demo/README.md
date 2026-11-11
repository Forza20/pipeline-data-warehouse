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

Choose "Accept all recommended" at each question for the quickest run. The report total after cleaning is
lower than the `I alt` row in the file, because the duplicate, the total row and (if you remove it) the future
order are taken out. `expected-values.md` in the run folder shows the numbers and which steps they assume.

The same files are the test fixtures in `.claude/skills/pipeline-power-bi/tests/fixtures/`.
