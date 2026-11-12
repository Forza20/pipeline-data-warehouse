# Model review – what a person must confirm

The profile and the design rules draft the model; they cannot know what the business means. Before the
build (step 4b, point 5) go through these six points with the user. Each gets **confirmed**, **changed**
(and the design is updated) or **open** (written to `choices.json` → `design.review` and listed in the
hand-over). Ask in one AskUserQuestion call per two or three points; put the drafted answer in the option
so the user can confirm with one click.

| # | Point | What to show the user | Evidence to measure (from the source files) | Typical mistake it catches |
|---|---|---|---|---|
| 1 | **Grain** of every fact | "One row in Sales = one order line" – and the column(s) that make a row unique | rows vs distinct values of the grain columns; header total vs sum of the lines | header amounts repeated on every line (double counting) |
| 2 | **Join paths** | Every relationship with its direction and the expected many-to-one; any fact reached through another fact or through a many-to-many | match % and orphan rows (profile `relations[]`); the most rows per key on the "one" side (must be 1) | fan-out: a sum that grows when a dimension is added |
| 3 | **Metric formulas** | Each headline measure in words: "Total sales = sum of line totals after discount, flagged anomalies excluded" | the headline total under the drafted formula and under the main alternative (before/after discount, with/without cancelled or test rows) – the difference in amount and % | revenue including cancelled orders, tax, or test rows |
| 4 | **History** (slowly changing attributes) | Attributes that change over time (customer region, product price, account manager) and whether the report shows *current* or *as it was* | keys with more than one value of the attribute across sheets or dates, and the amount on them; "not in the data" when only the current value exists | last year's sales moving to a customer's new region |
| 5 | **Access** (RLS) | Who may see which rows, and the column that decides it; users with no mapping see nothing | rows per mapped value; mapped users; rows whose deciding column is blank (seen by nobody) | a missing user seeing everything instead of nothing |
| 6 | **Names and meaning** | The report names of facts, measures and key columns, and any term that means two things | the measures and columns that share a word or a term | "Orders" counting lines in one place and orders in another |

**Every drafted point carries its evidence** – one number, measured before the user is asked, so the
choice is made on the size of the effect and not on a description of it. Compute it with a short script
over `data/` (apply the kept fixes; use the profile where it already holds the number, e.g. match % from
`relations[]`), put it in the question's option description ("Revenue = LineTotal (Recommended) – taking
the discount off would lower it by $24,857, 4.7 %; 99 of 200 lines have a discount"), and write it to the
point as `evidence`: `{ "value": "−$24,857 (−4.7 %)", "how": "SUM(LineTotal) vs SUM(LineTotal × (1 − DiscountPct)) in order_line_items; 99 of 200 lines discounted" }`.
A point with nothing to measure gets `"evidence": { "value": "not measurable", "how": "<why>" }`, so the gap
is visible. The summary, the overview page, the model context and the handover show the evidence next to
the point.

Write the result as:

```json
"review": [
  { "point": "grain", "status": "confirmed", "note": "Sales = order line; Order process = order",
    "evidence": { "value": "200 rows, 200 distinct LineID", "how": "order_line_items after the kept fixes" } },
  { "point": "history", "status": "open", "note": "Account manager changes are not tracked – current value only",
    "evidence": { "value": "not measurable", "how": "the sheets hold only the current account manager" } }
]
```

An **open** point is not a blocker; it is named in the overview page and the hand-over so it is not
forgotten. A **changed** point updates the design before step 5.
