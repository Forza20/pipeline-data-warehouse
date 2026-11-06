# DAX templates for the layout

Replace `<Fact>`, `<DateTable>`, `<Base>` etc. with the model's names. Create them in the model's measure
table; helper measures in the display folder `Dashboard`. Test every measure with DAX after creating it.

> Do **not** use the variable name `LastDate` – it collides with the DAX function `LASTDATE`.

## Month axis (calculated column on the date table, if missing)
```dax
MonthStart = DATE(YEAR(<DateTable>[Date]), MONTH(<DateTable>[Date]), 1)
```
formatString `mmm yyyy`. Then run a Calculate refresh of the date table.

## Latest month / previous month (one set per monthly card)
```dax
<base>_cm =
VAR MaxSalesDate = CALCULATE(MAX(<Fact>[<OrderDate>]), REMOVEFILTERS(<DateTable>))
RETURN CALCULATE([<Base>], REMOVEFILTERS(<DateTable>),
    <DateTable>[Date] > EOMONTH(MaxSalesDate, -1),
    <DateTable>[Date] <= EOMONTH(MaxSalesDate, 0))

<base>_pm =
VAR MaxSalesDate = CALCULATE(MAX(<Fact>[<OrderDate>]), REMOVEFILTERS(<DateTable>))
RETURN CALCULATE([<Base>], REMOVEFILTERS(<DateTable>),
    <DateTable>[Date] > EOMONTH(MaxSalesDate, -2),
    <DateTable>[Date] <= EOMONTH(MaxSalesDate, -1))

<base>_label =
VAR cm = [<base>_cm]
VAR pm = [<base>_pm]
RETURN "Previous month: " & FORMAT(pm, "#,0") & " (" & FORMAT(DIVIDE(cm - pm, pm), "+0.0%;-0.0%;0.0%") & ")"

<base>_cm_color = IF([<base>_cm] < [<base>_pm], "#D64550", "#252423")
```

For key figures where lower is better (returns, cancellations, churn), reverse the colour: a rise is
`#D64550`, a fall `#252423`:
```dax
<base>_cm_color = IF([<base>_cm] > [<base>_pm], "#D64550", "#252423")
```

**If the data ends in the middle of a month** (e.g. last date 7 September): compare the latest *whole* month
with the month before – move the windows above back one month, or use the model's "latest complete month"
measure. The same applies to the **sparkline** (`sparkMeasure` in the config): otherwise the line ends with a
sharp drop in the incomplete month. Use the date table's `is_complete_month` if it exists, otherwise:
```dax
<base>_spark =
VAR MaxSalesDate = CALCULATE(MAX(<Fact>[<OrderDate>]), REMOVEFILTERS(<DateTable>))
VAR LastFullDay  = IF(MaxSalesDate = EOMONTH(MaxSalesDate, 0), MaxSalesDate, EOMONTH(MaxSalesDate, -1))
RETURN IF(MAX(<DateTable>[Date]) <= LastFullDay, [<Base>])
```
One `_spark` measure per monthly card; the trend chart uses the same rule.

## Margin (if there is a cost price)
```dax
total_cost       = SUMX(<Fact>, <Fact>[quantity] * <Fact>[cost])     -- check whether cost is per unit or per line
gross_margin     = [<Revenue>] - [total_cost]
gross_margin_pct = DIVIDE([gross_margin], [<Revenue>])               -- formatString 0.0%
```

## "Top" text for highlight tiles
```dax
top_<dim> =
VAR Items = FILTER(VALUES(<DimTable>[<Column>]), NOT ISBLANK(<DimTable>[<Column>]))
VAR Top1  = TOPN(1, Items, [<Measure>], DESC)
RETURN CONCATENATEX(Top1, <DimTable>[<Column>], ", ")
```

## Format
All number measures: `#,0` (whole numbers); amounts may add the model's currency symbol (e.g. `$#,0`,
`#,0 €`). Percentages: `0.0%`.
