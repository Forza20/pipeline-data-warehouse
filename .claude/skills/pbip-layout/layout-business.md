# Layout: the Business template (Marketing, Sales, Finance)

The template is the *Power BI Dashboard Template Library – Marketing, Sales, Finance* (PBIP, 7 pages), taken
apart by `scripts/extract-template.js --keys business` into [templates/business/](templates/business/). One
report on one model: a shared **Home** and three self-contained **modules**, each with an overview and a
drillthrough page. The user chooses the modules; a module left out is gone completely (pages, buttons, Home
card and tile) and the rest moves together. Pages are **1280 × 720** with the same five bands: navigation
on the left, header with a date slicer, 4 KPI cards, analysis band (trend 60 % + composition 40 %), detail
band (focus visual 40 % + ranked table 60 % with drillthrough).

## Pages and modules (the user always chooses)

| Key | Page | Module | Shows | Needs in the model (data contract) |
|---|---|---|---|---|
| `home` | Home | shared | one headline KPI per module + Marketing CAC (needs Marketing and Sales), revenue vs operating expenses (Finance), a tile per module with a button | date + at least one module |
| `marketing` | Marketing | Marketing | MQLs, MQL→SQL rate, CPL, Marketing ROI %; MQLs vs prior year, leads by channel, content types, top campaigns | leads, MQLs, SQLs, spend (+ conversions, attributed revenue, channel, campaign, content type) |
| `campaign` | Campaign Detail | Marketing | **drillthrough** from a campaign: KPI strip, funnel Leads → MQLs → SQLs → Conversions, spend vs revenue, channel and content | campaign name; the funnel stages are made by `gen-measures.js` |
| `sales` | Sales | Sales | closed-won revenue, win rate, new customers, sales cycle; revenue vs prior year, by category and quarter, quota attainment per rep, recent deals | amount and stage per opportunity (+ customer, new-customer flag, cycle days, rep, quota, category) |
| `opportunity` | Opportunity Detail | Sales | **drillthrough** from a rep or customer: open pipeline, win rate, average deal size and age, pipeline by stage, age buckets, deal list | rep, customer name (+ pipeline stage, age, age bucket) |
| `finance` | Finance | Finance | revenue, net profit margin %, operating expenses, operating cash flow; revenue vs costs, margin by quarter, expenses by category, recent entries | amount per ledger entry and account type (Revenue, COGS, OpEx, Other) (+ status, cash movement, expense category) |
| `pnl` | P&L Detail | Finance | **drillthrough** from an expense category: KPI strip, P&L matrix (accounts × month), the entries | account name, expense category |

Rules (the generator enforces them):
- A module is chosen when one of its pages is. A drillthrough page needs its overview (`campaign` →
  `marketing`, `opportunity` → `sales`, `pnl` → `finance`). Home alone is refused.
- Fields of a module left out need no mapping: they are left out by themselves (`leftOutByModule`), and with
  them the module's Home card, tile and navigation button. Home's cards and tiles spread over the row again;
  without Finance the tiles move up where the revenue line was. The Home subtitle names the chosen modules
  ([templates/business/modules.json](templates/business/modules.json)).
- Recommend only a module the model has data for (the required columns below). Home is always recommended
  when at least one module is chosen.

## Data contract → measures (instead of mapping 86 fields by hand)

The template's 100 measures (`templates/business/measures/*.tmdl`: KPI, PY, YoY %, YoY pp for rates, YoY
Status and YoY Colour) rest on about 40 contract columns
([templates/business/contract.json](templates/business/contract.json)). Map the **columns**, and
`gen-measures.js` makes the measures and the fields:

1. `suggest-fields.js "<.SemanticModel>" --config <config.json>` (config with `template: "business"` and
   `pages`) proposes `config.contract` from names and writes `how` per column (`name`, `none`, `none –
   derive: …`) and `requiredMissing`.
2. Check the mapping column by column – meaning, unit and **values**. Measures compare with fixed texts:
   `Fact_Opportunity[Stage]` = `Closed Won` / `Closed Lost` / `Open`, `Dim_Account[AccountType]` = `Revenue` /
   `COGS` / `OpEx` / `Other`, `Fact_Finance[Status]` = `Reversed` (left out). When the model spells them
   differently: `config.values` (`{ "Fact_Opportunity[Stage]": { "Closed Won": "Won" } }`). Query the distinct
   values before you guess.
