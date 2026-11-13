# Colours

Every colour on the template's pages is a colour key (template.json → `colors`). `colors` in config.json
sets them (hex, `#RRGGBB`); a key that is left out keeps the template's colour, so without `colors` the
pages look exactly like the source report (*Standard*). `colors` changes colour values only: pages,
visuals, positions, sizes, fields, fonts, number formats, texts and bookmarks are the same for every
variant (`tests/colors-only.test.js`). An unknown key or a value that is not `#RRGGBB` stops the generator.

| Key | Used for | Template |
|---|---|---|
| `dark` | navigation rail, KPI and highlight tiles, shapes, chart series, tooltip background | `#333333` |
| `teal` | accent: KPI values, data labels, active navigation icons, highlights | `#20E2D7` |
| `onDark` | text and icons on `dark` | `#FFFFFF` |
| `panel` | light backgrounds, the low end of colour scales | `#FFFFFF` |
| `muted` | secondary titles | `#666666` |
| `soft` | slicer item background | `#E6E6E6` |
| `bar` | data bars in tables | `#CCCCCC` |
| `axis` | data bar axis; the theme's text colour | `#252423` |
| `bad` | decrease, high return rate (red = worse) | `#DE6A73` |
| `badDark` | the returns series | `#A1343C` |
| `gold` | second series colour (donuts) | `#E1C233` |

The navigation icons are recoloured with the keys too (white ones = `onDark`, accent ones = `teal`). The
theme `pbip-layout-theme.json` holds colours only: its series colours start with `dark`, `gold`, `teal`,
`bad`, so charts without their own colour follow the choice. `"theme": false` leaves the theme out.

## Variants (colours only)

**1. Standard** – the template as it is. No `colors`.

**2. Dark**
```json
"colors": { "dark": "#111116", "muted": "#A8A8B3", "teal": "#1FC8C0", "onDark": "#F2F2F5", "panel": "#2A2A33",
  "soft": "#3A3A45", "bar": "#4A4A57", "axis": "#F2F2F5" }
```

**3. Brand** – the user's colours: `dark` = primary colour, `teal` = accent colour, `gold` = a second
brand colour. Keep `bad` red unless the brand says otherwise: it means "worse".

## From hex codes

Map the user's codes to the keys: the darkest brand colour → `dark`, the most visible brand colour →
`teal`, a second one → `gold`; text and background only when the user asks for a dark or tinted page.

## From a screenshot

`scripts/palette.ps1 -Path <image>` (Windows PowerShell, no extra modules) scales the image down, counts
the colours and suggests every key (`suggestion`):

| Key | Taken from |
|---|---|
| `panel` | light image: white; dark image: the second largest dark, neutral area |
| `axis` | the neutral colour with the most contrast to `panel`, made darker/lighter to contrast ≥ 7 |
| `teal` | the most used saturated colour (buttons, links); none → `#1FC8C0` |
| `dark` | a dark brand colour (header, footer); none → `#333333` |
| `gold` | a second saturated colour of another hue (not red); none → the template's |
| `muted`, `soft`, `bar` | mixed from the above; `bad`, `badDark` stay red |

The accent colour must be readable as numbers on the dark tiles (contrast ≥ 4.5); if it is too dark it is
made lighter – `accentFromImage` shows the original, `accentAdjusted` whether it changed. `contrastOk` is
`true` when every text pair passes. A screenshot with large photos can skew the background
(`siteIsDark: true` for a light site): use a crop with the header, buttons and text.

## Contrast

Check before you build: `onDark` and `teal` on `dark` at least 4.5; `axis` and `muted` on `panel` at least
4.5. If a brand colour is too light for `dark`, use it as `teal` and keep a dark `dark`.
