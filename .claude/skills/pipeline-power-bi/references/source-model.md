# Source model templates for CSV and Excel (PBIP / TMDL)

The project layout, entry files, `model.tmdl`, date table, relationships, measure table, minimal report
and formatting defaults are the same as in
[`../../supabase-medallion-powerbi/references/tmdl-templates.md`](../../supabase-medallion-powerbi/references/tmdl-templates.md)
sections 1, 2, 4, 6–11. Read those sections there. This file replaces only the parts that differ for
files: section 3 (parameters → folder parameter and functions) and section 5 (import table → a CSV or
Excel partition with the chosen fix steps).

TMDL rules that break loading when ignored: **tabs** for indentation, quote names with spaces
(`'Order date'`), a fresh GUID for every `lineageTag` (`[guid]::NewGuid()`), no `///` on relationships,
Power BI Desktop closed while files are written.

## 1. Parameters and functions (expressions.tmdl)

`SourceFolder` ends with a backslash. Every table reads `SourceFolder & "<file>.csv"` or
`SourceFolder & "<file>.xlsx"`, so moving the files is one parameter change (Power BI Desktop →
Transform data → Manage parameters).

```
/// Folder that holds the source files (CSV and Excel). Ends with a backslash.
expression SourceFolder = "C:\Users\me\Data\sales\" meta [IsParameterQuery = true, Type = "Text", IsParameterQueryRequired = true]
	lineageTag: 00000000-0000-0000-0000-000000000001
	queryGroup: Parameters

	annotation PBI_ResultType = Text
```

Add only the functions a chosen fix uses. Each function is an `expression` in `queryGroup: Functions`
with `annotation PBI_ResultType = Function`; the body is indented two tabs.

All four take **any** value: CSV gives text, but an Excel column can mix real dates, numbers and
true/false with text in the same column (`2025-01-03` as a date cell next to `"20-01-2025"` typed as
text). Typed values pass through unchanged; only text is parsed.

### fnParseDate (F08)
```
/// Reads yyyy-MM-dd, yyyyMMdd, dd.MM.yyyy, d/M/yyyy, d-M-yyyy, MMM d yyyy and d MMM yyyy (English and Danish month names). dayFirst decides 03/04/2025 when both parts are 12 or lower.
expression fnParseDate =
		(value as any, optional dayFirst as nullable logical) as nullable date =>
		let
			typed =
				if value is date then value
				else if value is datetime then DateTime.Date(value)
				else if value is datetimezone then DateTime.Date(DateTimeZone.RemoveZone(value))
				else null,
			t = if value = null or typed <> null then "" else if value is number then Text.From(Number.RoundDown(value)) else Text.Trim(Text.From(value)),
			serial = if value is number and not (value >= 19000101 and value < 21000101) then Date.From(value) else null,
			useDayFirst = if dayFirst = null then true else dayFirst,
			isNum = (x as text) as logical => x <> "" and Text.Select(x, {"0".."9"}) = x,
			months = [jan = 1, feb = 2, mar = 3, apr = 4, may = 5, maj = 5, jun = 6, jul = 7, aug = 8, sep = 9, oct = 10, okt = 10, nov = 11, dec = 12],
			monthOf = (x as text) as nullable number => Record.FieldOrDefault(months, Text.Lower(Text.Start(x, 3)), null),
			parts = List.Select(Text.SplitAny(t, "-./ ,"), each _ <> ""),
			num = (x as text) as number => Number.From(Text.Select(Text.Start(x, 2), {"0".."9"})),
			result =
				if typed <> null then typed
				else if serial <> null then serial
				else if t = "" then null
				else if isNum(t) and Text.Length(t) = 8 then #date(Number.From(Text.Start(t, 4)), Number.From(Text.Middle(t, 4, 2)), Number.From(Text.End(t, 2)))
				else if List.Count(parts) < 3 then null
				else if isNum(parts{0}) and Text.Length(parts{0}) = 4 then #date(Number.From(parts{0}), Number.From(parts{1}), num(parts{2}))
				else if not isNum(parts{0}) then #date(Number.From(parts{2}), monthOf(parts{0}), Number.From(parts{1}))
				else if not isNum(parts{1}) then #date(Number.From(parts{2}), monthOf(parts{1}), Number.From(parts{0}))
				else
					let
						a = Number.From(parts{0}), b = Number.From(parts{1}), y = Number.From(Text.Start(parts{2}, 4)),
						dayFirstHere = if a > 12 then true else if b > 12 then false else useDayFirst
					in
						if dayFirstHere then #date(y, b, a) else #date(y, a, b)
		in
			try result otherwise null
	lineageTag: 00000000-0000-0000-0000-000000000002
	queryGroup: Functions

	annotation PBI_ResultType = Function
```

