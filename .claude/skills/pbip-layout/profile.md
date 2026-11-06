# Report profile

A profile saves the user's choices, so they do not have to be made again on every run: colours, theme, KPIs,
sections and title. The skill uses the profile instead of asking (steps 3 and 4), and a pipeline agent can
use it even though it cannot ask. Example: [profile.example.json](profile.example.json).

```json
{
  "name": "my-style",
  "colors": { "dark": "#0B3D5C", "teal": "#F2A900", "navBtn": "#1C5A80" },
  "theme": true,
  "kpis": [
    { "slot": "KPI 1", "label": "Revenue" },
    { "measure": "Average order value" },
    { "slot": "KPI 4" }
  ],
  "sections": { "monthly": 2, "highlights": 1, "bar": true, "table": true },
  "title": "Sales overview",
  "subtitle": "Latest complete month"
}
```

| Field | Meaning | If left out |
|---|---|---|
| `colors` | colours, keys as in [colors.md](colors.md) | *Standard* |
| `theme` | the same colours on every report page (theme in `StaticResources/RegisteredResources`) | `true` when `colors` is set |
| `kpis` | 1–4 KPIs in order. `slot` = the proposal from layout.md (`KPI 1`–`KPI 4`); `measure` = the name of a measure in the model (case does not matter); `label` = text under the number | the proposal KPI 1–4 |
| `sections.monthly` | number of monthly cards, 0–3 | 3 |
| `sections.highlights` | number of highlight tiles, 0–2 | 2 |
| `sections.bar` / `sections.table` | bar chart / top table shown or not | `true` |
| `title` / `subtitle` | the page's title and subtitle | the layout's |

How the fields are used:
- `colors`, `theme`, `sections`, `title` and `subtitle` are copied unchanged to config.json.
- `kpis` is translated to the config format: `slot` → the measure the mapping (step 4) found for the slot;
  `measure` → `Table[Measure]` from the model. If a named measure does not exist, use the proposal for the same
  number, and write it under "Open points" (pipeline) or ask (with a user).
- The profile never changes the placement of what is shown – only what is shown and in which colours.
- What is left out is redistributed: fewer KPIs, monthly cards or highlights fill the row; without the bar
  chart or the table the other gets the whole right column; without both the trend becomes wide.
