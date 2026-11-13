# Fix catalog – from finding to Power Query step

Every finding in `profile.json` names a fix id. This file says what the fix does, whether it is
recommended, which variants the user can pick, and the Power Query (M) step that implements it.

Rules for every step:
- **Step names start with the fix id and say what they do**, e.g. `#"F08 Parse order_date"`. The user sees
  them in Power Query → *Applied steps* and can switch a single step off there later.
- Steps run in the order of the table below (structure first, then values, then types, then names).
- Columns are referenced by their **raw name from the file** until F02 renames them at the end.
- Text in M: `"..."`; a step name with spaces is `#"..."`; the previous step is written `<prev>` below.
- **Excel sources:** a cell can be a real date, number or true/false next to text in the same column.
  Every text step below therefore only touches text (`if _ is text then … else _`), and the parse
  functions let typed values through. F20 does not apply to Excel; F01 uses the Excel variant.
- Shared functions (`fnParseDate`, `fnParseNumber`, `fnParseBool`, `fnNormaliseId`) are in
  [source-model.md](source-model.md) → *Functions*. Add only the functions a chosen fix uses.

## Order and defaults

| Order | Fix | What | Recommended | Variants (first = default) | Changes the numbers? |
|---|---|---|---|---|---|
| 0 | F22 | A table that is an exact copy of another | yes – leave it out | leave out · keep both | **yes** – rows twice if related |
| 0 | F21 | Tables with the same layout (per year, per source) | yes – append | append · keep apart | one table instead of two |
| 1 | F01 | Skip lines above the header | yes | – | no |
| 2 | F20 | Lines with the wrong number of fields | yes (keep, flag) | flag · remove · leave | rows |
| 3 | F03 | Remove fully empty rows | yes | – | no |
| 4 | F04 | Remove total/sum rows | yes | – | **yes** – totals would be counted twice |
| 4 | F27 | Remove test, dummy and placeholder rows (`TEST ACCOUNT`, `DO NOT USE`, id 9999, `ZZZ-…`) | yes – remove | remove · flag · keep | **yes** – counts and lists |
| 9 | F28 | Code column without names (channel 10/20/30) | yes – add names | names from the user · keep codes | no (readability) |
| – | F29 | Detail table with a primary flag (contacts with `IsPrimary`) | yes – primary only when merged | primary only · all rows as own table | rows of the detail table (step 4b) |
| – | M02 | Columns repeated per key in a fact (Channel, Budget per CampaignName) | yes – new dimension | dimension · keep | **yes** – a repeated budget summed per day is wrong (step 4b) |
| 5 | F19 | Remove empty columns | yes | – | no |
| 5 | F25 | Remove technical columns (hash, load stamp, source id) | yes | remove · keep | no |
| 5 | F26 | Personal data (e-mail, phone, contact name, street) | yes – hide | hide · remove · keep visible | no |
| 5 | F23 | Two values in one column (`electronics\|phones`) | yes – split | split · keep | groupings |
| 5 | F24 | A list in one cell (`HOM-044, BEA-012, …`) | yes – one row per item | rows · keep | **yes** – row count |
| 6 | F05 | Trim spaces and invisible characters | yes | – | no (fixes joins and groupings) |
| 7 | F06 | "No value" text → empty (null) | yes | – | counts of non-blank values |
| 8 | F07 | One spelling per category (case) | yes | most common form · Proper · UPPER | groupings |
| 9 | F11 | One id format | yes | target format from the profile | joins (orphans disappear) |
| 10 | F08 | Parse mixed date formats | yes | day-first · month-first | dates |
| 11 | F09 | Parse mixed number formats | yes | – | **yes** – wrong separators give ×100 / ×1000 errors |
| 12 | F10 | Parse true/false spellings | yes | – | flags |
| 13 | F12 | Remove exact duplicate rows | yes | remove · keep | **yes** |
| 14 | F13 | Rows that repeat a key with other values | yes | keep first · keep all | **yes** |
| 15 | F15 | Flag invalid, future or very old dates | yes | flag · remove rows · leave | only with *remove* |
| 16 | F14 | Flag amount anomalies (negative, spike, zero) | negative + spike yes, zero no | flag · remove rows · leave | measures use the flag |
| 17 | F16 | Unpivot period columns (wide → long) | yes | – | shape |
| 18 | F18 | Keys missing in the dimension | yes | add members · one "Unknown" row · leave | distinct counts, blanks in visuals |
| 19 | F17 | Data types on every column | yes (always offered) | – | required for sums and dates |
| 20 | F02 | Clean column names (snake_case) | yes | clean · keep raw | no |
| – | M01 | Incomplete last month | yes | flag complete months · show all · drop the partial month | month-over-month cards |

