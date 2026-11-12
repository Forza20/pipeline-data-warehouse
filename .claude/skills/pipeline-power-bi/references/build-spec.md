# Build spec – `choices.json` → `build`

`scripts/build-model.js runs/<run-id>` turns this spec into the semantic model (TMDL). Write the spec in
step 8 from the user's choices (steps 3–5) and the design (step 4b); never hand-write TMDL for tables,
relationships, measures or roles. A complete, working example (CSV and Excel sources, every op kind,
date table, measures, a role) is the `spec` object in [../tests/run-tests.js](../tests/run-tests.js).

```
node .claude\skills\pipeline-power-bi\scripts\build-model.js runs\<run-id> [--out <folder>] [--name <Name>]
```
It checks the spec first (unknown steps, relationship columns that no table has, duplicate columns) and
writes nothing on an error. It writes to `definition.new` and swaps it in at the end, so a failed write
(full disk) leaves the previous model untouched. Exit code 2 = errors in the spec; exit code 3 = the model
folder is locked (Power BI Desktop, an open `powerbi-modeling-mcp` connection, or a shell whose working
directory is inside it) – the previous model is kept, close what holds it and run again. Output: `<out>/<Name>.SemanticModel` (default
`runs/<run-id>/pbip`) and a JSON summary.

## Top level

