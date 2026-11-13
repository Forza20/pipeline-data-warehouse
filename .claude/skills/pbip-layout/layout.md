# Layout: the AdventureWorks report template

The template is a real report – `adventureworks_report.pbix`, saved as PBIP in Power BI Desktop – taken
apart by `scripts/extract-template.js` into [templates/adventureworks/](templates/adventureworks/):
every page, visual, bookmark and navigation icon, with every colour replaced by a colour key
([colors.md](colors.md)). `scripts/gen-report.js` builds the pages the user chooses into a report and
connects them to the project's own model. Pages are **1280 × 720**; numbers keep the template's formats
and display units (K, M). The logo becomes the report title, or the user's own logo.

## Pages (the user always chooses which)

| Key | Page | What it shows | Needs in the model |
|---|---|---|---|
| `exec` | Exec Dashboard | 4 KPI tiles, revenue trend (trend line, forecast, anomalies), orders by category, top products (orders, revenue, rate), 3 monthly KPIs against last month, 2 "top" tiles, a slicer panel (filter icon, bookmarks) | revenue, orders, profit, a rate, a third count; date; category, subcategory, product; region/country for the slicer panel |
| `map` | Map | orders per country on a map, continent slicer | a geography column (country/city) and a region column |
| `product` | Product Detail | **drillthrough** from a product: 3 gauges against targets, profit trend with a price adjustment (what-if), a trend whose measure the user picks (field parameter), a summary text | product; targets (or last month + growth); a price adjustment parameter; a product metric field parameter |
| `customer` | Customer Detail | customer KPIs, customer trend with a metric choice (field parameter), orders by two customer attributes (donuts), top 100 customers, the top customer, an insight button (bookmarks) | customer id and name, two customer attributes, customers measure, revenue per customer; a customer metric field parameter |
| `tooltip` | Category Tooltip | hidden tooltip page on the category bars: KPI list and weekly orders | the exec measures; a week start date column. Without it the bars show the normal tooltip |
| `qna` | Q&A | the Q&A visual (natural-language questions) and orders by category and an attribute | category, a product attribute |
| `decomp` | Decomposition Tree | orders broken down by category → subcategory → product, and an orders card | category, subcategory, product |
| `influencers` | Key Influencers | what drives a customer attribute; what drives an average price | a customer attribute to explain and attributes that explain it; a product number column |

Navigation: the dark rail on the left has a button per page (Exec, Map, Product, Customer). A page the
user leaves out loses its button on every page and the buttons below close up. Product Detail is reached
by its button or by drillthrough on a product.

## Template fields → the model

`config.json → fields` maps every field the chosen pages use (template.json → `fields`, each with the
pages that use it) to `Table[Field]` in the model, or `null` when the model has nothing that fits:
`null` leaves the field out of a visual that has more fields (Key Influencers' explain-by list), and leaves
out a visual that needs it (a map without a location). The generator lists each missing mapping and
every visual it left out. Choose in this order: the expected content, then the fallback.

### Measures

| Template field | Expected | Fallback / how to make it |
|---|---|---|
| `Measure Table[Total Revenue]` | revenue | — (required) |
| `Measure Table[Total Orders]` | number of orders (distinct order ids) | number of rows / transactions |
| `Measure Table[Total Profit]` | profit, gross margin | revenue after discount |
| `Measure Table[Return Rate]` | a rate where **high is bad** (returns, churn, cancellations) | margin % – then change the texts (`Most Returned Product Type:` …) and the table's colour scale reads "low = red" (template: high = red) |
| `Measure Table[Total Returns]` | returns, complaints | customers (then: `Monthly Returns` → `Monthly Customers`) |
| `Measure Table[Total Customers]` | distinct customers with an order | — (customer page) |
| `Measure Table[Previous Month Revenue/Orders/Returns]` | the measure one month back | create – measures.md "Previous month" |
| `Measure Table[Revenue Target]`, `[Order Target]`, `[Profit Target]` | targets from the model (a target table) | last month × (1 + growth) – measures.md "Targets"; ask the user for the growth (template: 10 %) |
| `Measure Table[… Target Gap]` | measure − target | create – measures.md |
| `Measure Table[Adjusted Profit]` | profit with the price adjustment | create – measures.md "Price adjustment" |
| `Measure Table[Average Revenue per Customer]` | revenue ÷ customers | create |
| `Measure Table[Average Retail Price]` | average price of a product | average order value, average list price |

### Columns

| Template field | Expected | Fallback |
|---|---|---|
| `Calendar Lookup[Date]`, `[Year]`, `[Month]`, `[Start of Month]`, `[Start of Week]` | the date table's date, year, month name, month start, week start | — (pipeline-power-bi's date table has all of them) |
| `Calendar Lookup[Date Hierarchy.Year/Start of Month/Start of Week/Date]` | the template's drill-down levels → the plain columns above | — |
| `Calendar Lookup[Start of Quarter]` | quarter start (only in the slicer panel's bookmarks) | `null` |
| `Product Categories Lookup[CategoryName]`, `Product Subcategories Lookup[SubcategoryName]`, `Product Lookup[ProductName]` | category, subcategory, product | segment / channel / customer for a model without products |
| `Product Lookup[ProductColor]` | a product attribute (Q&A table) | brand, size |
| `Product Lookup[ProductCost]` | a number per product (Key Influencers) | list price |
| `Territory Lookup[Country]` | a location the map can place | city; `null` leaves the map out |
| `Territory Lookup[Continent]` | the region above it | region, country |
| `Customer Lookup[CustomerKey]`, `[Full Name]` | customer id and name | — (customer page) |
| `Customer Lookup[Income Level]`, `[Occupation]` | two customer attributes (donuts) | segment, region, payment terms |
| `Customer Lookup[HomeOwner]` | the customer attribute Key Influencers explains | segment, payment terms |
| `Customer Lookup[AnnualIncome]`, `[EducationLevel]`, `[Is Parent?]`, `[MaritalStatus]` | attributes that may explain it | other customer columns; `null` leaves one out |
| `Price Adjustment (%)[Price Adjustment (%)]` | the what-if parameter | create – measures.md "Price adjustment" |
| `Product Metric Selection[…]`, `Customer Metric Selection[…]` (and `… Fields`) | field parameters (the user picks a measure) | create – measures.md "Field parameters" |

Names on the page: `labels` sets the name shown for a field (default: the model's name made readable,
`total_sales` → `Total sales`). `texts` replaces the template's titles and text boxes – template.json →
`pages[].texts` lists them exactly (`Most Returned Product Type:` with its colon). Change a text whenever a
fallback changes the meaning.

## What the generator changes, and what it keeps

- Only the chosen pages (new page ids), their bookmarks and their icons are written; the report's own
  pages stay. Pages from an earlier run (and the old single-page layout) are replaced.
- The report's base theme becomes the template's (`CY23SU04`), and a colour theme
  (`pbip-layout-theme.json`, colours only) is registered, so default series colours match the template.
- Data of the source report is not carried over: selected slicer values, the drillthrough product,
  per-value formatting and a text quoting a customer were removed when the template was made, or are
  cleared by the generator.
- The smart narrative ("Report Summary") keeps only its first sentence ("Total orders for <product>
  were <orders>"); the AI trend sentences belonged to the source data.