F17 also turns empty text (`""`) into `null` first – `Csv.Document` returns `""` for empty fields, and
`""` breaks typing and unpivot. (Excel gives `null` for empty cells, but a cell with only spaces is still
`""` after F05, so keep the step for Excel too.)

---

## F01 Skip lines above the header
```m
#"F01 Skip 2 title lines" = Table.Skip(Source, 2),
#"F01 Promote headers" = Table.PromoteHeaders(#"F01 Skip 2 title lines", [PromoteAllScalars = true]),
```
Without F01 the query still needs `Table.PromoteHeaders(Source, [PromoteAllScalars = true])`.

*Excel sheet:* skip to the row that holds the first header text, then keep only the profiled columns
(source-model.md section 2b) – always, also with no lines above the header. *Excel table:* no F01.

## F20 Lines with the wrong number of fields
CSV only (an Excel sheet has no field count). `Csv.Document` is called with `Columns = <n>`: extra fields are cut off, missing fields become null. The
profile lists the line numbers.
- *flag* (default): `Table.AddColumn(<prev>, "Row check", each if [<last column>] = null or [<last column>] = "" then "short line" else "ok", type text)` – only when the last column is never empty in good rows.
- *remove*: `Table.SelectRows(<prev>, each [<last column>] <> null and [<last column>] <> "")` (same condition).
- *leave*: no step. Tell the user that fixing the source file is the real fix.

## F03 Remove fully empty rows
```m
#"F03 Remove empty rows" = Table.SelectRows(<prev>, each List.NonNullCount(List.ReplaceValue(Record.FieldValues(_), "", null, Replacer.ReplaceValue)) > 0),
```

## F04 Remove total/sum rows
```m
#"F04 Remove total rows" = Table.SelectRows(<prev>, each
    let first = Text.Lower(Text.Trim(Text.From(List.First(List.Select(Record.FieldValues(_), each _ <> null and _ <> ""), ""))))
    in not List.AnyTrue(List.Transform({"total", "grand total", "subtotal", "sum", "i alt", "samlet", "totalt"}, each Text.StartsWith(first, _)))),
```
Show the user the example rows from the profile before they choose – a product called "Total care" would
also match; then narrow the list.

## F19 Remove empty columns
```m
#"F19 Remove empty columns" = Table.RemoveColumns(<prev>, {"Note"}),
```

## F05 Trim spaces and invisible characters
```m
#"F05 Trim text" = Table.TransformColumns(<prev>, {{"Kunde", each if _ is text then Text.Trim(Text.Clean(_)) else _}}),
```
One pair per affected column.

## F06 "No value" text → null
The profile lists the tokens per column (`N/A`, `-`, `null`, `ukendt` …).
```m
#"F06 No-value text to null" = Table.TransformColumns(<prev>, {{"Note", each if _ is text and List.Contains({"N/A", "-"}, Text.Trim(_)) then null else _}}),
```

## F07 One spelling per category
*most common form* (default) – map every variant to the spelling used most often in the profile:
```m
#"F07 Unify Region spelling" = Table.TransformColumns(<prev>, {{"Region", each if _ is text then Record.FieldOrDefault([nord = "Nord", syd = "Syd"], Text.Lower(Text.Trim(_)), _) else _}}),
```
*Proper*: `Text.Proper`; *UPPER*: `Text.Upper` in place of the record lookup. Record field names with
spaces or special characters are written `#"north east" = "North East"`.

## F11 One id format
Target format = `variant` in the finding (the shape of the key in its home table, e.g. `CUST-9999`):
prefix = the letters, separator = the character between letters and digits (`-`, `_`, space or none),
digits = the number of `9`s. Shape `9999` = no prefix.
```m
#"F11 Normalise customer_id" = Table.TransformColumns(<prev>, {{"customer_id", each fnNormaliseId(_, "CUST", "-", 4), type text}}),
```
Apply the same target to the key in **every** table that holds it (fact, dimension, bridge, second
source) – otherwise the relationship matches only part of the rows.

