# Colours on the dashboard page

All colours are set in `colors` in config.json (hex, `#RRGGBB`). Missing keys get the default value, so an
older config without `colors` gives exactly the same page as before.

| Key | Used for | Default |
|---|---|---|
| `page` | page background | `#FFFFFF` |
| `panel` | background of chart, card and table boxes | `#FFFFFF` |
| `border` | border around the boxes | `#C8C6C4` |
| `ink` | titles, numbers in tables, trend and bar colour | `#252423` |
| `sub` | subtitle, axes, data labels | `#605E5C` |
| `dark` | navigation bar and KPI/highlight tiles | `#333333` |
| `onDark` | text and icons on `dark` | `#FFFFFF` |
| `teal` | the numbers on the KPI and highlight tiles (accent) | `#1FC8C0` |
| `navBtn` / `navHover` | buttons in the navigation bar / on hover | `#4A4A4A` / `#5C5C5C` |
| `spark` | the area of the monthly cards' sparkline | `#E1DFDD` |
| `bar` | data bars in the table | `#C8C6C4` |
| `grid` | grid lines in the trend chart | `#E1DFDD` |
| `trendLine` | dashed trend line | `#A19F9D` |
| `band` | the forecast band | `#C8C6C4` |
| `gradLow` / `gradHigh` | colour scale in the table's last column (low → high) | `#E36C78` / `#FDEDEF` |
| `negative` / `axis` | negative data bars / the data bar axis | `#D64550` / `#999999` |
| `white` | older key: default for `page`, `panel` and `onDark` | `#FFFFFF` |

Not controlled by `colors`: the green/red of the monthly cards comes from `_cm_color` measures (measures.md).

**The rest of the report:** with `colors`, the generator also registers a Power BI theme
(`pbip-layout-theme.json`) with the same colours: page background (`page`), box background and border
(`panel`, `border`), text (`ink`, `sub`) and data series (`teal`, `dark`, `gradLow` …). The other report pages
then look like the dashboard. `"theme": false` switches it off; without `colors` an earlier theme is removed.

## Variants

The variants change colours only. The placement is the same (layout.md).

**1. Standard** – light page, dark tiles. No `colors` (or an empty object).

**2. Dark**
```json
"colors": { "page": "#1E1E24", "panel": "#2A2A33", "border": "#3A3A45", "ink": "#F2F2F5", "sub": "#A8A8B3",
  "dark": "#111116", "onDark": "#FFFFFF", "teal": "#1FC8C0", "navBtn": "#2A2A33", "navHover": "#3A3A45",
  "spark": "#3A3A45", "bar": "#4A4A57", "grid": "#3A3A45", "trendLine": "#8A8A96", "band": "#4A4A57",
  "gradLow": "#E36C78", "gradHigh": "#2A2A33", "axis": "#77777F" }
```

**3. Brand** – standard, but with the user's colours: `dark` = primary colour, `teal` = accent colour,
`navBtn` = a lighter shade of the primary colour, `bar`/`spark` = a light shade of the accent colour.

## From a screenshot

`scripts/palette.ps1 -Path <image>` (Windows PowerShell, no extra modules) scales the image down, counts the
colours and proposes the keys:

| Key | Taken from |
|---|---|
| `page` | the largest area in the image (the background) |
| `panel` | light site: white; dark site: the second largest dark, neutral area |
| `ink` | the neutral colour with the most contrast to `panel`, made darker/lighter to contrast ≥ 7 |
| `teal` (accent) | the most used saturated colour (buttons, links); none → Standard's teal |
| `dark` | a dark brand colour (header, footer); none → `#333333` (light site) or a darker `page` |
| others (`sub`, `border`, `navBtn`, `spark`, `bar` …) | mixed from the four above |

The accent colour must be readable as numbers on the dark tiles (contrast ≥ 4.5). If it is too dark, it is
made lighter – `accentFromImage` shows the original, `accentAdjusted` whether it was changed. `contrastOk` is
`true` when every text pair passes. A screenshot with large photos can give a skewed background (the script
then reports `siteIsDark: true` for a light site): use a crop with the site's header, buttons and text, or
build an adjusted palette – a light `page`/`panel`, a dark `ink`, the brand's dark colour as `dark` and its
button colour as `teal` – and check the contrast.

## Contrast

Check before you build that text is readable: contrast ratio at least 4.5 for `ink` and `sub` on
`panel`/`page`, and for `teal` and `onDark` on `dark`. If a brand colour is too light for `dark`, use it as
`teal` (accent) instead and keep a dark `dark`.
