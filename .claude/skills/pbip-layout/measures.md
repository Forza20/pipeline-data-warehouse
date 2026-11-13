# Measures and parameters the template needs

The template's pages use measures a model often lacks (last month, targets, gaps, a price adjustment) and
three parameters. Create only what the chosen pages need (template.json → `fields`, filtered by page) and
the model does not have. Names: the model's convention – snake_case in a pipeline-power-bi run
(`previous_month_sales`), otherwise like the model's own measures. Test every new measure with DAX.

**Where they go:**
- **A pipeline-power-bi run** (the run folder has `choices.json` with `build`): add the measures to
  `build.measures[]` (folder `Template`) and the parameters to `build.parameters[]` (pipeline-power-bi
  `references/build-spec.md`), then `node .claude\skills\pipeline-power-bi\scripts\rebuild.js runs\<run-id>`.
  Never write them into the TMDL by hand there – the next rebuild would remove them.
- **Any other project:** powerbi-modeling-mcp (`measure_operations`, `table_operations` for the
  parameters), or the TMDL directly with Desktop closed (SKILL.md → "Without powerbi-modeling-mcp").

`<Revenue>`, `<Orders>`, `<Profit>`, `<Returns>`, `<Customers>`, `<Cost>` are the measures mapped to the
template's `Total Revenue`, `Total Orders` …; `<Date>` is the date table's date column.

> Do **not** use the variable name `LastDate` – it collides with the DAX function `LASTDATE`.

## Previous month (Exec: the three monthly KPIs; Product: targets)
```dax
previous_month_sales  = CALCULATE ( [<Revenue>], DATEADD ( <Date>, -1, MONTH ) )
previous_month_orders = CALCULATE ( [<Orders>], DATEADD ( <Date>, -1, MONTH ) )
previous_month_<x>    = CALCULATE ( [<Returns>], DATEADD ( <Date>, -1, MONTH ) )   -- the third monthly KPI
previous_month_<p>    = CALCULATE ( [<Profit>], DATEADD ( <Date>, -1, MONTH ) )    -- for the profit target
```
Format like the base measure. The KPI visuals compare the latest month with the month before; if the data
ends in the middle of a month, set the KPI's date filter to whole months (`is_complete_month = TRUE` on the
date table when it has one).

## Targets (Product Detail: the three gauges)
Use the model's own targets when it has them (a target table: `target_revenue`). Otherwise the template's
rule – last month plus a growth the user confirms (template: 10 %):
```dax
order_target   = [previous_month_orders] * ( 1 + 0.10 )
sales_target   = [previous_month_sales] * ( 1 + 0.10 )
profit_target  = [previous_month_<p>] * ( 1 + 0.10 )
order_target_gap  = [<Orders>] - [order_target]
sales_target_gap  = [<Revenue>] - [sales_target]       -- or - [target_revenue]
profit_target_gap = [<Profit>] - [profit_target]
```

## Price adjustment (Product Detail: profit trend with a what-if slider)
Parameter (pipeline spec):
```json
{ "kind": "whatIf", "name": "price_adjustment_pct", "min": -1, "max": 1, "step": 0.1, "default": 0, "format": "0%" }
```
It makes the table `price_adjustment_pct` (one column, GENERATESERIES) and the measure
`price_adjustment_pct_value`. Then:
```dax
adjusted_sales        = [<Revenue>] * ( 1 + [price_adjustment_pct_value] )
adjusted_gross_margin = [adjusted_sales] - [<Cost>]
```
Map `Price Adjustment (%)[Price Adjustment (%)]` → `price_adjustment_pct[price_adjustment_pct]` and
`Measure Table[Adjusted Profit]` → `adjusted_gross_margin`.

## Field parameters (Product and Customer Detail: "which measure do I see")
```json
{ "kind": "fields", "name": "product_metric_selection", "items": [ { "label": "Orders", "measure": "orders" },
  { "label": "Revenue", "measure": "total_sales" }, { "label": "Profit", "measure": "gross_margin" },
  { "label": "Margin %", "measure": "gross_margin_pct" } ] }
{ "kind": "fields", "name": "customer_metric_selection", "items": [ { "label": "Customers", "measure": "customers" },
  { "label": "Revenue per customer", "measure": "sales_per_customer" } ] }
```
Each makes a table with `<name>` (the slicer), `<name>_fields` and `<name>_order` (hidden). Map
`Product Metric Selection[Product Metric Selection]` → `product_metric_selection[product_metric_selection]`
and `… Fields` → `product_metric_selection[product_metric_selection_fields]` (the same for Customer).
Outside a pipeline run, create them in Desktop (Modeling → New parameter → Fields) or as calculated
tables with `NAMEOF`, as the template's source report does.

## Customers (Customer Detail)
```dax
customers          = DISTINCTCOUNT ( <Fact>[<customer key>] )
sales_per_customer = DIVIDE ( [<Revenue>], [customers] )
```

## Formats
Keep the model's formats; the template's visuals set their own display units (K, M) like the source
report. Rates `0.0%`, amounts with the model's currency (`\$#,0`).