## F08 Parse mixed date formats
```m
#"F08 Parse order_date" = Table.TransformColumns(<prev>, {{"order_date", each fnParseDate(_, true), type nullable date}}),
```
Second argument: `true` = day-first (`03/04/2025` = 3 April), `false` = month-first. Use the variant from
the profile (day-first and month-first evidence = values where one part is above 12). With no evidence
at all (every slash date has both parts ≤ 12), **ask** – it is the user's knowledge of the source.
A column with a single ISO format (`yyyy-MM-dd`) needs no F08; F17 types it.

## F09 Parse mixed number formats
```m
#"F09 Parse amount" = Table.TransformColumns(<prev>, {{"amount", each fnParseNumber(_), type nullable number}}),
```
`fnParseNumber` strips currency text and spaces, reads `(50.00)` as negative, and takes the **last**
separator as the decimal separator when both `.` and `,` occur. With only one kind: one `,` followed by
exactly 3 digits is a thousands separator (`1,234` = 1234); several of the same kind are thousands
separators. Values it cannot read become null – the profile's "not numbers" count says how many.

## F10 Parse true/false spellings
```m
#"F10 Parse is_paid" = Table.TransformColumns(<prev>, {{"is_paid", each fnParseBool(_), type nullable logical}}),
```

## F12 Remove exact duplicate rows
```m
#"F12 Remove exact duplicates" = Table.Distinct(<prev>),
```

## F13 Rows that repeat a key with other values
Also raised on a lookup table whose **name** column other tables use as a key (`products[ProductName]`
appears twice for 2 names) – the relationship needs one row per value. Same step on that column; tell
the user which rows are dropped and that making the names unique in the source is the better fix.
*keep first* (default) – the first line in the file wins:
```m
#"F13 Keep first row per order_id" = Table.Distinct(Table.Buffer(<prev>), {"order_id"}),
```
*keep all*: no step; tell the user that the key cannot be used for a one-to-many relationship then.
Run F13 **after** F11 (so `C0001` and `CUST-0001` count as the same key).

## F15 Flag invalid, future or very old dates
*flag* (default) – keep the rows, add a status the measures and visuals can filter on:
```m
#"F15 Date status order_date" = Table.AddColumn(<prev>, "order_date status", each
    if [order_date] = null then "missing or invalid"
    else if [order_date] > #date(2026, 11, 6) then "future"
    else if Date.Year([order_date]) < 1900 then "too old"
    else "ok", type text),
```
Use the profile's `today` as the cut-off date (a literal, so a refresh does not move it silently).
*remove rows*: `Table.SelectRows(<prev>, each [order_date] <> null and [order_date] <= #date(...) and Date.Year([order_date]) >= 1900)`.

## F14 Flag amount anomalies
Pick the checks the user wants (negative, spike, zero) – each is its own option.
*flag* (default):
```m
#"F14 Amount issue" = Table.AddColumn(<prev>, "amount issue", each
    if [amount] = null then "missing"
    else if [amount] < 0 then "negative"
    else if [amount] > 7177.6 then "spike"
    else "ok", type text),
```
The spike limit is 10 × the median from the profile; write it as a literal with a comment and tell the
user. Measures on the amount then use `CALCULATE(SUM(...), 'Table'[amount issue] = "ok")` – say so when
the measures are proposed.
*remove rows*: `Table.SelectRows(<prev>, each [amount] <> null and [amount] >= 0 and [amount] <= 7177.6)`.