3. `gen-measures.js <config.json> --write-config` and
   - a pipeline-power-bi run: `--spec runs/<run-id>/choices.json` → `build.measures[]` (snake_case:
     `closed_won_revenue_yoy_pct`, folders `Marketing`/`Sales`/`Finance`/`Home`, a filter contract on the PY
     measures) and the funnel stages as `build.parameters[]` (`kind: "list"`); then run `rebuild.js`;
   - other projects (Desktop closed): `--tmdl "<.SemanticModel>"` → the table `_layout_measures` (+
     `Funnel stage`) with the template's names.
   A measure is made only when all its columns are mapped and every measure it uses is made; the rest is in
   `skipped` with the reason, and its fields become `null` (visuals left out). A name the model already has
   gets the module in front (`finance_revenue`).
4. `currencyFormat` sets the amount format (template: `\$#,0`), e.g. `#,0 "kr."`.

### Required per module

| Module | Required | Otherwise empty / left out |
|---|---|---|
| shared | `Dim_Date[Date]` (marked date table, whole years – PY uses `SAMEPERIODLASTYEAR`) | `[Year]` (filter contract), `[MonthLabel]` → the month-start column (`dim_date[month_start]`), `[Month]`, `[Quarter]` |
| Marketing | – (each KPI on its own) | without `Spend`: CPL, ROI %, CAC; without `AttributedRevenue`: ROI % |
| Sales | `Fact_Opportunity[Amount]`, `[Stage]` | without `IsNewCustomer`: new customers and Marketing CAC; without `CycleDays`/`AgeDays`: cycle/age; without `Fact_SalesTarget[Quota]`: the quota bars |
| Finance | `Fact_Finance[Amount]` (positive amounts), `Dim_Account[AccountType]` | without `Status`: reversed entries count – a decision |

`derive` in contract.json says how to make a missing column (cycle days = close date − created date, new
customer = the customer's first won deal, age buckets 0–30/31–60/61–90/90+). In a pipeline-power-bi run
that is a cleaning step or a column in the build spec – a **decision** (SKILL.md step 7): make the column
(recommended when the source has the parts) or leave the KPI out.

### Decisions that typically come up
- A status column with other values than `Closed Won/Closed Lost/Open` (e.g. `Paid`/`Cancelled`): which
  value is "won"? Recommend from the distinct values and their amounts.
- Costs stored as negative numbers: the template expects positive amounts and lets the account type give
  the sign – flip the sign in Power Query (recommended); otherwise cost KPIs and net profit are wrong.
- A retail model without opportunities: Sales can use orders (amount, a status as "won"), but win rate and
  pipeline lose their meaning – recommend leaving `opportunity` out, or set `texts`.

## Colours (business)

| Key | Used for | Template |
|---|---|---|
| `primary` | KPI card 1, current series, headings, the buttons on Home | `#1B2A4A` |
| `secondary` | KPI card 2, second series, theme accent | `#1A7F7C` |
| `tertiary` | KPI card 3, third series | `#5F6F86` |
| `highlight` | KPI card 4, fourth series, selected state | `#7FB3D9` |
| `prior` | prior-year lines and bars | `#A9B4C6` |
| `sidebar` | the navigation rail | `#12212B` |
| `navActive` | the active page's button | `#24475C` |
| `ink` | dark text on the light KPI card | `#12212B` |
| `subtle` | subtitles | `#475569` |
| `canvas` | page background | `#F2F5F8` |
| `panel` | card and chart backgrounds | `#FFFFFF` |
| `onDark` | text on dark and coloured backgrounds | `#FFFFFF` |
| `line` | borders | `#D5DCE6` |

**Good / bad / neutral (`#197A4C` / `#C0392B` / `#6B7280`) are fixed** – they live in the `… YoY Colour`
measures and the theme and never change with a colour choice. The theme is the template's own (fonts, text
classes, grid lines, table headers) with the colour keys filled in. From `palette.ps1`: `dark` →
`primary`/`sidebar`, `teal` → `secondary`, `gold` → `tertiary`.

## Fixes to the draft
`extract-template.js` fixes two errors in the source report (`powerbi-report-author validate`): the
drillthrough filters were marked `Drill` instead of `Drillthrough` (drillthrough did not work), and the text
boxes were too low for their font size (padding top/bottom 0). The report's year filter (`Year = 2024`,
sample data) is not carried over.

## config.json (example)
[config.example-business.json](config.example-business.json).
