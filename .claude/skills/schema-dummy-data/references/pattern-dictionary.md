# Pattern dictionary

How `New-DummyData.ps1` turns a schema into values. Matching works on **tokens**: a name is split
on `_`, spaces and camelCase boundaries and lowercased (`OrderDate` and `order_date` both become
`order`, `date`). Table names lose a `dim_`/`fact_`/`fct_`/`stg_`/`tbl_`/`d_`/`f_` prefix and a
plural `s`/`ies` before they are compared (`fact_orders` → `order`, `dim_categories` → `category`).

The `-PlanOnly` JSON lists every column with the kind it got (`columns[].kind`), so "why did this
column come out like that?" is answered by reading the plan.

## Order of decisions per column

1. **Key** – primary key, foreign key or self-reference (see below). Never reaches the table further down.
2. **Lookup** – a column in table A with the *same name* as a column in a table B that A has a
   foreign key to is copied from B's row (e.g. `fact_sales.unit_price` = `dim_product.unit_price`
   of the sampled product; `fact_sales.customer_name` = that customer's name).
3. **Derived** – inside one table: line total = quantity × price × (1 − discount%); cost =
   45–75 % of the total (or of the price for a `unit_cost`); profit/margin = revenue − cost.
4. **Example** from the schema's optional `example`/`eksempel` column:
   `A|B|C` (also `;` or `,`) → pick from those values · one number (`249.95`) → 50–150 % of it,
   same decimals · one date → a date · one text with digits (`SO-10023`) → same letters, new digits.
5. **Name pattern** – the table below, first match wins.
6. **Type hint** from the optional `type`/`datatype` column.
7. Placeholder – flagged in `unmatchedColumns`.

With a sheet-per-table input, **sample rows** refine the kind from steps 4–7 (see "Sample rows"
below); keys, lookups and derived numbers (steps 1–3) still win.

## Name patterns

| Tokens matched | Kind | Generates |
|---|---|---|
| `email`, `mail` | email | `<first>.<last>@example.com` – the **same person** as the row's name column |
| `phone`, `telefon`, `tlf`, `mobil`, `mobile` | phone | `20 12 34 56` (da) / `(555) xxx-xxxx` (en) |
| `url`, `link`, `website`, `hjemmeside` | url | `https://example.com/<table>/<n>` |
| ends in `_by` after a verb (`created_by`, `approved_by`, `sold_by`) | fullname | a person – not a date, not the Danish word *by* |
| `birth`, `birthdate`, `dob`, `fødselsdato` | birthdate | 1950–2004 |
| `year`/`år`, `quarter`/`kvartal`, `month`/`måned` (+`name` → month name), `week`/`uge`, `weekday`/`ugedag`, `day`/`dag` | date parts | taken from the **row's date**, so they agree with it |
| `date`, `dato`, `created`, `oprettet`, `updated`, `time`, `timestamp`, ... | date | first date column = the row's date; a later one named `ship`/`delivery`/`levering`/`due`/`forfald`/`end`/`slut`/`updated`/`paid`/`betalt`... = 0–30 days after it |
| starts `is_`/`has_`/`er_`/`har_`, or `active`/`aktiv`/`enabled`/`deleted`/`slettet`/`returned`/`cancelled` | bool | `true`/`false` – active 85 % true, deleted/returned/cancelled 8 % true, else 50 % |
| `zip`, `postal`, `postnr`, `postnummer` | postal | the row's city's postal code (da) |
| ends in `id`/`key`, or `nr` after another word (and not a key) | generic_int | 100–999 – **unmatched** |
| `rep`, `seller`/`sælger`, `manager`/`leder`, `agent`, `owner`/`ejer`, `author` | fullname | a person |
| `country`, `land` | country | the row's city's country |
| `city`, `bynavn`, `town`, or a final `by` (`kunde_by`) | city | 18 Danish / 16 international cities, big cities more often |
| `address`, `adresse`, `vej`, `street`, `gade` | address | street + house number |
| `firstname`/`fornavn`/`first_name`, `lastname`/`efternavn`/`last_name`/`surname` | first/last name | the row's person |
| `company`, `firma`, `supplier`/`leverandør`, `vendor`, `brand`, `manufacturer` | company | `<word> ApS/A/S/I/S` (da) or `Inc./Ltd./LLC` (en), distinct in a dimension |
| `currency`, `valuta` | currency | `DKK` / `USD` |
| `percent`/`procent`/`pct`/`rate`, or `discount`/`rabat` without an amount word | percent | 0–100 with 1 decimal; discount: 0/5/10/15/20/25, mostly 0 |
| `price`/`pris`, `amount`/`beløb`, `total`, `revenue`/`omsætning`, `sales`/`salg`, `sum`, `cost`/`kostpris`, `profit`/`avance`, `value`/`værdi`, `fee`, `tax`/`moms`, `freight`/`fragt`, `salary`/`løn`, `budget`, `balance`/`saldo` | amount | log-uniform 20–5000 (many small, few large), 2 decimals, `.` separator; salary 25k–75k, budget 10k–500k |
| `quantity`/`antal`, `qty`, `count`, `stk`, `units` | quantity | 1–20, mostly 1–3 |
| `status`, `state`, `tilstand` | status | weighted: Afsluttet 57 %, Aktiv 21 %, Afventer 14 %, Annulleret 7 % |
| `region`, `landsdel`, `area`, `territory` | region | the row's city's region if the table has a city/store, else the 5-region list |
| `department`/`afdeling`, `channel`/`kanal`, `segment` | closed lists | 7 departments / 4 channels / 3 segments, skewed |
| `type`, `category`/`kategori`, `class`, `level`, `group` | category | product context (`product`/`produkt`/`vare`/`item` in the column or table) → the row's product category; otherwise generic `Kategori A–D` |
| `name`/`navn`/`label` | by context | person context (`customer`/`kunde`, `employee`/`medarbejder`, `user`/`bruger`, `contact`, `member`, ...) → `<first> <last>`; product → `<product> <variant>` (`Kaffemaskine Pro`); store → `Butik <city>`; region/department/channel/segment/category → that list; company → company; otherwise `<Word> <n>` – **unmatched** |
| `code`, `kode`, `sku`, `ean` | code | `<PFX>-1000`, `<PFX>-1001`, ... |
| `description`, `beskrivelse`, `note`, `kommentar`, `comment`, `tekst` | description | short filler sentences |
| type hint `date`, `bool`, `email`, `decimal`/`float`/`money`, `int`/`number` | as hinted | |
| nothing matched | generic_text | `"<column> <row>"` – **unmatched** |