### fnParseNumber (F09)
```
/// Reads 1234.50, 1,234.50, 1.234,50, 1 234,50, 12,5, (50.00), $ 12, 12 USD and 12 kr. The last separator is the decimal separator when both occur; a single comma followed by exactly 3 digits is a thousands separator.
expression fnParseNumber =
		(value as any) as nullable number =>
		let
			raw = if value = null or value is number then "" else Text.Trim(Text.From(value)),
			negativeParens = Text.StartsWith(raw, "(") and Text.EndsWith(raw, ")"),
			cleaned = Text.Select(raw, {"0".."9", "-", ".", ","}),
			lastDot = Text.PositionOf(cleaned, ".", Occurrence.Last),
			lastComma = Text.PositionOf(cleaned, ",", Occurrence.Last),
			dots = List.Count(Text.PositionOf(cleaned, ".", Occurrence.All)),
			commas = List.Count(Text.PositionOf(cleaned, ",", Occurrence.All)),
			decimalSep =
				if dots > 0 and commas > 0 then (if lastDot > lastComma then "." else ",")
				else if commas = 1 and Text.Length(cleaned) - lastComma - 1 <> 3 then ","
				else if dots = 1 then "."
				else null,
			thousandSep = if decimalSep = "." then "," else if decimalSep = "," then "." else if commas > 0 then "," else ".",
			noThousands = Text.Remove(cleaned, {thousandSep}),
			normal = if decimalSep = null then noThousands else Text.Replace(noThousands, decimalSep, "."),
			number = if normal = "" or normal = "-" then null else Number.FromText(normal, "en-US"),
			result = if value is number then value else if number = null then null else if negativeParens then -number else number
		in
			try result otherwise null
	lineageTag: 00000000-0000-0000-0000-000000000003
	queryGroup: Functions

	annotation PBI_ResultType = Function
```

### fnParseBool (F10)
```
/// true for true/yes/y/t/1/ja/j/sand/x, false for false/no/n/f/0/nej/falsk (any case); null otherwise.
expression fnParseBool =
		(value as any) as nullable logical =>
		let
			t = if value = null or value is logical then "" else Text.Lower(Text.Trim(Text.From(value)))
		in
			if value is logical then value
			else if t = "" then null
			else if List.Contains({"true", "yes", "y", "t", "1", "ja", "j", "sand", "x"}, t) then true
			else if List.Contains({"false", "no", "n", "f", "0", "nej", "falsk"}, t) then false
			else null
	lineageTag: 00000000-0000-0000-0000-000000000004
	queryGroup: Functions

	annotation PBI_ResultType = Function
```

### fnNormaliseId (F11)
```
/// Rewrites C0001, CUST0001, 0001 and CUST-0001 to one format: prefix & separator & the number padded to digits.
expression fnNormaliseId =
		(value as any, prefix as text, separator as text, digits as number) as nullable text =>
		let
			t = if value = null then "" else Text.Trim(Text.From(value)),
			num = Text.Select(t, {"0".."9"})
		in
			if t = "" then null
			else if num = "" then t
			else prefix & separator & Text.PadStart(Text.From(Number.From(num)), digits, "0")
	lineageTag: 00000000-0000-0000-0000-000000000005
	queryGroup: Functions

	annotation PBI_ResultType = Function
```