## F16 Unpivot period columns
```m
#"F16 Unpivot months" = Table.UnpivotOtherColumns(<prev>, {"location_id", "year"}, "Month", "Value"),
#"F16 Month start" = Table.AddColumn(#"F16 Unpivot months", "Month start", each
    #date(Number.From([year]), List.PositionOf({"jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"}, Text.Lower(Text.Start(Text.Replace([Month], "maj", "may"), 3))) + 1, 1), type date),
```
Empty cells must be `null` before this step (F17's first sub-step, moved up when F16 is chosen), so
they are dropped instead of becoming rows with an empty value. For `2025-01` style headers:
`#date(Number.From(Text.Start([Month], 4)), Number.From(Text.End([Month], 2)), 1)`. For `Q1`–`Q4`: the
quarter's first month.

## F18 Keys missing in the dimension
In the **dimension's** query, after its own steps (the fact query must not reference the dimension, or
the queries become circular):
*add members* (default) – one row per missing id, marked as inferred:
```m
#"F18 Missing ids" = List.Difference(List.Distinct(Table.Column(Sales, "Customer ID")), Table.Column(<prev>, "Customer ID")),
#"F18 Add missing customers" = Table.Combine({
    Table.AddColumn(<prev>, "Is inferred", each false, type logical),
    Table.AddColumn(Table.FromColumns({#"F18 Missing ids"}, {"Customer ID"}), "Is inferred", each true, type logical)}),
#"F18 Name missing customers" = Table.ReplaceValue(#"F18 Add missing customers", null, "Unknown", Replacer.ReplaceValue, {"Customer name"}),
```
`Sales` is the fact table's name in the model and `"Customer ID"` its column after F02. Distinct customer
counts stay right.
*one "Unknown" row*: append one row with id `"?"` and map the fact's missing ids to `"?"` in the fact
query instead – distinct counts then drop by (missing ids − 1); say so.
*leave*: visuals show a blank member for those rows.

## F17 Data types
```m
#"F17 Empty text to null" = Table.TransformColumns(<prev>, List.Transform(<text columns>, each {_, each if _ = "" then null else _})),
#"F17 Set types" = Table.TransformColumnTypes(#"F17 Empty text to null", {{"quantity", Int64.Type}, {"unit_price", type number}, {"status", type text}}, "en-US"),
```
Only columns that no earlier step already typed. Kinds from the profile: `integer` → `Int64.Type`,
`decimal` → `type number` (or `Currency.Type` for amounts, if the user wants fixed 4 decimals), `date` →
`type date`, `bool` → `type logical`, everything else → `type text`. The culture argument is the
**source** culture (how the file writes numbers), not the report culture.

## F02 Clean column names (snake_case)
```m
#"F02 Rename columns" = Table.RenameColumns(<prev>, {{"order_id", "Order ID"}, {"order_date", "Order date"}}),
```
Names from the profile's `readable`. Last step, so all earlier steps use the raw names. The TMDL
`sourceColumn` and column name are the new names. With `build.naming = "snake_case"` (new runs) the
model columns are renamed once more to snake_case (`Order ID` → `order_id`) in the table's final
*Select and name columns* step.

## F27 Remove test, dummy and placeholder rows
The profile matches a whole field that says test/dummy/placeholder/do not use, a name such as
`TEST ACCOUNT`, or a placeholder id in an id column (`9999`, `0`, `-1`, `ZZZ-…`, `XXX…`). Show the
examples and remove **exactly those rows** by their key – a list is easier to read and review than a
pattern:
```m
#"F27 Remove test rows" = Table.SelectRows(<prev>, each not List.Contains({"ZZZ-000"}, [ProductCode])),
```
*flag*: `Table.AddColumn(<prev>, "Is test row", each List.Contains({…}, [ProductCode]), type logical)`
and filter it in the measures. Remove test rows in the **staging** query, so no merge or lookup ever
sees them (a test customer must not become the match for an order). Also check the other tables for
rows that point at a removed key and say how many (usually 0).

## F28 Code column without names
`10, 20, 30, 40` in `OrderChannel` mean something only to the source system. Ask the user for the
names; build them as a small table in the junk dimension (source-model.md section 2c) or, for a single
column:
```m
#"F28 Channel names" = Table.AddColumn(<prev>, "Channel", each Record.FieldOrDefault([#"10" = "Web", #"20" = "Store", #"30" = "Phone", #"40" = "Partner"], Text.From([OrderChannel]), "Unknown " & Text.From([OrderChannel])), type text),
```
Keep the code column (hidden) for reconciliation. With no names from the user: keep the code and say so.

## F29 Detail table with a primary flag
Several rows per key (contacts per customer), one marked primary. In step 4b this detail is merged into
the dimension with only the primary row (`Table.SelectRows(stg_contacts, each [IsPrimary] = true)`
before the merge – source-model.md section 2c). If the user needs all rows, keep the table as its own
dimension-detail table related to the dimension, and say that it filters the dimension, not the fact.

