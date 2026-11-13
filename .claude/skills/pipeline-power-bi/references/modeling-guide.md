# Modelling guide – from cleaned tables to a star schema

Cleaning (fix-catalog.md) makes each table correct. Modelling decides **which tables the report should
have at all**. A file with 20 sheets rarely means a model with 20 tables: most sheets are pieces of a few
business processes and their descriptions. Read this before step 4b. Every rule below is a *proposal* to
the user – nothing is merged, dropped or reshaped without their choice.

## 0. The questions to answer first

1. **Which business processes are in the data?** Selling (orders, order lines), invoicing and paying,
   shipping, marketing (campaigns), stock, targets. Each process with its own measurements becomes a
   **fact table**.
2. **What is one row (the grain) of each fact?** One order line, one day per campaign, one product per
   month. Choose the lowest grain the data has.
3. **What do people filter and group by?** Customer, product, region, date, channel. Each becomes a
   **dimension**: one row per member, all its descriptive attributes as columns.
4. **What does not belong in the report?** Test rows, technical columns, copies, staging lists, security
   mappings (section 7).

Write the answers as the proposed design (step 4b) before building anything.

## 1. Facts: one grain per table

- **Header + lines → one line-level fact.** When one table holds order headers (date, customer, channel,
  status) and another the lines (product, quantity, amount), bring the header's attributes down to the
  lines (merge on the order id) and build **one** fact at line level. Two related facts at different
  levels force helper measures (orders per category cannot be counted on the header table) and invite
  double counting. Header amounts (`OrderTotal`) are not copied to the lines – sum the line amounts; keep
  the header total only to reconcile (it must equal the sum of the lines).
  *Detect:* a relationship `lines[OrderID] -> header[OrderID]` where both tables have amounts or dates.
- **Milestones of one entity → a process fact (accumulating snapshot).** When several tables each add a
  date to the same key (order → shipped → invoiced → paid), build one row per key with every milestone
  date and the durations (`days to ship`, `days to pay`). It answers "how long does it take" without
  joining four tables in DAX.
  *Detect:* three or more tables relate to the same key and each has a date column.
- **Repeated attributes → a dimension + a lean fact.** When a fact repeats the same values for every row
  of a key (`CampaignName` → Channel, StartDate, EndDate, Budget on every daily row – profile finding
  **M02**), move those columns to a dimension (one row per key) and keep only the key and the daily
  measurements in the fact. A budget repeated per day must never be summed.
- **Wide → long** (F16) before modelling; one row per period.
- **Semi-additive facts** (stock, balances): a measure that takes the last period, never a plain sum.

## 2. Dimensions: flat, one row per member

- **Flatten lookup chains (snowflakes).** `customer → address → city → region` and
  `product → subcategory → category` become one `dim_customer` (with street, city, region) and one
  `dim_product` (with subcategory, category). Fewer relationships, simpler filters, no ambiguous paths.
  Keep a separate table only when another fact uses it at its own level (e.g. targets per region → then
  a `dim_region` shared by both).
  *Detect:* a many-to-one chain A → B → C where B and C are small lookup tables.
- **Merge one-to-one detail tables** (`user_details` with credit limit and phone per customer) into the
  dimension.
- **Detail tables with a primary flag** (contacts with `IsPrimary`, profile finding **F29**): merge only the
  primary row into the dimension. All contacts stay available only if the user needs them as a list.
- **Junk dimension for small flags.** Low-cardinality attributes of the fact that are not entities
  (status, priority, channel) go into one `dim_<process>_flags` table: the distinct combinations, a
  surrogate key, and readable names. Code columns (**F28**: channel 10/20/30) get their names here – ask
  the user for the code list, or keep the code if nobody knows.
- **Role-playing dimensions.** The same dimension used twice by a fact (ship-to city and bill-to city;
  order date and ship date) is one table with one **active** relationship and the others **inactive**,
  used in measures with `USERELATIONSHIP`. Do not copy the dimension.
- **Surrogate keys.** When the natural key is a name, a code with mixed formats, or a combination of
  columns, give the dimension an integer key (`Table.AddIndexColumn`) and look it up in the fact. Joining
  on names works but breaks when a name changes or has two spellings. Keep the natural key as a column.
- **Unknown member.** Facts whose key is missing in the dimension (F18) get an inferred row, so totals
  stay complete.

## 3. Relationships

- Many-to-one from fact to dimension, **single direction**. No bidirectional filters unless a specific
  measure needs it; then prefer `CROSSFILTER` inside that measure.
- No one-to-one relationships between a fact and the date table (a monthly target table has unique
  dates – still model it as many-to-one to `Date`).
- One path between any two tables. A second path (region via customer *and* via the order) means one of
  them must go or be inactive.
- Many-to-many (campaign ↔ product): a bridge/factless fact with one row per pair (F24 output), related
  to both dimensions.

## 4. Date

- One date table, generated in Power Query from the facts' dates (whole years), **marked as date table**
  (`dataCategory: Time`, `isKey` on Date), with Year, Quarter, Month, Month start, month sort column.
- **Auto date/time off** (`__PBI_TimeIntelligenceEnabled = 0`): otherwise Desktop adds a hidden
  `LocalDateTable` for every date column.
- Every fact date that people filter by relates to it; extra dates of the same fact are inactive.