`model.tmdl` gets the query groups in this order: `Parameters` (0), `Functions` (1), `Data` (2).

## 2. Table from a CSV file

Table and column names: the readable names (F02) when chosen, otherwise the raw names. One CSV file =
one table (for Excel: one sheet or Excel table, section 2b); the table name is what the user agreed
(`Sales`, `Customer` …), the file name stays in the source.

```
/// Orders from fact_orders.csv. Cleaning steps: see the step names in Power Query (F-ids in cleaning-log.md).
table Sales
	lineageTag: 00000000-0000-0000-0000-000000000010

	column 'Order ID'
		dataType: string
		lineageTag: 00000000-0000-0000-0000-000000000011
		summarizeBy: none
		sourceColumn: Order ID

		annotation SummarizationSetBy = Automatic

	column 'Order date'
		dataType: dateTime
		formatString: yyyy-mm-dd
		lineageTag: 00000000-0000-0000-0000-000000000012
		summarizeBy: none
		sourceColumn: Order date

		annotation SummarizationSetBy = Automatic

		annotation UnderlyingDateTimeDataType = Date

	column Amount
		dataType: double
		formatString: #,0.00
		lineageTag: 00000000-0000-0000-0000-000000000013
		summarizeBy: sum
		sourceColumn: Amount

		annotation SummarizationSetBy = Automatic

	column 'Is paid'
		dataType: boolean
		formatString: """TRUE"";""TRUE"";""FALSE"""
		lineageTag: 00000000-0000-0000-0000-000000000014
		summarizeBy: none
		sourceColumn: Is paid

		annotation SummarizationSetBy = Automatic

	partition Sales = m
		mode: import
		queryGroup: Data
		source =
				let
					Source = Csv.Document(File.Contents(SourceFolder & "fact_orders.csv"), [Delimiter = ",", Columns = 10, Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
					#"F01 Promote headers" = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),
					#"F11 Normalise customer_id" = Table.TransformColumns(#"F01 Promote headers", {{"customer_id", each fnNormaliseId(_, "CUST", "-", 4), type text}}),
					#"F08 Parse order_date" = Table.TransformColumns(#"F11 Normalise customer_id", {{"order_date", each fnParseDate(_, true), type nullable date}}),
					#"F09 Parse amount" = Table.TransformColumns(#"F08 Parse order_date", {{"amount", each fnParseNumber(_), type nullable number}}),
					#"F10 Parse is_paid" = Table.TransformColumns(#"F09 Parse amount", {{"is_paid", each fnParseBool(_), type nullable logical}}),
					#"F17 Set types" = Table.TransformColumnTypes(#"F10 Parse is_paid", {{"order_id", type text}}, "en-US"),
					#"F02 Rename columns" = Table.RenameColumns(#"F17 Set types", {{"order_id", "Order ID"}, {"order_date", "Order date"}, {"amount", "Amount"}, {"is_paid", "Is paid"}})
				in
					#"F02 Rename columns"

	annotation PBI_ResultType = Table
```

- `Csv.Document` options come from the profile: `Delimiter` (`","`, `";"`, `"#(tab)"`, `"|"`), `Columns` =
  the header's field count, `Encoding` = the profile's `codePage` (65001 UTF-8, 1252 Windows-1252, 1200
  UTF-16).
