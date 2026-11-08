# Model review – what a person must confirm

The profile and the design rules draft the model; they cannot know what the business means. Before the
build (step 4b, point 5) go through these six points with the user. Each gets **confirmed**, **changed**
(and the design is updated) or **open** (written to `choices.json` → `design.review` and listed in the
hand-over). Ask in one AskUserQuestion call per two or three points; put the drafted answer in the option
so the user can confirm with one click.

| # | Point | What to show the user | Typical mistake it catches |
|---|---|---|---|
| 1 | **Grain** of every fact | "One row in Sales = one order line" – and the column(s) that make a row unique | header amounts repeated on every line (double counting) |
| 2 | **Join paths** | Every relationship with its direction and the expected many-to-one; any fact reached through another fact or through a many-to-many | fan-out: a sum that grows when a dimension is added |
| 3 | **Metric formulas** | Each headline measure in words: "Total sales = sum of line totals after discount, flagged anomalies excluded" | revenue including cancelled orders, tax, or test rows |
| 4 | **History** (slowly changing attributes) | Attributes that change over time (customer region, product price, account manager) and whether the report shows *current* or *as it was* | last year's sales moving to a customer's new region |
| 5 | **Access** (RLS) | Who may see which rows, and the column that decides it; users with no mapping see nothing | a missing user seeing everything instead of nothing |
| 6 | **Names and meaning** | The report names of facts, measures and key columns, and any term that means two things | "Orders" counting lines in one place and orders in another |

Write the result as:

```json
"review": [
  { "point": "grain", "status": "confirmed", "note": "Sales = order line; Order process = order" },
  { "point": "history", "status": "open", "note": "Account manager changes are not tracked – current value only" }
]
```

An **open** point is not a blocker; it is named in the overview page and the hand-over so it is not
forgotten. A **changed** point updates the design before step 5.