## 5. Measures

- Explicit measures for every number shown; hide the fact columns they are built from.
- Name them for the business (`Total sales`, not `Sum of LineTotal`), give a format with the currency,
  a display folder and a one-line description.
- Ratios with `DIVIDE`; semi-additive with `LASTDATE`/`MAX` of the period; period comparisons on the
  latest **complete** month.
- Never `TODAY()`/`NOW()` in a measure: the number would move with the calendar, not the data. Anchor on the
  latest date in the data.
- Reuse measures (`[Total sales]`) instead of repeating their formula; helpers are `VAR`s in the measure.

### Template: the latest N complete months vs the N before

For "revenue for the last 3 complete months versus the 3 before, and growth" in any model. Replace
`<Fact>[<date>]`, `<Date>`, `[<Base>]` and `N`. The last month counts only when the data reaches its last
day; the windows ignore calendar and fact-date filters but follow every other dimension.

```dax
-- <Base> last N months
VAR LastDate  = CALCULATE ( MAX ( <Fact>[<date>] ), REMOVEFILTERS () )          -- the whole dataset
VAR LastMonth = IF ( LastDate = EOMONTH ( LastDate, 0 ), EOMONTH ( LastDate, 0 ), EOMONTH ( LastDate, -1 ) )
VAR FirstDay  = EOMONTH ( LastMonth, -N ) + 1
RETURN
    CALCULATE ( [<Base>], REMOVEFILTERS ( <Date> ), REMOVEFILTERS ( <Fact>[<date>] ),
        DATESBETWEEN ( <Date>[Date], FirstDay, LastMonth ) )

-- <Base> previous N months: the same, with
VAR PrevLast  = EOMONTH ( LastMonth, -N )
VAR PrevFirst = EOMONTH ( LastMonth, -2 * N ) + 1          -- DATESBETWEEN ( <Date>[Date], PrevFirst, PrevLast )

-- <Base> growth % (format 0.0 %)
DIVIDE ( [<Base> last N months] - [<Base> previous N months], [<Base> previous N months] )
```
- With the date table's `Is complete month` flag (fix M01 *flag complete months*), `LastMonth` may instead
  be `CALCULATE ( MAX ( <Date>[Date] ), REMOVEFILTERS (), <Date>[Is complete month] = TRUE () )`.
- `REMOVEFILTERS ()` in `LastDate` makes the windows the same for every product or region; anchor inside
  the filter context instead only when the user asks for "each one's own latest month".
- Filter contract (build-spec.md): `ignore` a calendar column and `<Fact>[<date>]`, `keep` the dimensions;
  `additive: true` for the two windows, not for the growth %. `DIVIDE` returns blank when the previous
  window is 0 or blank.
- Show the window dates: `measure-test.js … --show-vars` lists `LastDate`, `LastMonth` and `FirstDay`, so
  the user sees which months were used.

## 6. Power Query structure

- **Staging queries are not loaded.** Each sheet/file is read once in a staging query (`expression` in
  TMDL, query group `01_Stage`); dimensions (`02_Dimensions`) and facts (`03_Facts`) are built from the
  staging queries and are the only loaded tables. Lookup tables that were merged into a dimension stay
  staging only.
- The source path is a parameter (`SourceFolder`), never a hard-coded path.
- Step names say what they do (`F27 Remove test rows`), not `Merged Queries3`.
- Merges for surrogate keys: `Table.NestedJoin` + `Table.ExpandTableColumn` of the key only, then remove
  the natural columns the fact no longer needs.

## 7. What to leave out

| What | Why | How it is found |
|---|---|---|
| Test, dummy and placeholder rows (`TEST ACCOUNT`, `DO NOT USE`, id 9999, `ZZZ-000`) | they distort counts, totals and lists | F27 |
| Copies of rows from a migration (same entity, other id, often an odd `source_id` range) | double counting | F13 / F12 – show both rows to the user |
| Technical columns (hash, load stamps, source ids) | noise | F25 |
| Free-text notes, legacy references, empty columns | rarely analysed; keep only on request | F19, user |
| Copied sheets, staging lists (a list of all order ids) | duplicate tables | F22, relations to a table that already has every id |
| Security mapping (user e-mail → region) | not a report table | §8 |
| Personal data not needed for analysis | privacy | F26 – hide or remove |

## 8. Security

A sheet that maps users (e-mail) to a region, department or customer is a **row-level security** table,
not report data. Propose a role: the mapping table stays in the model (hidden), related to the dimension
it secures, with a role filter such as
`[Region] = LOOKUPVALUE ( security[Region], security[UserEmail], USERPRINCIPALNAME () )` on that
dimension. Test it in Desktop with *View as role*. Never drop such a sheet silently – ask.

## 9. Review checklist (step 4b, and again before the build)

- [ ] Every fact has one stated grain; no fact relates to another fact.
- [ ] No lookup chains left (or a stated reason for each).
- [ ] Every dimension has one row per member and a unique key.
- [ ] Test/placeholder rows and copies removed or explicitly kept.
- [ ] Flags and codes have readable names.
- [ ] One active path between any two tables; all relationships single direction.
- [ ] One marked date table; auto date/time off.
- [ ] Staging queries not loaded; source path is a parameter.
- [ ] Personal data hidden or removed; security sheet handled as a role.