## M02 Columns repeated per key
`Channel`, `StartDate`, `EndDate`, `Budget` have one value per `CampaignName` but sit on every daily
row. In step 4b: a dimension from `Table.Distinct` of the key + those columns (with a surrogate key), and
the fact keeps the key + the daily measures. Measures that use such a column (budget) take it from the
dimension, never a sum over the fact.

## F22 A table that is an exact copy of another
`variant` = the original. No step: the copy is not built (`include: false`). Ask on the copy, with the
original's name in the question. *keep both*: build both, but relate only the original.

## F21 Tables with the same layout
`variant` = the other table. One model table from both: ask once, on the first, for a name (proposal:
the shared part, `ORDERS_2025` + `ORDERS_2026` → `Orders`) and then do the cleaning **once** for the
combined table, with the findings of both. The second source gets `include: false`, `appended_to: <name>`.
Each source keeps its own F01 steps; a `Source sheet` column says where each row came from. Columns
that exist in only one source are null in the other's rows – the profile names them.
```m
#"Sheet ORDERS_2025" = Source{[Item = "ORDERS_2025", Kind = "Sheet"]}[Data],
#"F01 Headers ORDERS_2025" = Table.PromoteHeaders(Table.Skip(#"Sheet ORDERS_2025", each not List.Contains(Record.FieldValues(_), "OrderID")), [PromoteAllScalars = true]),
#"Sheet ORDERS_2026" = Source{[Item = "ORDERS_2026", Kind = "Sheet"]}[Data],
#"F01 Headers ORDERS_2026" = Table.PromoteHeaders(Table.Skip(#"Sheet ORDERS_2026", each not List.Contains(Record.FieldValues(_), "OrderID")), [PromoteAllScalars = true]),
#"F21 Append ORDERS_2025 and ORDERS_2026" = Table.Combine({
    Table.AddColumn(#"F01 Headers ORDERS_2025", "Source sheet", each "ORDERS_2025", type text),
    Table.AddColumn(#"F01 Headers ORDERS_2026", "Source sheet", each "ORDERS_2026", type text)}),
```
For CSV files: two `Csv.Document` sources in the same way. Keep F13 (one row per key) after the
append when the profile shows the same key in both sources. A relationship found for each source
(`ORDERS_2025[OrderID] -> …`) becomes one relationship from the combined table.

## F25 Remove technical columns
```m
#"F25 Remove technical columns" = Table.RemoveColumns(<prev>, {"hash_key", "source_id"}),
```

## F26 Personal data
- *hide* (default): no M step; the TMDL column gets `isHidden` – it stays in the model for filters and
  row-level security (e.g. `security[UserEmail]`), but report users do not see it in the field list.
- *remove*: `Table.RemoveColumns(<prev>, {"Email", "Phone"})` – it never enters the model.
- *keep visible*: nothing. Mention that the report then shows personal data to everyone who opens it.
A column the user wants for row-level security (an e-mail matched to `USERPRINCIPALNAME()`) must not
be removed – ask when the table looks like a security mapping (an e-mail column next to a region or
department column).

## F23 Two values in one column
`variant.separator` and `variant.names` come from the profile.
```m
#"F23 Split CategorySubcategory" = Table.SplitColumn(<prev>, "CategorySubcategory", Splitter.SplitTextByDelimiter("|", QuoteStyle.None), {"Category", "Subcategory"}),
```
Ask for other names when the proposal is `<column> 1` / `<column> 2`. With F05 kept, trim the new
columns too.

## F24 A list in one cell
```m
#"F24 Split PromotedSKUs into rows" = Table.ExpandListColumn(
    Table.TransformColumns(<prev>, {{"PromotedSKUs", each if _ is text then List.Select(List.Transform(Text.SplitAny(_, ",;"), Text.Trim), each _ <> "") else {_}}}),
    "PromotedSKUs"),
```
The table gets one row per item (the profile gives the item count), so the item column can be related
to its own table (`PromotedSKUs` → products[ProductCode]). Say that the row count changes.

## M01 Incomplete last month
Model choice, not a Power Query step on the table:
- *flag complete months* (default): the date table gets `Is complete month` (tmdl-templates.md →
  *Complete-month flag*); trend visuals and month-over-month measures use complete months only.
- *show all*: nothing; tell the user the last month will look like a drop.
- *drop the partial month*: `Table.SelectRows(<prev>, each [order_date] < #date(<year>, <month>, 1))` in
  the fact query – totals then exclude those rows; say how many.