Within one row the person, city and product are chosen once, so `email` matches the name,
`country`/`region`/`postal` match the city, and `product_category` matches the product name.
In a dimension the person/product/company/city of a "store"-like table is distinct per row.

**Several city columns in a row** (`CustomerCity`, `ShipToCity`, `BillToCity`): the first is the
row's city; every other one is its own city, the same as the first 40 % of the time. A
`country`/`region`/`postal` column follows the city column with the same prefix
(`ship_country` → `ship_city`), else the row's city.

## Sample rows (sheet-per-table input)

Rows under the header row are the client's examples. They are **kept as the first rows** of
their table, exactly as written (a blank key is filled in), unless `-ExcludeSampleRows`. A date
table ignores them (it is always a calendar). Per column, first rule that hits:

| Samples look like | Kind | Generates |
|---|---|---|
| empty in every row, and ≥ 3 sample rows | blank | empty – the client leaves it empty |
| any cell holds `A\|B\|C` | sample list | those values, skewed like other closed lists; other empty sample cells are *not* an empty share |
| name kind is row-bound (email, phone, city, country, postal, address, first/last name, date parts, currency, bool; region when the table has a city) | name kind | unchanged – keeps the row consistent |
| all `yyyy-MM-dd[ HH:mm[:ss]]`, or Excel date cells | date | the period comes from them (below); with a time of day → `yyyy-MM-dd HH:mm:ss`, 08:00–18:00 |
| all numbers, ≤ 12 distinct values each seen ≥ 2 times (≥ 4 values), or a leading zero | sample list | the same codes with the same frequencies (`OrderChannel` 10/20/30/40) |
| all numbers otherwise | sample range | min..max of the samples, log-uniform if max/min > 4, the samples' decimals (≤ 4); amount/quantity/percent keep their kind (so derived totals still work) but use this range; one number → 50–150 % of it |
| text, ≤ 12 distinct values each seen ≥ 2 times | sample list | the sample values with their frequencies (`Segment`, `Status`, `AccountManager`) |
| every value has a space and at least half end in a company word (Group, Holdings, Inc., ApS, A/S, Partners, Trading, Retail, ...) | company | word bank + the samples' own suffixes, distinct in a dimension and never one of the samples' names |
| all hex, ≥ 16 chars | sample hex | random hex of the same length and case |
| all `<same prefix><digits>` (`SAP-200000`, `ORD00001`) | sample code | a dimension continues the numbering after the highest sample (`SAP-200006`); a fact gets random digits of the same width |
| name kind `fullname` | fullname | unchanged |
| average length > 25, or a description column | sample text | the sample sentences (one distinct sentence → mixed with the locale's filler sentences) |
| one distinct value, closed-list name kind (status, segment, channel, ...) | name kind | standard list kept; reported in `hints` |
| generic/entity/category/status/... | sample list | the sample values; one distinct value → every row gets it, reported in `hints` |

**Empty share**: with ≥ 3 sample rows, a column that is empty in some of them is empty in the
same share of generated rows (`OrderNotes` filled in 5 of 8 → about 38 % empty). Keys and lookups
are never blanked.

**Period**: without `-EndDate`, sample dates (fact tables first, else any table) set it – it ends
with the month of the latest sample date and starts with the month of the earliest one when they
span ≥ 60 days; otherwise two years back. `periodFrom` in the JSON says which.

**Keys**: a primary key continues the samples' format and numbering – integers (`1001` →
`1007` ...) or prefix + digits (`ORD00008` → `ORD00009`, same width). With `-ExcludeSampleRows`
it starts where the samples start. A one-value `example` on a key works the same way.