| Key | Meaning |
|---|---|
| `name` | model and file name (`Dataset` → `Dataset.SemanticModel`) |
| `culture` / `sourceCulture` | report culture; culture used to read text in F17 (`en-US`) |
| `cutoffDate` | `yyyy-MM-dd` for F15 "future" (the profile's `today`) |
| `sourceFolder` | absolute folder with the source files, ending with `\` (becomes the `SourceFolder` parameter) |
| `staging[]`, `tables[]`, `date`, `relationships[]`, `measures[]`, `roles[]` | below |

## `staging[]` – one per source, query group 01_Stage, not loaded

```json
{ "name": "stg_orders", "file": "dataset.xlsx", "kind": "sheet", "item": "ORDERS_2025", "header": "OrderID",
  "columns": ["OrderID", "OrderDate", "…"],
  "append": [{ "item": "ORDERS_2026", "columns": ["…"] }], "sourceColumn": "SourceSheet",
  "steps": [ { "fix": "F19", "columns": ["GiftMessage"] }, { "fix": "F17", "types": { "OrderID": "text", "OrderDate": "date" } } ] }
```
- `kind`: `sheet` (needs `header` = first header text), `excel table` (`item` = table name), `csv` (needs
  `delimiter` `,` `;` `tab` `|`, `codePage`, `headerRow` from the profile).
- `columns`: the profile's column names in order (F01 keeps exactly these).
- `append` (F21): more sheets/tables with the same layout; a `sourceColumn` says where each row came from.
- `steps`: in fix-catalog order. Each step is `{ "fix": "Fxx", … }`:

| Fix | Keys |
|---|---|
| F03, F12 | – |
| F04 | `words` (optional) |
| F05 | `columns` |
| F06 | `columns`, `tokens` |
| F07 | `column`, `map` {lower → spelling} or `case` `proper`/`upper` |
| F08 | `column`, `dayFirst` (true/false) – adds `fnParseDate` |
| F09 / F10 | `column` – adds `fnParseNumber` / `fnParseBool` |
| F11 | `column`, `prefix`, `separator`, `digits` – adds `fnNormaliseId` |
| F13 | `column` (keep first per value, `ignoreCase`) or `column` + `remove` [values] + `label` |
| F14 | `column`, `checks` [`negative`,`spike`,`zero`], `spike` (limit), `mode` `flag`/`remove`, `flagColumn` |
| F15 | `column`, `mode` `flag`/`remove`, `cutoff`, `flagColumn` (default `<column> status`) |
| F16 | `keep` [id columns], `attribute`, `value`, `period` `yyyy-MM` or `monthName` (+ `year` column → `<attribute> start`) |
| F17 | `types` {column: type}, `periodColumns` [`2025-02` text → month date] |
| F19, F25 | `columns` |
| F23 | `column`, `separator`, `names` |
| F24 | `column`, `separators` (default `,;`) |
| F27 | `column`, `values` [keys], `mode` `remove`/`flag` |
| F28 | `column`, `names` {code: name}, `as` (new column) |
| M | `label`, `expr` (any M, `<prev>` = previous step) – only when no fix fits |

F01 is built from `kind`/`header`/`columns`; F02, F26 come from the table columns; F18 is `inferMembers`.

## `tables[]` – loaded model tables

```json
{ "name": "Customer", "kind": "dimension", "from": "stg_customers", "description": "…",
  "ops": [ { "op": "merge", "with": "stg_address", "on": ["AddressID"], "columns": ["Street", "CityName"] } ],
  "columns": [ { "name": "Customer ID", "from": "CustomerID", "type": "key", "description": "…" },
               { "name": "Street", "type": "text", "hidden": true } ] }
```
- `kind`: `dimension` (02_Dimensions), `fact` (03_Facts), `support` (04_Support); `hidden: true` hides the table.
- `from`: a staging query or a loaded table name.
- `ops` (each gets a step `M<nn> <label>`):

| op | Keys |
|---|---|
| `merge` | `with` (query name, `{from, filter}` or `{group:{from, by, aggs:[{name, fn: min/max/sum/count/maxIfAll, column, type}]}}`), `on`, `withOn`, `columns`, `as`, `ignoreCase` (joins on lower-case helper columns `__key1…`, removed after the expand – Desktop refuses join comparers) |
| `select` | `columns` |
| `distinct` | `columns` (optional) |
| `filter` | `expr` (M condition on `[Column]`) |
| `addKey` | `name`, `sortBy` (sort first so keys stay stable) |
| `addColumn` | `name`, `expr` (M, rows as `[Column]`), `type`, `label` |
| `transform` | `column`, `expr` (M on `_`), `type` |
| `inferMembers` (F18) | `key`, `fromColumns` [`query[column]`], `defaults` {column: M expression on `_`}, `flag` |
| `m` | `label`, `expr` with `<prev>` |
- `columns`: the final columns in order – `name` (in the report), `from` (column in the query, default
  `name`), `type` (`text`, `int`, `key`, `number`, `currency`, `percent`, `date`, `datetime`, `bool`),
  optional `format`, `hidden`, `summarize`, `description`. The table ends with select + rename + types.

## `date`, `relationships[]`, `measures[]`, `roles[]`

```json
"date": { "name": "Date", "columns": ["Sales[Order date]", "Inventory[Month]"], "completeMonth": "Sales[Order date]" },
"relationships": [ { "from": "Sales[Customer ID]", "to": "Customer[Customer ID]" }, { "from": "Sales[Bill-to geo key]", "to": "Geo[Geo key]", "active": false } ],
"measures": [ { "name": "Total sales", "expr": "SUM ( Sales[Line total] )", "format": "\\$#,0.00", "folder": "Sales", "description": "…", "term": "Revenue" } ],
"roles": [ { "name": "Regional Access", "table": "Customer", "filter": "[Region] = LOOKUPVALUE ( security[Region], security[User email], USERPRINCIPALNAME () )" } ]
```
The date table is marked (`dataCategory: Time`), spans whole years of the listed columns, and with
`completeMonth` gets `Is complete month`. Multi-line DAX: use `\n` in `expr`. `term` names the
glossary term (`choices.json` → `glossary[]`) and is written as `annotation Term` on the measure. Relationships are
many-to-one, single direction.

## After a change

Change the spec, run the script again, validate (`ConnectFolder`, `powerbi-report-author validate`).
The report (`<Name>.Report`) is not touched; if a column or measure the dashboard uses was renamed, run
pbip-layout again.