- Every column the query returns must exist in TMDL and the other way round, with matching names
  (`sourceColumn` = the query's column name).
- `dataType` per final M type: `type text` → `string`, `Int64.Type` → `int64`, `type number` → `double`,
  `Currency.Type` → `decimal`, `type date` → `dateTime` + `UnderlyingDateTimeDataType = Date`,
  `type logical` → `boolean`.
- Hide key columns (`isHidden`) that only serve relationships; hide raw amount columns when a measure
  replaces them.
- Flag columns from F14/F15/F20 (`amount issue`, `… status`, `Row check`) stay visible: the user can
  filter on them.

## 2b. Table from an Excel workbook (.xlsx / .xlsm)

The profile has one entry per source: `kind` = `excel table` (a formatted Excel table – a ListObject)
or `sheet` (a sheet without one), with `file`, `sheet`, `excelTable`, `range`, `hidden`, `headerRow`
and `headerCells`. Only the first lines of the partition differ from CSV; all F-steps after the header
are the same.

**Excel table** – the headers are already in place, so there is no F01:
```
					Source = Excel.Workbook(File.Contents(SourceFolder & "salg.xlsx"), null, true),
					#"Excel table tblKunder" = Source{[Item = "tblKunder", Kind = "Table"]}[Data],
					#"F07 Unify Segment spelling" = Table.TransformColumns(#"Excel table tblKunder", ...),
```

**Sheet** – find the header row by its text, not by a line count: Power Query may or may not include
empty rows and columns before the used range, so `Table.Skip(Source, 3)` can be off by one. Then keep
only the columns the profile saw (drops empty columns left of or right of the data):
```
					Source = Excel.Workbook(File.Contents(SourceFolder & "salg.xlsx"), null, true),
					#"Sheet Salg" = Source{[Item = "Salg", Kind = "Sheet"]}[Data],
					#"F01 Skip to header row" = Table.Skip(#"Sheet Salg", each not List.Contains(Record.FieldValues(_), "Ordrenr")),
					#"F01 Promote headers" = Table.PromoteHeaders(#"F01 Skip to header row", [PromoteAllScalars = true]),
					#"F01 Keep data columns" = Table.SelectColumns(#"F01 Promote headers", {"Ordrenr", "Dato", "Kunde", "Region", "Beløb", "Betalt"}),
```
Use the first of `headerCells` in the `List.Contains` test (a text that appears only in the header
row); the column list is the profile's `columns[].name` in order. Use the `F01 Skip …` +
`F01 Keep data columns` steps for every sheet, also when the profile reports no lines above the
header – they cost nothing and protect the next export.

Notes for Excel:
- `Excel.Workbook(…, null, true)` keeps each cell's own type (date cells are dates, number cells are
  numbers, `TRUE` is a logical). Text that only looks like a date or number stays text – that is what
  F08/F09/F10 fix. The functions accept both (section 1).
- `Item` is the sheet name or the Excel table's name exactly as in the profile (case and spaces).
  Renaming a sheet in Excel breaks the query – say so in the hand-over.
- Several sources from one workbook each get their own table, each with its own `Excel.Workbook` call;
  Power Query reads the file once per refresh anyway.
- Hidden sheets and empty sheets are listed in the profile with `hidden: true` / `isEmpty: true` and are
  not built unless the user ticks them.
- `.xls` (Excel 97–2003) is not read by the profiler: ask the user to save it as `.xlsx`.
- Excel does not need to be installed for the profile or for Power BI; Power BI Desktop reads `.xlsx`
  itself.

## 2c. Staging queries and the star schema (step 4b design)

With a design from step 4b, every source becomes a **staging query** – an `expression` that is not
loaded – and only the design's dimensions and facts are tables. The rules behind each pattern are in
[modeling-guide.md](modeling-guide.md).

