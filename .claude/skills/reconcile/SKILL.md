---
name: reconcile
description: Use when two numbers that should agree do not, a report against its source, a rollup against its detail, two systems for the same table, to find where they diverge and why.
argument-hint: "[the two numbers or queries]"
---

# Reconcile

The job: two numbers that should match, the places where they stop matching, and the reasons. It reads, it changes no number.

Input: the two sides, the report, query or table of each, and the number each one gives.

## Steps

1. Name the two sides: the query, the table and the filter of each, and the number each one gives.
2. Make both sides comparable: the same grain, the same period, the same filters, the same currency and unit, the same time zone.
3. Compare the totals, then split by the dimensions until a difference sits in one slice: a day, a source, a status, a key.
4. In that slice, compare row by row: the rows only on one side, and the rows on both sides with different values.
5. Name the cause: a filter, a join that drops or doubles rows, a late delivery, a type conversion, a rounding, a time zone.
6. After each cause, show what is left of the difference, and go on until it is zero or inside the agreed tolerance.
7. Say which side is right, with the proof from the source.
8. Give the result as one web page.

## Output

One HTML file: the two numbers on top, the difference, the drill-down from the total to the slices, the rows behind each cause, and what is left after each cause.

## Reads

- both sides, the data contracts, the pipeline SQL, the query logs

## Writes

- the web page only

## In a pipeline-power-bi run

pipeline-power-bi loads this skill in its step 9 when a check's Difference is not 0 and no fix id explains
it. The two sides are the expected value (`expected-values.md`, from the source rows in `rows/`) and the
model's value (`checks.result.json`). Split with `source-stats.js runs/<run-id> --raw --queries <file>` on
the source side and DAX queries on the model side. Write the page to `runs/<run-id>/reconcile-<check>.html`
and hand the cause back to pipeline-power-bi, which fixes the step and rebuilds. Alone, this skill needs
no other skill.

## Never

- Never changes a number on either side.
- Never calls it a rounding difference without showing the rows.
