# Layout: Sales overview (dark-tile executive)

Recreated from an AdventureWorks template. One page, 1920 × 1080, white background.
All numbers are shown as **whole numbers** (no K/M units).

## Colours and typography
| Role | Colour |
|---|---|
| Navigation bar, KPI tiles, highlight tiles | `#333333` |
| KPI values | `#1FC8C0` (teal), Segoe UI Bold |
| Lines, bars, text | `#252423` |
| Secondary text | `#605E5C` |
| Borders on cards/charts | `#C8C6C4`, radius 8 (KPI tiles radius 16) |
| Sparkline fill | `#E1DFDD` |
| Table gradient (low → high) | `#E36C78` → `#FDEDEF`; swapped with `table.gradientHigherIsWorse: true` for rates where high is bad (return rate, churn) |
| Decrease on monthly cards | `#D64550` (through a colour measure) |

## Positions (x, y, width, height)
| # | Element | Visual | Position | Content |
|---|---|---|---|---|
| 1 | Navigation bar | shape | 0, 0, 80, 1080 | dark background |
| 2 | Back button | actionButton | 8, 16, 64, 44 | icon "back" |
| 3 | Page buttons (≤3) | actionButton | 8, bottom, 64, 44 | navigation to the other pages |
| 4 | Title | textbox | 104, 52, 256, 96 | title + subtitle |
| 5–8 | KPI tiles | cardVisual | y 20, h 148; 1–4 tiles spread evenly over x 376–1904 with 24 px gaps (4 tiles: w 364, x 376 / 764 / 1152 / 1540) | 1–4 headline KPIs, label under the value |
| 9 | Trend | lineChart | 96, 200, 952, 548 | main measure per month, continuous axis, trend line, forecast, zoom slider |
| 10–12 | Monthly cards | areaChart + 2 × cardVisual | y 772, h 284, w 300; x 96 / 422 / 748 | sparkline, latest month (colour by up/down), "Previous month: X (±Y%)" |
| 13 | Bars per category | clusteredBarChart | 1072, 200, 832, 320 | measure per category, sorted descending, blanks hidden |
| 14 | Top-10 table | tableEx | 1072, 544, 832, 340 | row + 3 measures, data bars, red gradient on the % column, TopN 10 |
| 15–16 | Highlights | textbox + cardVisual | header y 904 h 32; tile y 944 h 112; w 404; x 1072 / 1500 | text measures (e.g. top category, top channel) |

The positions above apply with all sections. With `sections` in the config (profile.md), monthly cards
(0–3), highlights (0–2), bar chart and table can be left out; what remains is spread over the same area:
monthly cards and highlights fill their row, bars or table alone get the whole right column, without
highlights the right column reaches y 1056, without monthly cards the trend reaches y 1056, and without both
bars and table the trend becomes 1808 px wide.

## Slots to connect to the model
| Slot | Expected content | Fallback if the model lacks it |
|---|---|---|
| KPI 1 | Revenue | — (required) |
| KPI 2 | Number of orders | number of rows / transactions |
| KPI 3 | Earnings / profit | revenue after discount, average order value |
| KPI 4 | Rate in % (margin, return rate) | margin %, share of active customers |
| Trend | Revenue per month | — |
| Monthly card 1–3 | Revenue, orders, a third key figure (returns/customers) | active customers |
| Bars | Orders per product category | revenue per category / segment |
| Table | Top 10 products: orders, revenue, % key figure | top 10 customers |
| Highlight 1–2 | Category/segment with the most orders; the second most important "top" text | top channel, top region |

KPI 1–4 is the proposal. With a user present, the user chooses 1–4 KPIs and their text (SKILL.md step 4);
the tiles are then spread evenly across the row.