**Staging query** (one per source; all the source's F-steps; nothing loaded). The body is section 2/2b's
partition source:
```
expression stg_customers =
		let
			Source = Excel.Workbook(File.Contents(SourceFolder & "dataset.xlsx"), null, true),
			#"Sheet CUST_MASTER" = Source{[Item = "CUST_MASTER", Kind = "Sheet"]}[Data],
			…
			#"F27 Remove test rows" = Table.SelectRows(<prev>, each not List.Contains({9999}, [CustomerID]))
		in
			#"F27 Remove test rows"
	lineageTag: <guid>
	queryGroup: 01_Stage

	annotation PBI_ResultType = Table
```
Name staging queries `stg_<source>`. A table that refers to `stg_customers` reads it like any query.

**Flattened dimension with merged lookups and a surrogate key** (`02_Dimensions`):
```
				let
					Source = stg_customers,
					#"M10 Merge primary contact" = Table.ExpandTableColumn(Table.NestedJoin(Source, {"CustomerID"}, Table.SelectRows(stg_contacts, each [IsPrimary] = true), {"CustomerID"}, "c", JoinKind.LeftOuter), "c", {"ContactName", "Email"}),
					#"M11 Merge details" = Table.ExpandTableColumn(Table.NestedJoin(#"M10 Merge primary contact", {"CustomerID"}, stg_user_details, {"UserID"}, "d", JoinKind.LeftOuter), "d", {"CreditLimit", "Phone"}),
					#"M12 Merge address" = Table.ExpandTableColumn(Table.NestedJoin(#"M11 Merge details", {"AddressID"}, stg_address, {"AddressID"}, "a", JoinKind.LeftOuter), "a", {"Street", "CityName"}),
					#"M13 Merge region" = Table.ExpandTableColumn(Table.NestedJoin(#"M12 Merge address", {"CityName"}, stg_cities, {"CityName"}, "r", JoinKind.LeftOuter), "r", {"RegionName"}),
					#"M14 Add customer key" = Table.AddIndexColumn(Table.Sort(#"M13 Merge region", {{"CustomerID", Order.Ascending}}), "Customer key", 1, 1, Int64.Type),
					#"F02 Rename columns" = …
				in
					#"F02 Rename columns"
```
Sort before `Table.AddIndexColumn`, so the key does not change between refreshes when the source order
changes. Keep the natural key (`Customer ID`) as a visible column; hide the surrogate key.

**Junk dimension** (status, priority, channel – with code names from F28):
```
					Source = Table.Distinct(Table.SelectColumns(stg_orders, {"OrderChannel", "Status", "Priority"})),
					#"M30 Channel names" = Table.ExpandTableColumn(Table.NestedJoin(Source, {"OrderChannel"}, Table.FromRecords({[Code = 10, Channel = "Web"], [Code = 20, Channel = "Store"]}), {"Code"}, "n", JoinKind.LeftOuter), "n", {"Channel"}),
					#"M31 Add flag key" = Table.AddIndexColumn(Table.Sort(#"M30 Channel names", {{"OrderChannel", Order.Ascending}, {"Status", Order.Ascending}, {"Priority", Order.Ascending}}), "Order flag key", 1, 1, Int64.Type)
```
The fact looks the key up by all three columns.

**Line-level fact** (header attributes brought down to the lines, keys looked up, natural columns
dropped – `03_Facts`):
```
					Source = stg_order_lines,
					#"M20 Add order header" = Table.ExpandTableColumn(Table.NestedJoin(Source, {"OrderID"}, stg_orders, {"OrderID"}, "o", JoinKind.LeftOuter), "o", {"OrderDate", "CustomerName", "OrderChannel", "Status", "Priority", "ShipToCity", "BillToCity"}),
					#"M21 Customer key" = Table.ExpandTableColumn(Table.NestedJoin(#"M20 Add order header", {"CustomerName"}, dim_customer, {"Customer name"}, "k", JoinKind.LeftOuter), "k", {"Customer key"}),
					#"M22 Ship-to city key" = Table.ExpandTableColumn(Table.NestedJoin(#"M21 Customer key", {"ShipToCity"}, dim_geo, {"City"}, "s", JoinKind.LeftOuter), "s", {"Geo key"}, {"Ship-to geo key"}),
					#"M23 Bill-to city key" = Table.ExpandTableColumn(Table.NestedJoin(#"M22 Ship-to city key", {"BillToCity"}, dim_geo, {"City"}, "b", JoinKind.LeftOuter), "b", {"Geo key"}, {"Bill-to geo key"}),
					#"M24 Remove looked-up columns" = Table.RemoveColumns(#"M23 Bill-to city key", {"CustomerName", "ShipToCity", "BillToCity", "OrderChannel", "Status", "Priority"})
```
Role-playing: `Ship-to geo key` → `dim_geo` active, `Bill-to geo key` → `dim_geo` with `isActive: false`.
Check after the build: the fact's row count equals the line source's (a merge on a non-unique key
multiplies rows – the dimension key must be unique).

**Process fact (accumulating snapshot)** – one row per order with its milestones:
```
					Source = Table.SelectColumns(stg_orders, {"OrderID", "OrderDate", "CustomerName"}),
					#"M40 Ship dates" = Table.ExpandTableColumn(Table.NestedJoin(Source, {"OrderID"}, stg_shipments, {"OrderID"}, "s", JoinKind.LeftOuter), "s", {"ShipDate", "DeliveryDate"}),
					#"M41 Invoice" = Table.ExpandTableColumn(Table.NestedJoin(#"M40 Ship dates", {"OrderID"}, stg_invoices, {"OrderID"}, "i", JoinKind.LeftOuter), "i", {"InvoiceID", "InvoiceDate"}),
					#"M42 Payment" = Table.ExpandTableColumn(Table.NestedJoin(#"M41 Invoice", {"InvoiceID"}, Table.Group(stg_payments, {"InvoiceID"}, {{"PayDate", each List.Max([PayDate]), type nullable date}}), {"InvoiceID"}, "p", JoinKind.LeftOuter), "p", {"PayDate"}),
					#"M43 Days to pay" = Table.AddColumn(#"M42 Payment", "Days to pay", each if [PayDate] = null or [OrderDate] = null then null else Duration.Days([PayDate] - [OrderDate]), Int64.Type)
```
Group the "many" milestone tables to one row per key first (several payments per invoice → the last
date), or the snapshot gets more rows than orders.

**Row-level security** (`definition/roles/Regional Access.tmdl`; the mapping table stays as a hidden
table):
```
role 'Regional Access'
	modelPermission: read

	tablePermission dim_customer = [Region] = LOOKUPVALUE ( security[Region], security[User email], USERPRINCIPALNAME () )
```
Add `ref role 'Regional Access'` to `model.tmdl`. No relationship to the mapping table is needed.

## 3. Date table

Copy tmdl-templates.md section 6 and point it at the fact table's date column, e.g.
`List.Min(Sales[Order date])` / `List.Max(Sales[Order date])` in place of the gold query. With M01 =
*flag complete months*, add the *Complete-month flag* from the same section.

## 4. Quality checks without a database

There is no SQL layer, so the checks are DAX queries run in Power BI Desktop after the first refresh
(powerbi-modeling-mcp → `dax_query_operations`, needs Desktop open), or the user reads a card:

| Check | DAX | Expect |
|---|---|---|
| Rows per table | `EVALUATE ROW("rows", COUNTROWS(Sales))` | `expected-values.md` |
| Nulls after parsing | `EVALUATE ROW("bad dates", COUNTROWS(FILTER(Sales, ISBLANK(Sales[Order date]))))` | the profile's "not dates" count (0 when F15 removed them) |
| Orphan keys | `EVALUATE ROW("orphans", COUNTROWS(FILTER(Sales, ISBLANK(RELATED(Customer[Customer ID])))))` | 0 with F18 *add members* |
| Total | `EVALUATE ROW("amount", SUM(Sales[Amount]))` | expected-values.md |

`expected-values.md` is written from the profile **before** the build: rows after F03/F04/F12/F13/F15
removals, distinct keys, and — when the fixes change no amount — the sum of the amount column computed
by the profile's parsing. Mark every expected value with the fixes it assumes.