**sampleWarnings**: a sample row whose foreign key or name-link value is not in the referenced
table (an order for `Unknown Ltd` when the customer sheet has no such customer).

## Primary and foreign keys

**Primary key** of a table, first rule that hits:
1. `id`, `<base>_id`, `<base>id`, `<table>_id`, `<base>_key`, `<base>_nr` (`fact_orders` → `order_id`).
2. The first column ending in `id`/`key` (or `nr` after another word) that is **not** another
   table's key (`customer_id` in `fact_sales` is never its primary key) and not a self-reference.
3. A business key named after the table: `region_code` on `dim_region`, `product_sku` on
   `dim_product` – generated as `REG-0001`, `REG-0002`, ...

Otherwise the table has no primary key (`primaryKey: null`) but still gets an internal 1..n pool.

**Foreign key** from table A to B: the column name equals B's primary-key name, or B's natural key
name (`customer_id` → `dim_customer` even if its key is just `id`). **Self-reference**:
`manager_id`, `parent_id`, `leder_id`, `reports_to`, `parent_<base>_id` on a table with a key –
the first 3 rows are the top (empty), every later row points to one of the earlier top rows.

**Name link**: a fact with no key to a dimension, but a column with the same name as one of the
dimension's columns – a name column with ≥ 2 tokens (`CustomerName`, `kunde_navn`) or a
company/person/product/store column – gets a hidden key to that dimension. The shared column (and
any other shared column) is then a lookup through it, so every name in the fact exists in the
dimension. The hidden key is never written; the JSON shows the link as
`{ column: CustomerName, references: CUST_MASTER, via: name }`.

Foreign keys are sampled with a skew (`index = random² × n`) over a **shuffled popularity order**
that is shared by every table pointing at the same dimension – the same few customers and
products are "the big ones" everywhere, without always being id 1. A foreign key to a date table
is the row's own date (`date_key` = `order_date` as `yyyyMMdd`).

## Tables: fact, dimension, date

- **fact** if the name starts `fact_`/`fct_`/`fakt_`, or it has a date (or a date-table key)
  and an amount/quantity column or ≥ 2 foreign keys. `-RowsFact` rows (default 1000), dates
  with linear growth (the last month ≈ 2× the first).
- **date** (reported as role `date`) – a non-fact table named `date`/`dato`/`calendar`/`kalender`:
  one row per day of the period. Its key is `yyyyMMdd` if it ends in `key`/`id`, else `yyyy-MM-dd`.
- **dimension** otherwise: `-RowsDim` rows (default 30). A dimension that *is* a closed list
  (region, department, channel, segment, product category) gets at most that list's size.
- `-Rows "table=n,..."` overrides any of these.

**Period**: two full years ending on the last day of the previous month (complete months only),
or ending on `-EndDate yyyy-MM-dd`. The JSON prints `seed` and `endDate`; pass both back to
regenerate identical files.

**Determinism**: every column has its own random stream seeded from `seed + table.column`, so
adding, removing or reordering a column leaves the values of the other columns unchanged.

## Known limitations (tell the user, don't silently "fix")

- Generic `category`/`type` columns outside a product context get `Kategori A–D` – add an
  `example` (`Privat|Erhverv`) to get real labels.
- Entity names without a known context (`campaign_name`, `project_name`) get `<Word> <n>`
  and are flagged unmatched – an `example` fixes those too.
- Input shape: if the first sheet's header has `table`/`tabel` and `column`/`kolonne`, only that
  sheet is read as a long list; otherwise every sheet is a table. CSV delimiter: comma, semicolon
  or tab (whichever splits the header into most fields).
- A business key is only linked when the dimension's column is named after its table
  (`region_code` on `dim_region`); a code column with an unrelated name stays unlinked.
- Sample cities, regions and countries are not added to the word bank: city/region/country stay
  row-consistent from the locale's list, so a client's `Tokyo` does not appear in generated rows.
- The client's sample rows are copied as they are, including odd values (`TEST` as an account
  manager) – that value can then also be picked for generated rows when the column is a sample list.
- Output: XLSX with inline strings (no shared strings table); every column gets one type – all
  numbers → number cells, all `yyyy-MM-dd[ HH:mm:ss]` → date cells, anything mixed → text.
- Runtime is PowerShell 5.1: ~7 s for 1 000 fact rows with XLSX output, ~6 s with CSV only.
